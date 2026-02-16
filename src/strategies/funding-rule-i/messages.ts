/**
 * Funding Rule I strategy message formatter.
 */
import type { StrategySignal } from "../../core/domain/types.js";

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

export function formatFundingMessages(signals: StrategySignal[]): string[] {
  const out: string[] = [];
  for (const signal of signals) {
    // READY alert template.
    if (signal.phase === "READY") {
      out.push(
        [
          `💸 <b>READY</b>`,
          `<b>${signal.symbol}</b>`,
          `Funding: ${fmtPercent(signal.data.fundingRate)}`,
          `Alert Price: ${fmtPrice(signal.data.alertPrice)}`,
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
          `<b>${signal.symbol}</b>`,
          `Funding: ${fmtPercent(signal.data.fundingRate)}`,
          `Strategy: ${signal.strategyName}`,
        ].join("\n")
      );
    }
  }
  return out;
}
