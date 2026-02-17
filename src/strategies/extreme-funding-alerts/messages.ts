/**
 * Extreme funding alert strategy message formatter.
 */
import type { StrategySignal } from "../../core/domain/types.js";

function fmtPercent(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(3)}%`;
}

function fmtPrice(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
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
        `<b>${signal.symbol}</b>`,
        `Funding: ${fmtPercent(signal.data.fundingRate)}`,
        `Settlement: ${resolveSettlementLabel(signal)}`,
        `Mark Price: ${fmtPrice(signal.data.markPrice)}`,
        `Strategy: ${signal.strategyName}`,
      ].join("\n")
    );
  }
  return out;
}
