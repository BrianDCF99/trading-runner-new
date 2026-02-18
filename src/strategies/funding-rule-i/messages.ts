/**
 * Funding Rule I strategy message formatter.
 */
import type { StrategySignal } from "../../core/domain/types.js";
import { formatSymbolLink } from "../../core/utils/telegramSymbolLink.js";

function fmtPercent(value: unknown): string {
  // Render percentages consistently and guard invalid values.
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(3)}%`;
}

function fmtPrice(value: unknown): string {
  // Render alert price with readable precision.
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function fmtHoursToClose(closeDueAtMs: unknown, nowMs: number): string {
  // Convert absolute close timestamp into remaining-hour display.
  if (typeof closeDueAtMs !== "number" || !Number.isFinite(closeDueAtMs)) return "n/a";
  const hours = Math.max(0, (closeDueAtMs - nowMs) / (60 * 60 * 1000));
  return `${hours.toFixed(2)}h`;
}

function fmtSignedPercent(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  const pct = value * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function fmtWindows(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${Math.max(0, Math.floor(value))}`;
}

export function formatFundingMessages(signals: StrategySignal[]): string[] {
  const out: string[] = [];
  for (const signal of signals) {
    // READY alert template.
    if (signal.phase === "READY") {
      out.push(
        [
          `💸 <b>READY</b>`,
          formatSymbolLink("bybit", signal.symbol),
          `Funding: ${fmtPercent(signal.data.fundingRate)}`,
          `Alert Price: ${fmtPrice(signal.data.alertPrice)}`,
          `Δ Since Last Alert: ${fmtSignedPercent(signal.data.priceChangeSinceLastNotification)}`,
          `Extreme Windows In Row: ${fmtWindows(signal.data.extremeWindowsInRow)}`,
          `Δ Since Streak Start: ${fmtSignedPercent(signal.data.priceChangeSinceFirstNotificationInStreak)}`,
          `Time To Close: ${fmtHoursToClose(signal.data.closeDueAtMs, signal.generatedAtMs)}`,
          `Strategy: ${signal.strategyName}`,
        ].join("\n")
      );
      continue;
    }

    // CLOSED alert template.
    if (signal.phase === "CLOSED") {
      out.push(
        [
          `✅ <b>CLOSED</b>`,
          formatSymbolLink("bybit", signal.symbol),
          `Funding: ${fmtPercent(signal.data.fundingRate)}`,
          `Δ Since Last Alert: ${fmtSignedPercent(signal.data.priceChangeSinceLastNotification)}`,
          `Extreme Windows In Row: ${fmtWindows(signal.data.extremeWindowsInRow)}`,
          `Δ Since Streak Start: ${fmtSignedPercent(signal.data.priceChangeSinceFirstNotificationInStreak)}`,
          `Strategy: ${signal.strategyName}`,
        ].join("\n")
      );
    }
  }
  return out;
}
