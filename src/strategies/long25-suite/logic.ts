/**
 * Long25 strategy logic.
 *
 * Entry (T+1h after funding settlement):
 * - funding hourly equivalent <= -0.1%
 * - basis < -0.5%
 * - price > 24h VWAP
 *
 * Exit:
 * - minimum hold: 1h
 * - hold while hourly volume > 2.5x 20h average
 * - exit first hour volume multiple drops below threshold
 * - no max-hold safety cap
 */
import type { Kline1h, StrategyContext, StrategyTrackedSetup } from "../../core/domain/types.js";
import { LONG25_CONFIG } from "./config.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

type Long25Phase = "WATCHING" | "READY";
type Long25ExitReason = "EXIT_VOLUME_DROP" | "EXIT_LIQUIDATED";

interface Long25Tracker {
  symbol: string;
  phase: Long25Phase;
  lastSettlementEvaluatedAtMs: number | null;
  lastSettlementEligibleAtMs: number | null;
  lastFundingHourlyEquiv: number | null;
  lastBasis: number | null;
  lastPrice: number | null;
  lastVwap24h: number | null;
  entryAtMs: number | null;
  entryPrice: number | null;
  entrySettlementAtMs: number | null;
  entryFundingHourlyEquiv: number | null;
  entryBasis: number | null;
  entryVwap24h: number | null;
  tradeId: number | null;
  lastVolumeMultiple: number | null;
  lastHourlyVolume: number | null;
  lastAvgVolume20h: number | null;
  lastExitAtMs: number | null;
  lastExitReason: Long25ExitReason | null;
  lastTradePnlPct: number | null;
  lastTradeWinner: boolean | null;
}

interface Long25Stats {
  totalTrades: number;
  totalLiquidations: number;
  totalWinners: number;
}

type Long25EventType = "ENTRY_READY" | "EXIT_VOLUME_DROP" | "EXIT_LIQUIDATED";

export interface Long25InternalSignal {
  symbol: string;
  phase: "READY" | "CLOSED";
  score: number;
  data: Record<string, unknown>;
}

const trackers: Record<string, Long25Tracker> = {};
const summaryStats: Long25Stats = {
  totalTrades: 0,
  totalLiquidations: 0,
  totalWinners: 0,
};
let nextTradeId = 1;

function getOrCreateTracker(symbol: string): Long25Tracker {
  const existing = trackers[symbol];
  if (existing) return existing;
  const created: Long25Tracker = {
    symbol,
    phase: "WATCHING",
    lastSettlementEvaluatedAtMs: null,
    lastSettlementEligibleAtMs: null,
    lastFundingHourlyEquiv: null,
    lastBasis: null,
    lastPrice: null,
    lastVwap24h: null,
    entryAtMs: null,
    entryPrice: null,
    entrySettlementAtMs: null,
    entryFundingHourlyEquiv: null,
    entryBasis: null,
    entryVwap24h: null,
    tradeId: null,
    lastVolumeMultiple: null,
    lastHourlyVolume: null,
    lastAvgVolume20h: null,
    lastExitAtMs: null,
    lastExitReason: null,
    lastTradePnlPct: null,
    lastTradeWinner: null,
  };
  trackers[symbol] = created;
  return created;
}

function scoreForPhase(phase: "READY" | "CLOSED"): number {
  if (phase === "READY") return 100;
  return 90;
}

function computeBasis(lastPrice: number, indexPrice: number): number | null {
  if (!Number.isFinite(lastPrice) || !Number.isFinite(indexPrice) || indexPrice <= 0) return null;
  return (lastPrice - indexPrice) / indexPrice;
}

function computeFundingHourlyEquiv(fundingRate: number, fundingIntervalMinutes: number): number | null {
  if (!Number.isFinite(fundingRate) || !Number.isFinite(fundingIntervalMinutes) || fundingIntervalMinutes <= 0) {
    return null;
  }
  const intervalHours = fundingIntervalMinutes / 60;
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) return null;
  return fundingRate / intervalHours;
}

function completedCandles(candles: Kline1h[], nowMs: number): Kline1h[] {
  // Only use completed 1h candles to avoid partial-volume bias.
  return candles.filter((candle) => candle.openTimeMs + HOUR_MS <= nowMs);
}

function computeVwap(candles: Kline1h[], lookbackHours: number): number | null {
  if (lookbackHours <= 0) return null;
  if (candles.length < lookbackHours) return null;
  const sample = candles.slice(-lookbackHours);
  let turnoverSum = 0;
  let volumeSum = 0;
  for (const candle of sample) {
    if (!Number.isFinite(candle.turnover) || !Number.isFinite(candle.volume)) continue;
    turnoverSum += candle.turnover;
    volumeSum += candle.volume;
  }
  if (!Number.isFinite(volumeSum) || volumeSum <= 0) return null;
  return turnoverSum / volumeSum;
}

function computeVolumeContext(
  candles: Kline1h[],
  lookbackHours: number
): { currentVolume: number; avgVolume: number; multiple: number } | null {
  // Need current completed candle + lookback window behind it.
  if (lookbackHours <= 0) return null;
  if (candles.length < lookbackHours + 1) return null;

  const current = candles[candles.length - 1];
  if (!current || !Number.isFinite(current.volume)) return null;

  const history = candles.slice(-(lookbackHours + 1), -1);
  if (history.length < lookbackHours) return null;
  const valid = history.filter((row) => Number.isFinite(row.volume));
  if (valid.length === 0) return null;
  const avgVolume = valid.reduce((acc, row) => acc + row.volume, 0) / valid.length;
  if (!Number.isFinite(avgVolume) || avgVolume <= 0) return null;

  return {
    currentVolume: current.volume,
    avgVolume,
    multiple: current.volume / avgVolume,
  };
}

function closePosition(input: {
  tracker: Long25Tracker;
  nowMs: number;
  lastPrice: number;
  reason: Long25ExitReason;
}): { pnlPct: number | null; isWinner: boolean } {
  const { tracker, nowMs, lastPrice, reason } = input;
  const entryPrice = tracker.entryPrice;
  const pnlPct =
    typeof entryPrice === "number" && Number.isFinite(entryPrice) && entryPrice > 0
      ? (lastPrice - entryPrice) / entryPrice
      : null;
  const isWinner = pnlPct !== null && pnlPct > 0;

  tracker.phase = "WATCHING";
  tracker.lastExitAtMs = nowMs;
  tracker.lastExitReason = reason;
  tracker.lastTradePnlPct = pnlPct;
  tracker.lastTradeWinner = isWinner;

  tracker.entryAtMs = null;
  tracker.entryPrice = null;
  tracker.entrySettlementAtMs = null;
  tracker.entryFundingHourlyEquiv = null;
  tracker.entryBasis = null;
  tracker.entryVwap24h = null;

  if (reason === "EXIT_LIQUIDATED") {
    summaryStats.totalLiquidations += 1;
  }
  if (isWinner) {
    summaryStats.totalWinners += 1;
  }

  return { pnlPct, isWinner };
}

function isEligibleInstrument(input: { symbol: string; status: string; contractType?: string | null }): boolean {
  if (input.status.toLowerCase() !== "trading") return false;
  if (input.symbol.includes("-")) return false;
  if (typeof input.contractType === "string" && input.contractType.toLowerCase().includes("futures")) {
    return false;
  }
  return true;
}

export async function evaluateLong25Signals(context: StrategyContext): Promise<Long25InternalSignal[]> {
  const out: Long25InternalSignal[] = [];
  const instrumentMap = new Map(context.instruments.map((instrument) => [instrument.symbol, instrument]));

  for (const ticker of context.tickers) {
    const instrument = instrumentMap.get(ticker.symbol);
    if (!instrument) continue;
    if (!isEligibleInstrument({ symbol: instrument.symbol, status: instrument.status, contractType: instrument.contractType })) {
      continue;
    }
    if (!Number.isFinite(ticker.lastPrice) || ticker.lastPrice <= 0) continue;

    const tracker = getOrCreateTracker(ticker.symbol);
    tracker.lastPrice = ticker.lastPrice;
    tracker.lastBasis = computeBasis(ticker.lastPrice, ticker.indexPrice);

    const fundingIntervalMinutes =
      typeof instrument.fundingIntervalMinutes === "number" && Number.isFinite(instrument.fundingIntervalMinutes)
        ? instrument.fundingIntervalMinutes
        : LONG25_CONFIG.market.defaultFundingIntervalMinutes;
    const fundingIntervalMs = fundingIntervalMinutes * MINUTE_MS;
    const fundingSettlementAtMs = ticker.nextFundingTimeMs - fundingIntervalMs;
    const settlementEligibleAtMs =
      fundingSettlementAtMs + LONG25_CONFIG.entry.delayHoursAfterFundingSettlement * HOUR_MS;
    const shouldEvaluateEntry =
      Number.isFinite(fundingSettlementAtMs) &&
      fundingSettlementAtMs > 0 &&
      context.nowMs >= settlementEligibleAtMs &&
      (tracker.lastSettlementEvaluatedAtMs === null || fundingSettlementAtMs > tracker.lastSettlementEvaluatedAtMs);

    const needsHourlyCandles = shouldEvaluateEntry || tracker.phase === "READY";
    let finishedCandles: Kline1h[] = [];
    if (needsHourlyCandles) {
      const candles = await context.getKlines1h(ticker.symbol, LONG25_CONFIG.market.klineLookbackHours);
      finishedCandles = completedCandles(candles, context.nowMs);
    }

    if (shouldEvaluateEntry) {
      const fundingHourlyEquiv = computeFundingHourlyEquiv(ticker.fundingRate, fundingIntervalMinutes);
      const vwap24h = computeVwap(finishedCandles, LONG25_CONFIG.entry.vwapLookbackHours);
      const basis = tracker.lastBasis;
      tracker.lastSettlementEvaluatedAtMs = fundingSettlementAtMs;
      tracker.lastSettlementEligibleAtMs = settlementEligibleAtMs;
      tracker.lastFundingHourlyEquiv = fundingHourlyEquiv;
      tracker.lastVwap24h = vwap24h;

      const fundingOk =
        fundingHourlyEquiv !== null && fundingHourlyEquiv <= LONG25_CONFIG.entry.fundingHourlyEquivMax;
      const basisOk = basis !== null && basis < LONG25_CONFIG.entry.basisMax;
      const vwapOk =
        !LONG25_CONFIG.entry.requirePriceAboveVwap ||
        (vwap24h !== null && Number.isFinite(vwap24h) && ticker.lastPrice > vwap24h);

      if (tracker.phase !== "READY" && fundingOk && basisOk && vwapOk) {
        tracker.phase = "READY";
        tracker.entryAtMs = context.nowMs;
        tracker.entryPrice = ticker.lastPrice;
        tracker.entrySettlementAtMs = fundingSettlementAtMs;
        tracker.entryFundingHourlyEquiv = fundingHourlyEquiv;
        tracker.entryBasis = basis;
        tracker.entryVwap24h = vwap24h;
        tracker.tradeId = nextTradeId;
        nextTradeId += 1;
        summaryStats.totalTrades += 1;

        out.push({
          symbol: ticker.symbol,
          phase: "READY",
          score: scoreForPhase("READY"),
          data: {
            eventType: "ENTRY_READY" satisfies Long25EventType,
            action: "OPEN LONG",
            side: "LONG",
            tradeId: tracker.tradeId,
            price: ticker.lastPrice,
            fundingRate: ticker.fundingRate,
            fundingHourlyEquiv,
            basis,
            vwap24h,
            fundingSettlementAtMs,
            settlementEligibleAtMs,
            totalTrades: summaryStats.totalTrades,
            totalLiquidations: summaryStats.totalLiquidations,
            totalWinners: summaryStats.totalWinners,
          },
        });
      }
    }

    if (tracker.phase !== "READY") {
      continue;
    }
    if (tracker.entryPrice === null || tracker.entryAtMs === null) {
      // Defensive recovery if state got partially corrupted.
      tracker.phase = "WATCHING";
      continue;
    }

    const liquidationPrice = tracker.entryPrice * (1 + LONG25_CONFIG.risk.liquidationDrawdownPct);
    const liquidationHit = ticker.lastPrice <= liquidationPrice;
    if (liquidationHit) {
      const heldHours = (context.nowMs - tracker.entryAtMs) / HOUR_MS;
      const close = closePosition({
        tracker,
        nowMs: context.nowMs,
        lastPrice: ticker.lastPrice,
        reason: "EXIT_LIQUIDATED",
      });
      const winRate =
        summaryStats.totalTrades > 0 ? (summaryStats.totalWinners / summaryStats.totalTrades) * 100 : 0;
      out.push({
        symbol: ticker.symbol,
        phase: "CLOSED",
        score: scoreForPhase("CLOSED"),
        data: {
          eventType: "EXIT_LIQUIDATED" satisfies Long25EventType,
          action: "CLOSE LONG",
          side: "LONG",
          tradeId: tracker.tradeId,
          exitPrice: ticker.lastPrice,
          liquidationPrice,
          pnlPct: close.pnlPct,
          isWinner: close.isWinner,
          heldHours,
          totalTrades: summaryStats.totalTrades,
          totalLiquidations: summaryStats.totalLiquidations,
          totalWinners: summaryStats.totalWinners,
          winRatePct: winRate,
        },
      });
      tracker.tradeId = null;
      continue;
    }

    const heldMs = context.nowMs - tracker.entryAtMs;
    if (heldMs < LONG25_CONFIG.exit.minHoldHours * HOUR_MS) {
      continue;
    }

    const volumeContext = computeVolumeContext(finishedCandles, LONG25_CONFIG.exit.volumeAverageLookbackHours);
    if (!volumeContext) {
      continue;
    }

    tracker.lastHourlyVolume = volumeContext.currentVolume;
    tracker.lastAvgVolume20h = volumeContext.avgVolume;
    tracker.lastVolumeMultiple = volumeContext.multiple;

    if (volumeContext.multiple >= LONG25_CONFIG.exit.volumeMultipleThreshold) {
      continue;
    }

    const close = closePosition({
      tracker,
      nowMs: context.nowMs,
      lastPrice: ticker.lastPrice,
      reason: "EXIT_VOLUME_DROP",
    });
    const winRate =
      summaryStats.totalTrades > 0 ? (summaryStats.totalWinners / summaryStats.totalTrades) * 100 : 0;
    out.push({
      symbol: ticker.symbol,
      phase: "CLOSED",
      score: scoreForPhase("CLOSED"),
      data: {
        eventType: "EXIT_VOLUME_DROP" satisfies Long25EventType,
        action: "CLOSE LONG",
        side: "LONG",
        tradeId: tracker.tradeId,
        exitPrice: ticker.lastPrice,
        pnlPct: close.pnlPct,
        isWinner: close.isWinner,
        heldHours: heldMs / HOUR_MS,
        currentHourVolume: volumeContext.currentVolume,
        averageVolume20h: volumeContext.avgVolume,
        volumeMultiple: volumeContext.multiple,
        volumeThreshold: LONG25_CONFIG.exit.volumeMultipleThreshold,
        totalTrades: summaryStats.totalTrades,
        totalLiquidations: summaryStats.totalLiquidations,
        totalWinners: summaryStats.totalWinners,
        winRatePct: winRate,
      },
    });
    tracker.tradeId = null;
  }

  return out;
}

export function listLong25TrackedSetups(): StrategyTrackedSetup[] {
  const out: StrategyTrackedSetup[] = [];
  for (const tracker of Object.values(trackers)) {
    if (tracker.phase !== "READY") continue;
    out.push({
      key: `bybit:long25:${tracker.symbol}`,
      strategyId: LONG25_CONFIG.strategyId,
      strategyName: LONG25_CONFIG.strategyName,
      symbol: tracker.symbol,
      phase: "READY",
      isReady: true,
      score: scoreForPhase("READY"),
      payload: {
        action: "OPEN LONG",
        side: "LONG",
        tradeId: tracker.tradeId,
        entryAtMs: tracker.entryAtMs,
        entryPrice: tracker.entryPrice,
        entrySettlementAtMs: tracker.entrySettlementAtMs,
        entryFundingHourlyEquiv: tracker.entryFundingHourlyEquiv,
        entryBasis: tracker.entryBasis,
        entryVwap24h: tracker.entryVwap24h,
        lastVolumeMultiple: tracker.lastVolumeMultiple,
        lastHourlyVolume: tracker.lastHourlyVolume,
        lastAvgVolume20h: tracker.lastAvgVolume20h,
      },
      updatedAtMs: tracker.entryAtMs ?? Date.now(),
    });
  }
  return out;
}

export function exportLong25State(): Record<string, unknown> {
  return {
    trackers,
    summaryStats,
    nextTradeId,
  };
}

export function hydrateLong25State(snapshot: unknown): void {
  if (!snapshot || typeof snapshot !== "object") return;
  const typed = snapshot as {
    trackers?: Record<string, Long25Tracker>;
    summaryStats?: Long25Stats;
    nextTradeId?: number;
  };

  if (typed.trackers && typeof typed.trackers === "object") {
    for (const [symbol, tracker] of Object.entries(typed.trackers)) {
      trackers[symbol] = tracker;
    }
  }

  if (typed.summaryStats && typeof typed.summaryStats === "object") {
    summaryStats.totalTrades = Number(typed.summaryStats.totalTrades ?? 0) || 0;
    summaryStats.totalLiquidations = Number(typed.summaryStats.totalLiquidations ?? 0) || 0;
    summaryStats.totalWinners = Number(typed.summaryStats.totalWinners ?? 0) || 0;
  }

  if (typeof typed.nextTradeId === "number" && Number.isFinite(typed.nextTradeId) && typed.nextTradeId > 0) {
    nextTradeId = Math.floor(typed.nextTradeId);
  }
}

export function getLong25Stats(): Long25Stats {
  return {
    totalTrades: summaryStats.totalTrades,
    totalLiquidations: summaryStats.totalLiquidations,
    totalWinners: summaryStats.totalWinners,
  };
}
