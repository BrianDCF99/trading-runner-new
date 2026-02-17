/**
 * Extreme funding alert strategy logic.
 *
 * Rule:
 * - 1h settlement contracts trigger at funding <= -0.5%
 * - all other contracts trigger at funding <= -1.0%
 */
import type { StrategyContext, StrategyTrackedSetup } from "../../core/domain/types.js";
import { EXTREME_FUNDING_CONFIG } from "./config.js";

type ExtremeFundingPhase = "ALERT";

interface ExtremeFundingTracker {
  symbol: string;
  fundingRate: number;
  threshold: number;
  fundingIntervalMinutes: number | null;
  settlementLabel: string;
  triggeredAtMs: number;
}

export interface ExtremeFundingInternalSignal {
  symbol: string;
  phase: ExtremeFundingPhase;
  score: number;
  data: Record<string, unknown>;
}

const ALERT_SCORE = 100;
const trackers: Record<string, ExtremeFundingTracker> = {};

function resolveThreshold(fundingIntervalMinutes: number | null): number {
  if (fundingIntervalMinutes === EXTREME_FUNDING_CONFIG.oneHourSettlementMinutes) {
    return EXTREME_FUNDING_CONFIG.thresholds.oneHourSettlement;
  }
  return EXTREME_FUNDING_CONFIG.thresholds.default;
}

function toHourClock(totalMinutes: number): string {
  const roundedMinutes = Math.max(0, Math.floor(totalMinutes));
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function resolveSettlementLabel(fundingIntervalMinutes: number | null): string {
  if (typeof fundingIntervalMinutes === "number" && Number.isFinite(fundingIntervalMinutes) && fundingIntervalMinutes > 0) {
    return toHourClock(fundingIntervalMinutes);
  }
  return "unknown";
}

function isExtremeFunding(fundingRate: number, threshold: number): boolean {
  return fundingRate <= threshold;
}

export async function evaluateExtremeFundingSignals(context: StrategyContext): Promise<ExtremeFundingInternalSignal[]> {
  const out: ExtremeFundingInternalSignal[] = [];
  const intervalBySymbol = new Map(
    context.instruments.map((instrument) => [instrument.symbol, instrument.fundingIntervalMinutes ?? null])
  );
  const seenSymbols = new Set<string>();

  for (const ticker of context.tickers) {
    seenSymbols.add(ticker.symbol);

    const fundingIntervalMinutes = intervalBySymbol.get(ticker.symbol) ?? null;
    const threshold = resolveThreshold(fundingIntervalMinutes);
    const settlementLabel = resolveSettlementLabel(fundingIntervalMinutes);
    const currentlyExtreme = isExtremeFunding(ticker.fundingRate, threshold);
    const existing = trackers[ticker.symbol];

    if (currentlyExtreme) {
      if (!existing) {
        const created: ExtremeFundingTracker = {
          symbol: ticker.symbol,
          fundingRate: ticker.fundingRate,
          threshold,
          fundingIntervalMinutes,
          settlementLabel,
          triggeredAtMs: context.nowMs,
        };
        trackers[ticker.symbol] = created;

        out.push({
          symbol: ticker.symbol,
          phase: "ALERT",
          score: ALERT_SCORE,
          data: {
            fundingRate: ticker.fundingRate,
            threshold,
            fundingIntervalMinutes,
            settlementLabel,
            triggerReason:
              fundingIntervalMinutes === EXTREME_FUNDING_CONFIG.oneHourSettlementMinutes
                ? "1h settlement threshold breached"
                : "default threshold breached",
            triggeredAtMs: context.nowMs,
            markPrice: ticker.markPrice,
            nextFundingTimeMs: ticker.nextFundingTimeMs,
          },
        });
        continue;
      }

      existing.fundingRate = ticker.fundingRate;
      existing.threshold = threshold;
      existing.fundingIntervalMinutes = fundingIntervalMinutes;
      existing.settlementLabel = settlementLabel;
      continue;
    }

    if (existing) {
      delete trackers[ticker.symbol];
    }
  }

  // Drop symbols that disappeared from current exchange ticker payload.
  for (const symbol of Object.keys(trackers)) {
    if (!seenSymbols.has(symbol)) {
      delete trackers[symbol];
    }
  }

  return out;
}

export function exportExtremeFundingState(): Record<string, unknown> {
  return { trackers };
}

export function hydrateExtremeFundingState(snapshot: unknown): void {
  if (!snapshot || typeof snapshot !== "object") return;
  const parsed = (snapshot as { trackers?: Record<string, ExtremeFundingTracker> }).trackers;
  if (!parsed || typeof parsed !== "object") return;
  for (const [symbol, tracker] of Object.entries(parsed)) {
    if (!tracker || typeof tracker !== "object") continue;
    const fundingRate = typeof tracker.fundingRate === "number" ? tracker.fundingRate : 0;
    const threshold = typeof tracker.threshold === "number" ? tracker.threshold : EXTREME_FUNDING_CONFIG.thresholds.default;
    const fundingIntervalMinutes =
      typeof tracker.fundingIntervalMinutes === "number" ? tracker.fundingIntervalMinutes : null;
    const settlementLabel =
      typeof tracker.settlementLabel === "string" && tracker.settlementLabel.trim().length > 0
        ? tracker.settlementLabel
        : resolveSettlementLabel(fundingIntervalMinutes);
    const triggeredAtMs = typeof tracker.triggeredAtMs === "number" ? tracker.triggeredAtMs : Date.now();

    trackers[symbol] = {
      symbol,
      fundingRate,
      threshold,
      fundingIntervalMinutes,
      settlementLabel,
      triggeredAtMs,
    };
  }
}

export function listExtremeFundingTrackedSetups(): StrategyTrackedSetup[] {
  return Object.values(trackers).map((tracker) => ({
    key: `bybit:extreme-funding:${tracker.symbol}`,
    strategyId: EXTREME_FUNDING_CONFIG.strategyId,
    strategyName: EXTREME_FUNDING_CONFIG.strategyName,
    symbol: tracker.symbol,
    phase: "ALERT",
    isReady: false,
    score: ALERT_SCORE,
    payload: {
      fundingRate: tracker.fundingRate,
      threshold: tracker.threshold,
      fundingIntervalMinutes: tracker.fundingIntervalMinutes,
      settlementLabel: tracker.settlementLabel,
      triggeredAtMs: tracker.triggeredAtMs,
    },
    updatedAtMs: tracker.triggeredAtMs,
  }));
}
