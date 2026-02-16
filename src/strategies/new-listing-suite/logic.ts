/**
 * New listing strategy logic.
 *
 * Notes:
 * - Keeps strategy state internal and serializable.
 * - Emits release + checkpoint notifications once per tracker.
 */
import type { Kline1h, StrategyContext, StrategyTrackedSetup } from "../../core/domain/types.js";

const WATCH_WINDOW_HOURS = 21 * 24;
const HOLD_HOURS = 14 * 24;
const DISCOVERY_MAX_AGE_HOURS = 12;
const TURNOVER_1H_MIN = 1_000_000;
const MAX_PUMP_AVOID = 0.5;
const S7_PUMP_MIN = 0.15;
const LEG2_RET_8H_MAX = -0.1;
const CLOSED_RETENTION_HOURS = 24;

type ListingStrategy = "RED4H_HIVOL" | "S7_PUMPDUMP";
type ListingPhase = "WATCHING" | "READY_LEG1" | "READY_LEG2" | "READY_S7" | "CLOSED" | "DISQUALIFIED";
type ListingEventType =
  | "LISTING_RELEASED"
  | "CHECKPOINT_4H_LEG1_READY"
  | "CHECKPOINT_4H_WATCH_S7"
  | "CHECKPOINT_8H_LEG2_READY"
  | "CHECKPOINT_8H_S7_READY"
  | "FORCED_CLOSE_14D";

interface ListingTracker {
  symbol: string;
  strategy: ListingStrategy;
  launchTimeMs: number;
  phase: ListingPhase;
  listingPrice: number | null;
  lastPrice: number | null;
  checkpoint4hPrice: number | null;
  checkpoint8hPrice: number | null;
  transitionedAtMs: number;
  closedAtMs: number | null;
  disqualifiedReason: string | null;
  checkpoint4hProcessed: boolean;
  checkpoint8hProcessed: boolean;
  hasReadySignal: boolean;
}

export interface NewListingInternalSignal {
  strategyId: string;
  strategyName: string;
  symbol: string;
  phase: ListingPhase;
  score: number;
  data: Record<string, unknown>;
}

const trackers: Record<string, ListingTracker> = {};

function pct(base: number, value: number): number | null {
  // Safe percent-change helper with invalid-base guard.
  if (!Number.isFinite(base) || base <= 0) return null;
  return (value - base) / base;
}

function closeByHour(candles: Kline1h[], launchTimeMs: number, hour: number): number | null {
  // Return last close strictly before checkpoint boundary.
  const boundary = launchTimeMs + hour * 60 * 60 * 1000;
  const rows = candles.filter((candle) => candle.openTimeMs < boundary);
  if (rows.length === 0) return null;
  return rows[rows.length - 1]?.close ?? null;
}

function maxHighByHour(candles: Kline1h[], launchTimeMs: number, hour: number): number | null {
  // Return max high observed strictly before checkpoint boundary.
  const boundary = launchTimeMs + hour * 60 * 60 * 1000;
  const rows = candles.filter((candle) => candle.openTimeMs < boundary);
  if (rows.length === 0) return null;
  let max = rows[0].high;
  for (const row of rows) {
    if (row.high > max) max = row.high;
  }
  return max;
}

function resolveDefaultStrategy(hoursSince: number): ListingStrategy {
  return hoursSince < 8 ? "RED4H_HIVOL" : "S7_PUMPDUMP";
}

function resolveStrategyId(strategy: ListingStrategy): string {
  if (strategy === "RED4H_HIVOL") return "bybit:new-listing:red4h-hivol:v2";
  return "bybit:new-listing:s7-pumpdump:v2";
}

function resolveStrategyName(strategy: ListingStrategy): string {
  if (strategy === "RED4H_HIVOL") return "New Listing Red4h+HiVol";
  return "New Listing S7 PumpDump";
}

function resolveSignalEventDetail4h(input: { ret4h: number | null; turnover1h: number; pump4h: number | null }): string {
  if (input.ret4h === null) return "4h close unavailable; defaulting to S7 watch path.";
  if (input.turnover1h < TURNOVER_1H_MIN) {
    return `turnover_1h ${(input.turnover1h / 1_000_000).toFixed(2)}M is below 1.00M minimum for LEG1.`;
  }
  if (input.ret4h >= 0) return `ret_4h ${(input.ret4h * 100).toFixed(2)}% is not negative for LEG1.`;
  if (input.pump4h !== null && input.pump4h > MAX_PUMP_AVOID) {
    return `max_pump_4h ${(input.pump4h * 100).toFixed(2)}% exceeds 50.00% avoidance threshold.`;
  }
  return "LEG1 conditions not met; continue with S7 watch path.";
}

function getOrCreateTracker(
  symbol: string,
  strategy: ListingStrategy,
  launchTimeMs: number,
  nowMs: number
): { tracker: ListingTracker; created: boolean } {
  // Reuse existing tracker or initialize WATCHING state.
  const existing = trackers[symbol];
  if (existing) return { tracker: existing, created: false };
  const created: ListingTracker = {
    symbol,
    strategy,
    launchTimeMs,
    phase: "WATCHING",
    listingPrice: null,
    lastPrice: null,
    checkpoint4hPrice: null,
    checkpoint8hPrice: null,
    transitionedAtMs: nowMs,
    closedAtMs: null,
    disqualifiedReason: null,
    checkpoint4hProcessed: false,
    checkpoint8hProcessed: false,
    hasReadySignal: false,
  };
  trackers[symbol] = created;
  return { tracker: created, created: true };
}

function transition(tracker: ListingTracker, phase: ListingPhase, nowMs: number, reason: string | null): boolean {
  // Avoid duplicate transitions/signals for same phase.
  if (tracker.phase === phase) return false;
  tracker.phase = phase;
  tracker.transitionedAtMs = nowMs;
  tracker.disqualifiedReason = reason;
  tracker.closedAtMs = phase === "CLOSED" ? nowMs : null;
  if (phase === "READY_LEG1" || phase === "READY_LEG2" || phase === "READY_S7") {
    tracker.hasReadySignal = true;
  }
  return true;
}

function cleanup(nowMs: number): void {
  // Drop DISQUALIFIED immediately; retain CLOSED for visibility window.
  const retentionMs = CLOSED_RETENTION_HOURS * 60 * 60 * 1000;
  for (const [symbol, tracker] of Object.entries(trackers)) {
    if (tracker.phase === "DISQUALIFIED") {
      delete trackers[symbol];
      continue;
    }
    if (
      tracker.phase === "WATCHING" &&
      tracker.strategy === "S7_PUMPDUMP" &&
      tracker.checkpoint8hProcessed &&
      !tracker.hasReadySignal
    ) {
      // Legacy/stale S7 watch rows that reached 8h without qualifying should not remain active.
      delete trackers[symbol];
      continue;
    }
    if (tracker.phase === "CLOSED" && tracker.closedAtMs !== null && nowMs - tracker.closedAtMs > retentionMs) {
      delete trackers[symbol];
    }
  }
}

function scoreForPhase(phase: ListingPhase): number {
  if (phase === "READY_LEG1" || phase === "READY_LEG2" || phase === "READY_S7") return 100;
  if (phase === "CLOSED") return 90;
  if (phase === "WATCHING") return 40;
  return 20;
}

function buildSignal(input: {
  tracker: ListingTracker;
  hoursSince: number;
  listingPrice: number;
  turnover1h: number;
  ret4h: number | null;
  ret8h: number | null;
  pump4h: number | null;
  pump8h: number | null;
  eventType: ListingEventType;
  eventDetail?: string;
}): NewListingInternalSignal {
  return {
    strategyId: resolveStrategyId(input.tracker.strategy),
    strategyName: resolveStrategyName(input.tracker.strategy),
    symbol: input.tracker.symbol,
    phase: input.tracker.phase,
    score: scoreForPhase(input.tracker.phase),
    data: {
      launchTimeMs: input.tracker.launchTimeMs,
      hoursSince: input.hoursSince,
      listingPrice: input.listingPrice,
      turnover1h: input.turnover1h,
      ret4h: input.ret4h,
      ret8h: input.ret8h,
      pump4h: input.pump4h,
      pump8h: input.pump8h,
      disqualifiedReason: input.tracker.disqualifiedReason,
      checkpoint4hProcessed: input.tracker.checkpoint4hProcessed,
      checkpoint8hProcessed: input.tracker.checkpoint8hProcessed,
      eventType: input.eventType,
      eventDetail: input.eventDetail ?? null,
    },
  };
}

export async function evaluateNewListingSignals(context: StrategyContext): Promise<NewListingInternalSignal[]> {
  const out: NewListingInternalSignal[] = [];
  const tickerPriceBySymbol = new Map(context.tickers.map((ticker) => [ticker.symbol, ticker.lastPrice]));

  for (const instrument of context.instruments) {
    // Process only listing candidates that have launch time and are trading.
    if (!instrument.launchTimeMs) continue;
    if (instrument.status.toLowerCase() !== "trading") continue;
    if (instrument.symbol.includes("-")) continue;
    if (typeof instrument.contractType === "string" && instrument.contractType.toLowerCase().includes("futures")) {
      continue;
    }

    const hoursSince = (context.nowMs - instrument.launchTimeMs) / (60 * 60 * 1000);
    if (hoursSince < 0 || hoursSince > WATCH_WINDOW_HOURS) continue;
    if (!trackers[instrument.symbol] && hoursSince > DISCOVERY_MAX_AGE_HOURS) {
      // Prevent startup backfill from emitting stale historical listings.
      continue;
    }

    const candles = await context.getKlines1h(instrument.symbol, 12);
    if (candles.length === 0) {
      // Parity guard: do not keep tracking stale listings with no actionable 1h data.
      continue;
    }

    // Pull strategy inputs for this symbol.
    const defaultStrategy = resolveDefaultStrategy(hoursSince);
    const trackerState = getOrCreateTracker(
      instrument.symbol,
      defaultStrategy,
      instrument.launchTimeMs,
      context.nowMs
    );
    const tracker = trackerState.tracker;

    const discoveredListingPrice = candles[0]?.open ?? 0;
    if ((tracker.listingPrice === null || tracker.listingPrice <= 0) && discoveredListingPrice > 0) {
      tracker.listingPrice = discoveredListingPrice;
    }

    const listingPrice = tracker.listingPrice ?? discoveredListingPrice;
    const tickerPrice = tickerPriceBySymbol.get(instrument.symbol);
    const candlePrice = candles[candles.length - 1]?.close ?? null;
    tracker.lastPrice =
      typeof tickerPrice === "number" && Number.isFinite(tickerPrice) && tickerPrice > 0
        ? tickerPrice
        : typeof candlePrice === "number" && Number.isFinite(candlePrice) && candlePrice > 0
          ? candlePrice
          : null;

    const turnover1h = candles[0]?.turnover ?? 0;
    const close4h = closeByHour(candles, instrument.launchTimeMs, 4);
    const close8h = closeByHour(candles, instrument.launchTimeMs, 8);
    const maxPump4h = maxHighByHour(candles, instrument.launchTimeMs, 4);
    const maxPump8h = maxHighByHour(candles, instrument.launchTimeMs, 8);

    const ret4h = close4h !== null ? pct(listingPrice, close4h) : null;
    const ret8h = close8h !== null ? pct(listingPrice, close8h) : null;
    const pump4h = maxPump4h !== null ? pct(listingPrice, maxPump4h) : null;
    const pump8h = maxPump8h !== null ? pct(listingPrice, maxPump8h) : null;

    if (trackerState.created) {
      out.push(
        buildSignal({
          tracker,
          hoursSince,
          listingPrice,
          turnover1h,
          ret4h,
          ret8h,
          pump4h,
          pump8h,
          eventType: "LISTING_RELEASED",
        })
      );
    }

    if (hoursSince >= HOLD_HOURS) {
      // Time-based forced close at max hold horizon.
      if (transition(tracker, "CLOSED", context.nowMs, null)) {
        if (tracker.hasReadySignal) {
          out.push(
            buildSignal({
              tracker,
              hoursSince,
              listingPrice,
              turnover1h,
              ret4h,
              ret8h,
              pump4h,
              pump8h,
              eventType: "FORCED_CLOSE_14D",
            })
          );
        }
      }
      continue;
    }

    if (!tracker.checkpoint4hProcessed && hoursSince >= 4) {
      if (ret4h === null || pump4h === null) {
        // Wait until 4h checkpoint candle is available before evaluating.
        continue;
      }
      tracker.checkpoint4hPrice = close4h;

      // 4h checkpoint always emits exactly one outcome: LEG1 or continue to S7 watch path.
      const leg1Eligible =
        ret4h < 0 &&
        turnover1h >= TURNOVER_1H_MIN &&
        pump4h <= MAX_PUMP_AVOID;

      if (leg1Eligible) {
        tracker.strategy = "RED4H_HIVOL";
        tracker.disqualifiedReason = null;
        if (transition(tracker, "READY_LEG1", context.nowMs, null)) {
          out.push(
            buildSignal({
              tracker,
              hoursSince,
              listingPrice,
              turnover1h,
              ret4h,
              ret8h,
              pump4h,
              pump8h,
              eventType: "CHECKPOINT_4H_LEG1_READY",
            })
          );
        }
      } else {
        tracker.strategy = "S7_PUMPDUMP";
        tracker.disqualifiedReason = resolveSignalEventDetail4h({ ret4h, turnover1h, pump4h });
        out.push(
          buildSignal({
            tracker,
            hoursSince,
            listingPrice,
            turnover1h,
            ret4h,
            ret8h,
            pump4h,
            pump8h,
            eventType: "CHECKPOINT_4H_WATCH_S7",
            eventDetail: tracker.disqualifiedReason,
          })
        );
      }

      tracker.checkpoint4hProcessed = true;
    }

    if (!tracker.checkpoint8hProcessed && hoursSince >= 8) {
      if (ret8h === null || pump8h === null || pump4h === null) {
        // Wait until 8h checkpoint candle set is available before evaluating.
        continue;
      }
      tracker.checkpoint8hPrice = close8h;
      let qualifiedAt8h = false;

      // 8h checkpoint only emits on qualification events (LEG2 or S7).
      if (tracker.phase === "READY_LEG1" && ret8h < LEG2_RET_8H_MAX) {
        tracker.strategy = "RED4H_HIVOL";
        if (transition(tracker, "READY_LEG2", context.nowMs, null)) {
          qualifiedAt8h = true;
          out.push(
            buildSignal({
              tracker,
              hoursSince,
              listingPrice,
              turnover1h,
              ret4h,
              ret8h,
              pump4h,
              pump8h,
              eventType: "CHECKPOINT_8H_LEG2_READY",
            })
          );
        }
      } else if (
        tracker.phase !== "READY_LEG1" &&
        tracker.phase !== "READY_LEG2" &&
        pump8h <= MAX_PUMP_AVOID &&
        pump4h > S7_PUMP_MIN &&
        ret8h < 0
      ) {
        tracker.strategy = "S7_PUMPDUMP";
        if (transition(tracker, "READY_S7", context.nowMs, null)) {
          qualifiedAt8h = true;
          out.push(
            buildSignal({
              tracker,
              hoursSince,
              listingPrice,
              turnover1h,
              ret4h,
              ret8h,
              pump4h,
              pump8h,
              eventType: "CHECKPOINT_8H_S7_READY",
            })
          );
        }
      }
      if (!qualifiedAt8h && tracker.phase === "WATCHING" && tracker.strategy === "S7_PUMPDUMP") {
        // S7 watch path ended without qualification: retire from active tracking silently.
        transition(
          tracker,
          "DISQUALIFIED",
          context.nowMs,
          `S7 not qualified at 8h (ret8h=${(ret8h * 100).toFixed(2)}%, pump4h=${(pump4h * 100).toFixed(2)}%, pump8h=${(pump8h * 100).toFixed(2)}%).`
        );
      }

      tracker.checkpoint8hProcessed = true;
    }
  }

  cleanup(context.nowMs);
  return out;
}

export function exportNewListingState(): Record<string, unknown> {
  // Return plain serializable tracker snapshot.
  return { trackers };
}

export function hydrateNewListingState(snapshot: unknown): void {
  // Restore serialized trackers when snapshot is valid.
  if (!snapshot || typeof snapshot !== "object") return;
  const parsed = (snapshot as { trackers?: Record<string, Partial<ListingTracker>> }).trackers;
  if (!parsed || typeof parsed !== "object") return;

  for (const [symbol, rawTracker] of Object.entries(parsed)) {
    if (!rawTracker || typeof rawTracker !== "object") continue;

    const phaseRaw = rawTracker.phase;
    const phase: ListingPhase =
      phaseRaw === "READY_LEG1" ||
      phaseRaw === "READY_LEG2" ||
      phaseRaw === "READY_S7" ||
      phaseRaw === "CLOSED" ||
      phaseRaw === "DISQUALIFIED"
        ? phaseRaw
        : "WATCHING";

    const defaults =
      phase === "WATCHING"
        ? { checkpoint4hProcessed: false, checkpoint8hProcessed: false, hasReadySignal: false }
        : phase === "READY_LEG1"
          ? { checkpoint4hProcessed: true, checkpoint8hProcessed: false, hasReadySignal: true }
          : { checkpoint4hProcessed: true, checkpoint8hProcessed: true, hasReadySignal: true };

    const launchTimeMs = Number(rawTracker.launchTimeMs ?? 0);
    if (!Number.isFinite(launchTimeMs) || launchTimeMs <= 0) continue;
    if (symbol.includes("-")) continue;
    const ageHours = (Date.now() - launchTimeMs) / (60 * 60 * 1000);

    const normalizedTracker: ListingTracker = {
      symbol,
      strategy: rawTracker.strategy === "S7_PUMPDUMP" ? "S7_PUMPDUMP" : "RED4H_HIVOL",
      launchTimeMs,
      phase,
      listingPrice:
        typeof rawTracker.listingPrice === "number" && Number.isFinite(rawTracker.listingPrice)
          ? rawTracker.listingPrice
          : null,
      lastPrice:
        typeof rawTracker.lastPrice === "number" && Number.isFinite(rawTracker.lastPrice)
          ? rawTracker.lastPrice
          : null,
      checkpoint4hPrice:
        typeof rawTracker.checkpoint4hPrice === "number" && Number.isFinite(rawTracker.checkpoint4hPrice)
          ? rawTracker.checkpoint4hPrice
          : null,
      checkpoint8hPrice:
        typeof rawTracker.checkpoint8hPrice === "number" && Number.isFinite(rawTracker.checkpoint8hPrice)
          ? rawTracker.checkpoint8hPrice
          : null,
      transitionedAtMs: Number.isFinite(Number(rawTracker.transitionedAtMs))
        ? Number(rawTracker.transitionedAtMs)
        : Date.now(),
      closedAtMs:
        rawTracker.closedAtMs === null || rawTracker.closedAtMs === undefined
          ? null
          : Number.isFinite(Number(rawTracker.closedAtMs))
            ? Number(rawTracker.closedAtMs)
            : null,
      disqualifiedReason:
        typeof rawTracker.disqualifiedReason === "string" ? rawTracker.disqualifiedReason : null,
      checkpoint4hProcessed:
        typeof rawTracker.checkpoint4hProcessed === "boolean"
          ? rawTracker.checkpoint4hProcessed
          : defaults.checkpoint4hProcessed,
      checkpoint8hProcessed:
        typeof rawTracker.checkpoint8hProcessed === "boolean"
          ? rawTracker.checkpoint8hProcessed
          : defaults.checkpoint8hProcessed,
      hasReadySignal:
        typeof rawTracker.hasReadySignal === "boolean"
          ? rawTracker.hasReadySignal
          : defaults.hasReadySignal,
    };

    if (normalizedTracker.phase === "WATCHING" && !normalizedTracker.hasReadySignal && ageHours > DISCOVERY_MAX_AGE_HOURS) {
      continue;
    }

    trackers[symbol] = normalizedTracker;
  }
}

export function listNewListingTrackedSetups(): StrategyTrackedSetup[] {
  return Object.values(trackers).map((tracker) => ({
    key: `bybit:new-listing:${tracker.strategy}:${tracker.symbol}`,
    strategyId: resolveStrategyId(tracker.strategy),
    strategyName: resolveStrategyName(tracker.strategy),
    symbol: tracker.symbol,
    phase: tracker.phase,
    isReady:
      tracker.phase === "READY_LEG1" ||
      tracker.phase === "READY_LEG2" ||
      tracker.phase === "READY_S7",
    score: scoreForPhase(tracker.phase),
    payload: {
      launchTimeMs: tracker.launchTimeMs,
      listingPrice: tracker.listingPrice,
      lastPrice: tracker.lastPrice,
      checkpoint4hPrice: tracker.checkpoint4hPrice,
      checkpoint8hPrice: tracker.checkpoint8hPrice,
      transitionedAtMs: tracker.transitionedAtMs,
      closedAtMs: tracker.closedAtMs,
      disqualifiedReason: tracker.disqualifiedReason,
      checkpoint4hProcessed: tracker.checkpoint4hProcessed,
      checkpoint8hProcessed: tracker.checkpoint8hProcessed,
      hasReadySignal: tracker.hasReadySignal,
    },
    updatedAtMs: tracker.closedAtMs ?? tracker.transitionedAtMs ?? Date.now(),
  }));
}
