/**
 * Extreme sell-pressure v4.3 message formatter.
 */
import type { StrategySignal } from "../../core/domain/types.js";
import { escapeHtml, formatSymbolLink } from "../../core/utils/telegramSymbolLink.js";

type ExtremeSellPressureEventType =
  | "ENTRY_OPEN_SHORT"
  | "ENTRY_REPLACE_OPEN_SHORT"
  | "EXIT_TP"
  | "EXIT_TIME"
  | "EXIT_LIQUIDATED"
  | "EXIT_REPLACE_STOP_40";

interface TotalsPayload {
  entries: number;
  missedTrades: number;
  winners: number;
  losers: number;
  liquidated: number;
  replaced: number;
  pnlPct: number;
  winPct: number;
}

function readEventType(signal: StrategySignal): ExtremeSellPressureEventType | null {
  const raw = signal.data.eventType;
  if (
    raw === "ENTRY_OPEN_SHORT" ||
    raw === "ENTRY_REPLACE_OPEN_SHORT" ||
    raw === "EXIT_TP" ||
    raw === "EXIT_TIME" ||
    raw === "EXIT_LIQUIDATED" ||
    raw === "EXIT_REPLACE_STOP_40"
  ) {
    return raw;
  }
  return null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function fmtSignedPercent(value: unknown, digits = 2): string {
  const parsed = asFiniteNumber(value);
  if (parsed === null) return "n/a";
  const sign = parsed > 0 ? "+" : "";
  return `${sign}${parsed.toFixed(digits)}%`;
}

function fmtPercent(value: unknown, digits = 2): string {
  const parsed = asFiniteNumber(value);
  if (parsed === null) return "n/a";
  return `${parsed.toFixed(digits)}%`;
}

function fmtRatio(value: unknown, digits = 3): string {
  const parsed = asFiniteNumber(value);
  if (parsed === null) return "n/a";
  return parsed.toFixed(digits);
}

function fmtNumber(value: unknown, digits = 2): string {
  const parsed = asFiniteNumber(value);
  if (parsed === null) return "n/a";
  return parsed.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function fmtUsd(value: unknown): string {
  const parsed = asFiniteNumber(value);
  if (parsed === null) return "n/a";
  return `$${parsed.toLocaleString("en-US", { maximumFractionDigits: 8 })}`;
}

function readTotals(signal: StrategySignal): TotalsPayload {
  const raw = signal.data.totals;
  if (!raw || typeof raw !== "object") {
    return {
      entries: 0,
      missedTrades: 0,
      winners: 0,
      losers: 0,
      liquidated: 0,
      replaced: 0,
      pnlPct: 0,
      winPct: 0,
    };
  }

  const obj = raw as Record<string, unknown>;
  return {
    entries: Math.max(0, Math.floor(asFiniteNumber(obj.entries) ?? 0)),
    missedTrades: Math.max(0, Math.floor(asFiniteNumber(obj.missedTrades) ?? 0)),
    winners: Math.max(0, Math.floor(asFiniteNumber(obj.winners) ?? 0)),
    losers: Math.max(0, Math.floor(asFiniteNumber(obj.losers) ?? 0)),
    liquidated: Math.max(0, Math.floor(asFiniteNumber(obj.liquidated) ?? 0)),
    replaced: Math.max(0, Math.floor(asFiniteNumber(obj.replaced) ?? 0)),
    pnlPct: asFiniteNumber(obj.pnlPct) ?? 0,
    winPct: asFiniteNumber(obj.winPct) ?? 0,
  };
}

function totalsBlock(signal: StrategySignal): string[] {
  const totals = readTotals(signal);
  return [
    "Totals:",
    `Entries: ${totals.entries}`,
    `Missed Trades: ${totals.missedTrades}`,
    `Winners: ${totals.winners}`,
    `Losers: ${totals.losers}`,
    `Liquidated: ${totals.liquidated}`,
    `Replaced: ${totals.replaced}`,
    `PnL: ${fmtSignedPercent(totals.pnlPct)}`,
    `Win %: ${fmtPercent(totals.winPct)}`,
  ];
}

function formatEntryOpenShortMessage(signal: StrategySignal): string {
  return [
    "📉 <b>ENTRY OPEN SHORT</b>",
    formatSymbolLink("bybit", signal.symbol),
    `Strategy: ${escapeHtml(signal.strategyName)}`,
    `Entry Cond 1: Sell Ratio <= ${fmtRatio(signal.data.sellRatioThreshold)} (now ${fmtRatio(signal.data.sellRatio)})`,
    `Entry Cond 2: 1h Volume >= ${fmtNumber(signal.data.volumeThreshold, 0)} (now ${fmtNumber(signal.data.hourVolume, 0)})`,
    `Entry Price: ${fmtUsd(signal.data.entryPrice)}`,
    `Take Profit Price: ${fmtUsd(signal.data.takeProfitPrice)}`,
    "Mood: pressure is building, stay sharp.",
    "",
    ...totalsBlock(signal),
  ].join("\n");
}

function formatEntryReplaceShortMessage(signal: StrategySignal): string {
  const replacedSymbol =
    typeof signal.data.replacedSymbol === "string" && signal.data.replacedSymbol.trim().length > 0
      ? signal.data.replacedSymbol.trim()
      : null;

  return [
    "♻️ <b>ENTRY REPLACE SHORT</b>",
    formatSymbolLink("bybit", signal.symbol),
    `Strategy: ${escapeHtml(signal.strategyName)}`,
    `Entry Cond 1: Sell Ratio <= ${fmtRatio(signal.data.sellRatioThreshold)} (now ${fmtRatio(signal.data.sellRatio)})`,
    `Entry Cond 2: 1h Volume >= ${fmtNumber(signal.data.volumeThreshold, 0)} (now ${fmtNumber(signal.data.hourVolume, 0)})`,
    `Entry Price: ${fmtUsd(signal.data.entryPrice)}`,
    `Take Profit Price: ${fmtUsd(signal.data.takeProfitPrice)}`,
    replacedSymbol ? `Old Ticker: ${formatSymbolLink("bybit", replacedSymbol)}` : "Old Ticker: n/a",
    `Old Trade PnL: ${fmtSignedPercent(signal.data.replacedPnlPct)}`,
    `Old Trade % (${fmtNumber(signal.data.replacedLeverage, 2)}x): ${fmtSignedPercent(signal.data.replacedPnlPct)} | Unlev: ${fmtSignedPercent(signal.data.replacedUnleveredPct)}`,
    "Mood: rotated into fresher downside pressure.",
    "",
    ...totalsBlock(signal),
  ].join("\n");
}

function formatExitMessage(signal: StrategySignal): string {
  const eventType = readEventType(signal);
  const header =
    eventType === "EXIT_TP"
      ? "✅ <b>EXIT TP</b>"
      : eventType === "EXIT_TIME"
        ? "⏱️ <b>EXIT TIME</b>"
        : "🟥 <b>EXIT LIQUIDATED</b>";

  return [
    header,
    formatSymbolLink("bybit", signal.symbol),
    `PnL: ${fmtSignedPercent(signal.data.leveragedReturnPct)}`,
    `% On Trade (${fmtNumber(signal.data.leverage, 2)}x): ${fmtSignedPercent(signal.data.leveragedReturnPct)} | Unlev: ${fmtSignedPercent(signal.data.unleveredReturnPct)}`,
    "Mood: logged and rolling forward.",
    "",
    ...totalsBlock(signal),
  ].join("\n");
}

export function formatExtremeSellPressureV43Messages(signals: StrategySignal[]): string[] {
  const out: string[] = [];
  for (const signal of signals) {
    const eventType = readEventType(signal);
    if (!eventType) continue;

    if (eventType === "ENTRY_OPEN_SHORT") {
      out.push(formatEntryOpenShortMessage(signal));
      continue;
    }

    if (eventType === "ENTRY_REPLACE_OPEN_SHORT") {
      out.push(formatEntryReplaceShortMessage(signal));
      continue;
    }

    // Replacement close is intentionally silent.
    if (eventType === "EXIT_REPLACE_STOP_40") {
      continue;
    }

    out.push(formatExitMessage(signal));
  }
  return out;
}
