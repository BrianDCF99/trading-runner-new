/**
 * Funding Rule I state machine logic.
 *
 * Rule:
 * - extreme funding when rate <= -0.5%
 * - READY on normalization only if
 *   - pump_before_extreme < 3%
 *   - previous extreme signal gap <= 4h
 * - hold for 8h then CLOSED
 */
import type { StrategyContext, StrategyTrackedSetup } from "../../core/domain/types.js";

const EXTREME_THRESHOLD = -0.005;
const PUMP_BEFORE_EXTREME_MAX = 0.03;
const PREV_SIGNAL_GAP_MAX_HOURS = 4;
const HOLD_HOURS = 8;
const CLOSE_RETENTION_HOURS = 24;

type FundingPhase = "WATCHING" | "READY" | "CLOSED" | "SKIPPED";

interface FundingTracker {
  symbol: string;
  phase: FundingPhase;
  inExtreme: boolean;
  extremeStartedAtMs: number | null;
  peakExtremeRate: number | null;
  lastExtremeSignalAtMs: number | null;
  lastNormalizationAtMs: number | null;
  lastNormalizationPrice: number | null;
  maxPriceSinceNormalization: number | null;
  entryAtMs: number | null;
  closeDueAtMs: number | null;
  closedAtMs: number | null;
  disqualificationReason: string | null;
}

export interface FundingInternalSignal {
  symbol: string;
  phase: FundingPhase;
  score: number;
  data: Record<string, unknown>;
}

const trackers: Record<string, FundingTracker> = {};

function getOrCreate(symbol: string): FundingTracker {
  // Reuse existing tracker for symbol, otherwise initialize new one.
  const existing = trackers[symbol];
  if (existing) return existing;
  const created: FundingTracker = {
    symbol,
    phase: "WATCHING",
    inExtreme: false,
    extremeStartedAtMs: null,
    peakExtremeRate: null,
    lastExtremeSignalAtMs: null,
    lastNormalizationAtMs: null,
    lastNormalizationPrice: null,
    maxPriceSinceNormalization: null,
    entryAtMs: null,
    closeDueAtMs: null,
    closedAtMs: null,
    disqualificationReason: null,
  };
  trackers[symbol] = created;
  return created;
}

function pct(base: number, value: number): number {
  // Protect against divide-by-zero or invalid base values.
  if (!Number.isFinite(base) || base <= 0) return Number.POSITIVE_INFINITY;
  return (value - base) / base;
}

function scoreForPhase(phase: FundingPhase): number {
  if (phase === "READY") return 100;
  if (phase === "CLOSED") return 90;
  if (phase === "WATCHING") return 40;
  return 20;
}

function transition(tracker: FundingTracker, phase: FundingPhase, nowMs: number, reason: string | null): boolean {
  // Ignore no-op transitions to avoid duplicate signals.
  if (tracker.phase === phase) return false;
  tracker.phase = phase;
  tracker.disqualificationReason = reason;
  if (phase === "READY") {
    // READY starts the fixed hold window.
    tracker.entryAtMs = nowMs;
    tracker.closeDueAtMs = nowMs + HOLD_HOURS * 60 * 60 * 1000;
    tracker.closedAtMs = null;
  }
  if (phase === "CLOSED") {
    // CLOSED marks terminal state timestamp.
    tracker.closedAtMs = nowMs;
  }
  return true;
}

function cleanup(nowMs: number): void {
  // Keep CLOSED only for retention window; drop SKIPPED immediately.
  const retentionMs = CLOSE_RETENTION_HOURS * 60 * 60 * 1000;
  for (const [symbol, tracker] of Object.entries(trackers)) {
    if (tracker.phase === "SKIPPED") {
      delete trackers[symbol];
      continue;
    }
    if (tracker.phase === "CLOSED" && tracker.closedAtMs !== null && nowMs - tracker.closedAtMs > retentionMs) {
      delete trackers[symbol];
    }
  }
}

export async function evaluateFundingRuleISignals(context: StrategyContext): Promise<FundingInternalSignal[]> {
  const out: FundingInternalSignal[] = [];

  for (const ticker of context.tickers) {
    const tracker = getOrCreate(ticker.symbol);

    // Update post-normalization max price used for pump-before-extreme metric.
    if (tracker.lastNormalizationPrice !== null) {
      tracker.maxPriceSinceNormalization = Math.max(
        tracker.maxPriceSinceNormalization ?? tracker.lastNormalizationPrice,
        ticker.lastPrice
      );
    }

    // Auto-close READY setup when hold deadline is reached.
    if (tracker.phase === "READY" && tracker.closeDueAtMs !== null && context.nowMs >= tracker.closeDueAtMs) {
      if (
        transition(tracker, "CLOSED", context.nowMs, null)
      ) {
        out.push({
          symbol: tracker.symbol,
          phase: tracker.phase,
          score: scoreForPhase(tracker.phase),
          data: {
            fundingRate: ticker.fundingRate,
            closeDueAtMs: tracker.closeDueAtMs,
            closedAtMs: tracker.closedAtMs,
          },
        });
      }
      continue;
    }

    // Extreme condition uses negative threshold (more negative => more extreme).
    const isExtreme = ticker.fundingRate <= EXTREME_THRESHOLD;

    if (isExtreme) {
      // Start new extreme episode or deepen existing one.
      if (!tracker.inExtreme) {
        tracker.inExtreme = true;
        tracker.extremeStartedAtMs = context.nowMs;
        tracker.peakExtremeRate = ticker.fundingRate;
      } else if (tracker.peakExtremeRate !== null) {
        tracker.peakExtremeRate = Math.min(tracker.peakExtremeRate, ticker.fundingRate);
      }
      continue;
    }

    // If not extreme and no active extreme episode, nothing to evaluate.
    if (!tracker.inExtreme) {
      continue;
    }

    // Normalization event reached: evaluate Rule I filters at this point.
    tracker.inExtreme = false;

    const prevGapHours =
      tracker.lastExtremeSignalAtMs === null
        ? null
        : (context.nowMs - tracker.lastExtremeSignalAtMs) / (60 * 60 * 1000);

    const basePrice = tracker.lastNormalizationPrice ?? ticker.lastPrice;
    const maxPriceBeforeExtreme = tracker.maxPriceSinceNormalization ?? basePrice;
    const pumpBeforeExtreme = pct(basePrice, maxPriceBeforeExtreme);

    const pumpOk = pumpBeforeExtreme < PUMP_BEFORE_EXTREME_MAX;
    const gapOk = prevGapHours !== null && prevGapHours <= PREV_SIGNAL_GAP_MAX_HOURS;

    // Advance tracker baseline for next extreme/normalization cycle.
    tracker.lastExtremeSignalAtMs = tracker.extremeStartedAtMs ?? context.nowMs;
    tracker.lastNormalizationAtMs = context.nowMs;
    tracker.lastNormalizationPrice = ticker.lastPrice;
    tracker.maxPriceSinceNormalization = ticker.lastPrice;

    const matched = pumpOk && gapOk;
    if (matched) {
      // Matched Rule I => emit READY alert once on transition.
      if (transition(tracker, "READY", context.nowMs, null)) {
        out.push({
          symbol: tracker.symbol,
          phase: tracker.phase,
          score: scoreForPhase(tracker.phase),
          data: {
            fundingRate: ticker.fundingRate,
            peakExtremeRate: tracker.peakExtremeRate,
            pumpBeforeExtreme,
            prevSignalGapHours: prevGapHours,
            holdHours: HOLD_HOURS,
            closeDueAtMs: tracker.closeDueAtMs,
            alertPrice: ticker.lastPrice,
          },
        });
      }
    } else {
      // Failed Rule I => mark SKIPPED with explicit reason and stop tracking.
      transition(
        tracker,
        "SKIPPED",
        context.nowMs,
        `Rule I reject: pump_before_extreme=${(pumpBeforeExtreme * 100).toFixed(2)}%, prev_gap=${prevGapHours?.toFixed(2) ?? "n/a"}h`
      );
    }
  }

  cleanup(context.nowMs);
  return out;
}

export function exportFundingState(): Record<string, unknown> {
  // Return plain serializable tracker snapshot.
  return { trackers };
}

export function hydrateFundingState(snapshot: unknown): void {
  // Restore serialized trackers if snapshot has expected shape.
  if (!snapshot || typeof snapshot !== "object") return;
  const parsed = (snapshot as { trackers?: Record<string, FundingTracker> }).trackers;
  if (!parsed || typeof parsed !== "object") return;
  for (const [symbol, tracker] of Object.entries(parsed)) {
    trackers[symbol] = tracker;
  }
}

export function listFundingTrackedSetups(): StrategyTrackedSetup[] {
  return Object.values(trackers).map((tracker) => ({
    key: `bybit:funding:rule-i:${tracker.symbol}`,
    strategyId: "bybit:funding:rule-i:v7",
    strategyName: "Funding Rule I v7",
    symbol: tracker.symbol,
    phase: tracker.phase,
    isReady: tracker.phase === "READY",
    score: scoreForPhase(tracker.phase),
    payload: {
      extremeStartedAtMs: tracker.extremeStartedAtMs,
      peakExtremeRate: tracker.peakExtremeRate,
      lastExtremeSignalAtMs: tracker.lastExtremeSignalAtMs,
      lastNormalizationAtMs: tracker.lastNormalizationAtMs,
      closeDueAtMs: tracker.closeDueAtMs,
      entryAtMs: tracker.entryAtMs,
      closedAtMs: tracker.closedAtMs,
      disqualificationReason: tracker.disqualificationReason,
    },
    updatedAtMs:
      tracker.closedAtMs ??
      tracker.entryAtMs ??
      tracker.lastNormalizationAtMs ??
      tracker.extremeStartedAtMs ??
      Date.now(),
  }));
}
