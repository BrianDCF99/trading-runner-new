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
  firstTriggeredAtMs: number | null;
  lastPrice: number | null;
  lastAlertPrice: number | null;
  lastAlertAtMs: number | null;
  extremeStreak: number;
  extremeStreakStartPrice: number | null;
  lastObservedFundingWindowKey: number | null;
  lastAlertFundingWindowKey: number | null;
  isCurrentlyExtreme: boolean;
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

function isConsecutiveFundingWindow(
  previousWindowKey: number | null,
  currentWindowKey: number | null,
  fundingIntervalMinutes: number | null
): boolean {
  if (previousWindowKey === null || currentWindowKey === null) return false;
  const delta = currentWindowKey - previousWindowKey;
  if (!Number.isFinite(delta) || delta <= 0) return false;

  if (typeof fundingIntervalMinutes !== "number" || !Number.isFinite(fundingIntervalMinutes) || fundingIntervalMinutes <= 0) {
    return true;
  }

  const intervalMs = Math.max(1, Math.floor(fundingIntervalMinutes * 60_000));
  const toleranceMs = Math.min(5 * 60_000, Math.max(30_000, Math.floor(intervalMs * 0.05)));
  return Math.abs(delta - intervalMs) <= toleranceMs;
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

    if (!existing) {
      if (!currentlyExtreme) continue;
      trackers[ticker.symbol] = {
        symbol: ticker.symbol,
        fundingRate: ticker.fundingRate,
        threshold,
        fundingIntervalMinutes,
        settlementLabel,
        firstTriggeredAtMs: null,
        lastPrice: ticker.lastPrice,
        lastAlertPrice: null,
        lastAlertAtMs: null,
        extremeStreak: 1,
        extremeStreakStartPrice: ticker.lastPrice,
        lastObservedFundingWindowKey: fundingWindowKey,
        lastAlertFundingWindowKey: null,
        isCurrentlyExtreme: true,
      };
      continue;
    }

    const previousWindowKey = existing.lastObservedFundingWindowKey;
    const windowAdvanced =
      previousWindowKey !== null && fundingWindowKey !== null && fundingWindowKey !== previousWindowKey;

    existing.fundingRate = ticker.fundingRate;
    existing.threshold = threshold;
    existing.fundingIntervalMinutes = fundingIntervalMinutes;
    existing.settlementLabel = settlementLabel;
    existing.lastPrice = ticker.lastPrice;
    existing.isCurrentlyExtreme = currentlyExtreme;
    if (fundingWindowKey !== null) {
      existing.lastObservedFundingWindowKey = fundingWindowKey;
    }

    if (!windowAdvanced) {
      continue;
    }

    if (!currentlyExtreme) {
      existing.extremeStreak = 0;
      existing.extremeStreakStartPrice = null;
      existing.firstTriggeredAtMs = null;
      continue;
    }

    const previousWindowWasExtreme =
      existing.lastAlertFundingWindowKey !== null &&
      previousWindowKey !== null &&
      existing.lastAlertFundingWindowKey === previousWindowKey;
    const consecutiveWindow = isConsecutiveFundingWindow(previousWindowKey, fundingWindowKey, fundingIntervalMinutes);

    if (previousWindowWasExtreme && consecutiveWindow && existing.extremeStreak > 0) {
      existing.extremeStreak += 1;
    } else {
      existing.extremeStreak = 1;
      existing.extremeStreakStartPrice = ticker.lastPrice;
      existing.firstTriggeredAtMs = context.nowMs;
    }

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
        triggerReason: "extreme at funding window close",
        triggeredAtMs: existing.firstTriggeredAtMs ?? context.nowMs,
        alertPrice: ticker.lastPrice,
        priceChangeSinceLastNotification,
        extremeStreak: existing.extremeStreak,
        // Legacy key retained for backwards compatibility in any external consumers.
        extremeWindowsInRow: existing.extremeStreak,
        priceChangeSinceFirstNotificationInStreak,
        markPrice: ticker.markPrice,
        nextFundingTimeMs: ticker.nextFundingTimeMs,
      },
    });
    existing.lastAlertPrice = ticker.lastPrice;
    existing.lastAlertAtMs = context.nowMs;
    existing.lastAlertFundingWindowKey = fundingWindowKey;
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
    const firstTriggeredAtMs =
      typeof tracker.firstTriggeredAtMs === "number" && Number.isFinite(tracker.firstTriggeredAtMs)
        ? tracker.firstTriggeredAtMs
        : typeof (tracker as { triggeredAtMs?: unknown }).triggeredAtMs === "number" &&
            Number.isFinite((tracker as { triggeredAtMs?: number }).triggeredAtMs)
          ? ((tracker as { triggeredAtMs?: number }).triggeredAtMs ?? null)
          : null;
    const lastPrice = typeof tracker.lastPrice === "number" && Number.isFinite(tracker.lastPrice) ? tracker.lastPrice : null;
    const lastAlertPrice =
      typeof tracker.lastAlertPrice === "number" && Number.isFinite(tracker.lastAlertPrice)
        ? tracker.lastAlertPrice
        : lastPrice;
    const lastAlertAtMs =
      typeof tracker.lastAlertAtMs === "number" && Number.isFinite(tracker.lastAlertAtMs)
        ? tracker.lastAlertAtMs
        : firstTriggeredAtMs;
    const extremeStreak =
      typeof tracker.extremeStreak === "number" && Number.isFinite(tracker.extremeStreak)
        ? Math.max(0, Math.floor(tracker.extremeStreak))
        : typeof (tracker as { extremeWindowsInRow?: unknown }).extremeWindowsInRow === "number" &&
            Number.isFinite((tracker as { extremeWindowsInRow?: number }).extremeWindowsInRow)
          ? Math.max(0, Math.floor((tracker as { extremeWindowsInRow?: number }).extremeWindowsInRow ?? 0))
          : 0;
    const extremeStreakStartPrice =
      typeof tracker.extremeStreakStartPrice === "number" && Number.isFinite(tracker.extremeStreakStartPrice)
        ? tracker.extremeStreakStartPrice
        : lastAlertPrice;
    const lastObservedFundingWindowKey =
      typeof tracker.lastObservedFundingWindowKey === "number" && Number.isFinite(tracker.lastObservedFundingWindowKey)
        ? tracker.lastObservedFundingWindowKey
        : typeof (tracker as { lastFundingWindowKey?: unknown }).lastFundingWindowKey === "number" &&
            Number.isFinite((tracker as { lastFundingWindowKey?: number }).lastFundingWindowKey)
          ? ((tracker as { lastFundingWindowKey?: number }).lastFundingWindowKey ?? null)
          : null;
    const lastAlertFundingWindowKey =
      typeof tracker.lastAlertFundingWindowKey === "number" && Number.isFinite(tracker.lastAlertFundingWindowKey)
        ? tracker.lastAlertFundingWindowKey
        : lastObservedFundingWindowKey;
    const isCurrentlyExtreme =
      tracker.isCurrentlyExtreme === true ||
      (typeof tracker.isCurrentlyExtreme !== "boolean" && isExtremeFunding(fundingRate, threshold));

    trackers[symbol] = {
      symbol,
      fundingRate,
      threshold,
      fundingIntervalMinutes,
      settlementLabel,
      firstTriggeredAtMs,
      lastPrice,
      lastAlertPrice,
      lastAlertAtMs,
      extremeStreak,
      extremeStreakStartPrice,
      lastObservedFundingWindowKey,
      lastAlertFundingWindowKey,
      isCurrentlyExtreme,
    };
  }
}

export function listExtremeFundingTrackedSetups(): StrategyTrackedSetup[] {
  return Object.values(trackers)
    .filter((tracker) => tracker.isCurrentlyExtreme)
    .map((tracker) => ({
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
        triggeredAtMs: tracker.firstTriggeredAtMs,
        lastPrice: tracker.lastPrice,
        lastAlertPrice: tracker.lastAlertPrice,
        lastAlertAtMs: tracker.lastAlertAtMs,
        extremeStreak: tracker.extremeStreak,
        // Legacy key retained for backwards compatibility in any external consumers.
        extremeWindowsInRow: tracker.extremeStreak,
        priceChangeSinceLastNotification: pctOrNull(tracker.lastAlertPrice, tracker.lastPrice),
        priceChangeSinceFirstNotificationInStreak: pctOrNull(tracker.extremeStreakStartPrice, tracker.lastPrice),
      },
      updatedAtMs: tracker.lastAlertAtMs ?? tracker.firstTriggeredAtMs ?? Date.now(),
    }));
}
