/**
 * Long25 strategy message formatter.
 */
import type { StrategySignal } from "../../core/domain/types.js";

type Long25EventType = "ENTRY_READY" | "EXIT_VOLUME_DROP" | "EXIT_LIQUIDATED";

function fmtPercent(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(2)}%`;
}

function fmtUsd(value: unknown, maxFractionDigits = 8): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: maxFractionDigits })}`;
}

function fmtNumber(value: unknown, digits = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resolveTickerUrl(symbol: string): string {
  const template = process.env.TELEGRAM_TICKER_URL_TEMPLATE?.trim();
  if (template && template.length > 0) {
    return template
      .replaceAll("{symbol}", encodeURIComponent(symbol))
      .replaceAll("{exchange}", encodeURIComponent("bybit"));
  }
  return `https://www.bybit.com/trade/usdt/${encodeURIComponent(symbol)}`;
}

function formatSymbolLink(symbol: string): string {
  return `<b><a href="${escapeHtml(resolveTickerUrl(symbol))}">${escapeHtml(symbol)}</a></b>`;
}

function readEventType(signal: StrategySignal): Long25EventType | null {
  const raw = signal.data.eventType;
  if (raw === "ENTRY_READY" || raw === "EXIT_VOLUME_DROP" || raw === "EXIT_LIQUIDATED") {
    return raw;
  }
  return null;
}

function formatEntryMessage(signal: StrategySignal): string {
  return [
    "🟢 <b>LONG25 READY</b>",
    formatSymbolLink(signal.symbol),
    `Funding hourly equiv: ${fmtPercent(signal.data.fundingHourlyEquiv)}`,
    `Basis: ${fmtPercent(signal.data.basis)}`,
    `Price: ${fmtUsd(signal.data.price)} | 24h VWAP: ${fmtUsd(signal.data.vwap24h)}`,
    `Action: <b>OPEN LONG</b>`,
    `Strategy: ${escapeHtml(signal.strategyName)}`,
  ].join("\n");
}

function formatVolumeExitMessage(signal: StrategySignal): string {
  return [
    "✅ <b>LONG25 EXIT</b>",
    formatSymbolLink(signal.symbol),
    "Reason: volume multiple dropped below threshold",
    `Volume multiple: ${fmtNumber(signal.data.volumeMultiple, 2)}x (threshold ${fmtNumber(signal.data.volumeThreshold, 2)}x)`,
    `Held: ${fmtNumber(signal.data.heldHours, 2)}h`,
    `PnL: ${fmtPercent(signal.data.pnlPct)}`,
    `Strategy: ${escapeHtml(signal.strategyName)}`,
  ].join("\n");
}

function formatLiquidationExitMessage(signal: StrategySignal): string {
  return [
    "🟥 <b>LONG25 LIQUIDATED</b>",
    formatSymbolLink(signal.symbol),
    "Reason: liquidation threshold reached",
    `Exit price: ${fmtUsd(signal.data.exitPrice)} | Liq price: ${fmtUsd(signal.data.liquidationPrice)}`,
    `Held: ${fmtNumber(signal.data.heldHours, 2)}h`,
    `PnL: ${fmtPercent(signal.data.pnlPct)}`,
    `Strategy: ${escapeHtml(signal.strategyName)}`,
  ].join("\n");
}

export function formatLong25Messages(signals: StrategySignal[]): string[] {
  const out: string[] = [];
  for (const signal of signals) {
    const eventType = readEventType(signal);
    if (eventType === "ENTRY_READY") {
      out.push(formatEntryMessage(signal));
      continue;
    }
    if (eventType === "EXIT_VOLUME_DROP") {
      out.push(formatVolumeExitMessage(signal));
      continue;
    }
    if (eventType === "EXIT_LIQUIDATED") {
      out.push(formatLiquidationExitMessage(signal));
    }
  }
  return out;
}
