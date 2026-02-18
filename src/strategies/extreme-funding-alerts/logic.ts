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
  lastPrice: number | null;
  lastAlertPrice: number | null;
  lastAlertAtMs: number | null;
  extremeWindowsInRow: number;
  extremeStreakStartPrice: number | null;
  lastFundingWindowKey: number | null;
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
  if (minutes === 0) return `${hours}h`;
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

function normalizeFundingWindowKey(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function pctOrNull(base: number | null, value: number | null): number | null {
  if (base === null || !Number.isFinite(base) || base <= 0) return null;
  if (value === null || !Number.isFinite(value)) return null;
  return (value - base) / base;
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
    const fundingWindowKey = normalizeFundingWindowKey(ticker.nextFundingTimeMs);
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
          lastPrice: ticker.lastPrice,
          lastAlertPrice: ticker.lastPrice,
          lastAlertAtMs: context.nowMs,
          extremeWindowsInRow: 1,
          extremeStreakStartPrice: ticker.lastPrice,
          lastFundingWindowKey: fundingWindowKey,
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
            alertPrice: ticker.lastPrice,
            priceChangeSinceLastNotification: null,
            extremeWindowsInRow: created.extremeWindowsInRow,
            priceChangeSinceFirstNotificationInStreak: 0,
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
      existing.lastPrice = ticker.lastPrice;

      const advancedFundingWindow =
        existing.lastFundingWindowKey !== null &&
        fundingWindowKey !== null &&
        fundingWindowKey !== existing.lastFundingWindowKey;
      existing.lastFundingWindowKey = fundingWindowKey;

      if (!advancedFundingWindow) {
        continue;
      }

      existing.extremeWindowsInRow += 1;
      const priceChangeSinceLastNotification = pctOrNull(existing.lastAlertPrice, ticker.lastPrice);
      const priceChangeSinceFirstNotificationInStreak = pctOrNull(existing.extremeStreakStartPrice, ticker.lastPrice);

      out.push({
        symbol: ticker.symbol,
        phase: "ALERT",
        score: ALERT_SCORE,
        data: {
          fundingRate: ticker.fundingRate,
          threshold,
          fundingIntervalMinutes,
          settlementLabel,
          triggerReason: "still extreme in new funding window",
          triggeredAtMs: existing.triggeredAtMs,
          alertPrice: ticker.lastPrice,
          priceChangeSinceLastNotification,
          extremeWindowsInRow: existing.extremeWindowsInRow,
          priceChangeSinceFirstNotificationInStreak,
          markPrice: ticker.markPrice,
          nextFundingTimeMs: ticker.nextFundingTimeMs,
        },
      });
      existing.lastAlertPrice = ticker.lastPrice;
      existing.lastAlertAtMs = context.nowMs;
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
    const lastPrice = typeof tracker.lastPrice === "number" && Number.isFinite(tracker.lastPrice) ? tracker.lastPrice : null;
    const lastAlertPrice =
      typeof tracker.lastAlertPrice === "number" && Number.isFinite(tracker.lastAlertPrice)
        ? tracker.lastAlertPrice
        : lastPrice;
    const lastAlertAtMs =
      typeof tracker.lastAlertAtMs === "number" && Number.isFinite(tracker.lastAlertAtMs)
        ? tracker.lastAlertAtMs
        : triggeredAtMs;
    const extremeWindowsInRow =
      typeof tracker.extremeWindowsInRow === "number" && Number.isFinite(tracker.extremeWindowsInRow)
        ? Math.max(1, Math.floor(tracker.extremeWindowsInRow))
        : 1;
    const extremeStreakStartPrice =
      typeof tracker.extremeStreakStartPrice === "number" && Number.isFinite(tracker.extremeStreakStartPrice)
        ? tracker.extremeStreakStartPrice
        : lastAlertPrice;
    const lastFundingWindowKey =
      typeof tracker.lastFundingWindowKey === "number" && Number.isFinite(tracker.lastFundingWindowKey)
        ? tracker.lastFundingWindowKey
        : null;

    trackers[symbol] = {
      symbol,
      fundingRate,
      threshold,
      fundingIntervalMinutes,
      settlementLabel,
      triggeredAtMs,
      lastPrice,
      lastAlertPrice,
      lastAlertAtMs,
      extremeWindowsInRow,
      extremeStreakStartPrice,
      lastFundingWindowKey,
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
      lastPrice: tracker.lastPrice,
      lastAlertPrice: tracker.lastAlertPrice,
      lastAlertAtMs: tracker.lastAlertAtMs,
      extremeWindowsInRow: tracker.extremeWindowsInRow,
      priceChangeSinceLastNotification: pctOrNull(tracker.lastAlertPrice, tracker.lastPrice),
      priceChangeSinceFirstNotificationInStreak: pctOrNull(tracker.extremeStreakStartPrice, tracker.lastPrice),
    },
    updatedAtMs: tracker.lastAlertAtMs ?? tracker.triggeredAtMs,
  }));
}
