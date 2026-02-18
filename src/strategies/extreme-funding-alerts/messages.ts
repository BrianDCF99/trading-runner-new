/**
 * Extreme funding alert strategy message formatter.
 */
import type { StrategySignal } from "../../core/domain/types.js";
import { formatSymbolLink } from "../../core/utils/telegramSymbolLink.js";

function fmtPercent(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(3)}%`;
}

function fmtPrice(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function fmtSignedPercent(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  const pct = value * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function fmtStreak(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${Math.max(0, Math.floor(value))}`;
}

function resolveStreak(signal: StrategySignal): unknown {
  if (typeof signal.data.extremeStreak === "number" && Number.isFinite(signal.data.extremeStreak)) {
    return signal.data.extremeStreak;
  }
  return signal.data.extremeWindowsInRow;
}

function toHourClock(totalMinutes: number): string {
  const roundedMinutes = Math.max(0, Math.floor(totalMinutes));
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  if (minutes === 0) return `${hours}h`;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function fmtFundingInterval(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "unknown";
  return toHourClock(value);
}

function resolveSettlementLabel(signal: StrategySignal): string {
  const byInterval = fmtFundingInterval(signal.data.fundingIntervalMinutes);
  if (byInterval !== "unknown") return byInterval;
  const raw = signal.data.settlementLabel;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return "unknown";
}

export function formatExtremeFundingMessages(signals: StrategySignal[]): string[] {
  const out: string[] = [];
  for (const signal of signals) {
    if (signal.phase !== "ALERT") continue;
    out.push(
      [
        `🚨 <b>EXTREME FUNDING</b>`,
        formatSymbolLink("bybit", signal.symbol),
        `Funding: ${fmtPercent(signal.data.fundingRate)}`,
        `Settlement: ${resolveSettlementLabel(signal)}`,
        `Alert Price: ${fmtPrice(signal.data.alertPrice)}`,
        `Δ Since Last Alert: ${fmtSignedPercent(signal.data.priceChangeSinceLastNotification)}`,
        `Extreme Streak: ${fmtStreak(resolveStreak(signal))}`,
        `Δ Since Streak Start: ${fmtSignedPercent(signal.data.priceChangeSinceFirstNotificationInStreak)}`,
        `Mark Price: ${fmtPrice(signal.data.markPrice)}`,
        `Strategy: ${signal.strategyName}`,
      ].join("\n")
    );
  }
  return out;
}
