/**
 * Extreme sell-pressure v6.4 message formatter.
 */
import type { StrategySignal } from "../../core/domain/types.js";
import { formatSymbolLink } from "../../core/utils/telegramSymbolLink.js";

type ExtremeSellPressureEventType =
  | "ENTRY_OPEN_SHORT"
  | "ENTRY_REPLACE_OPEN_SHORT"
  | "EXIT_TP"
  | "EXIT_TIME"
  | "EXIT_LIQUIDATED"
  | "EXIT_REPLACE_STOP";

interface TotalsPayload {
  entries: number;
  missedTrades: number;
  winners: number;
  losers: number;
  liquidated: number;
  replaced: number;
  openPositions: number;
  startingEquityUsd: number;
  cashUsd: number;
  marginInUseUsd: number;
  openNotionalUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  currentEquityUsd: number;
  totalPnlUsd: number;
  pnlPct: number;
  winPct: number;
}

const STRATEGY_TITLE = "Extreme Sell Pressure";

function readEventType(signal: StrategySignal): ExtremeSellPressureEventType | null {
  const raw = signal.data.eventType;
  if (
    raw === "ENTRY_OPEN_SHORT" ||
    raw === "ENTRY_REPLACE_OPEN_SHORT" ||
    raw === "EXIT_TP" ||
    raw === "EXIT_TIME" ||
    raw === "EXIT_LIQUIDATED" ||
    raw === "EXIT_REPLACE_STOP"
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
      openPositions: 0,
      startingEquityUsd: 0,
      cashUsd: 0,
      marginInUseUsd: 0,
      openNotionalUsd: 0,
      unrealizedPnlUsd: 0,
      realizedPnlUsd: 0,
      currentEquityUsd: 0,
      totalPnlUsd: 0,
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
    openPositions: Math.max(0, Math.floor(asFiniteNumber(obj.openPositions) ?? 0)),
    startingEquityUsd: asFiniteNumber(obj.startingEquityUsd) ?? 0,
    cashUsd: asFiniteNumber(obj.cashUsd) ?? 0,
    marginInUseUsd: asFiniteNumber(obj.marginInUseUsd) ?? 0,
    openNotionalUsd: asFiniteNumber(obj.openNotionalUsd) ?? 0,
    unrealizedPnlUsd: asFiniteNumber(obj.unrealizedPnlUsd) ?? 0,
    realizedPnlUsd: asFiniteNumber(obj.realizedPnlUsd) ?? 0,
    currentEquityUsd: asFiniteNumber(obj.currentEquityUsd) ?? 0,
    totalPnlUsd: asFiniteNumber(obj.totalPnlUsd) ?? 0,
    pnlPct: asFiniteNumber(obj.pnlPct) ?? 0,
    winPct: asFiniteNumber(obj.winPct) ?? 0,
  };
}

function totalsBlock(signal: StrategySignal): string[] {
  const totals = readTotals(signal);
  const equityText = `$${totals.currentEquityUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const cashText = `$${totals.cashUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const marginText = `$${totals.marginInUseUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const notionalText = `$${totals.openNotionalUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const unrealizedText = `${totals.unrealizedPnlUsd > 0 ? "+" : ""}$${totals.unrealizedPnlUsd.toLocaleString("en-US", {
    maximumFractionDigits: 2,
  })}`;
  const totalPnlUsdText = `${totals.totalPnlUsd > 0 ? "+" : ""}$${totals.totalPnlUsd.toLocaleString("en-US", {
    maximumFractionDigits: 2,
  })}`;
  return [
    "Totals:",
    `Entries: ${totals.entries}`,
    `Missed Trades: ${totals.missedTrades}`,
    `Winners: ${totals.winners}`,
    `Losers: ${totals.losers}`,
    `Liquidated: ${totals.liquidated}`,
    `Replaced: ${totals.replaced}`,
    `Open Positions: ${totals.openPositions}`,
    `Current Equity: ${equityText}`,
    `Cash: ${cashText}`,
    `Margin In Use: ${marginText}`,
    `Open Notional: ${notionalText}`,
    `Unrealized PnL: ${unrealizedText}`,
    `PnL (vs start): ${fmtSignedPercent(totals.pnlPct)} | ${totalPnlUsdText}`,
    `Win %: ${fmtPercent(totals.winPct)}`,
  ];
}

function strategyHeader(): string[] {
  return [`🚨 <b>${STRATEGY_TITLE}</b>`, ""];
}

function formatEntryOpenShortMessage(signal: StrategySignal): string {
  return [
    ...strategyHeader(),
    "📉 <b>ENTRY OPEN SHORT</b>",
    formatSymbolLink("bybit", signal.symbol),
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
    ...strategyHeader(),
    "♻️ <b>ENTRY REPLACE SHORT</b>",
    formatSymbolLink("bybit", signal.symbol),
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
    ...strategyHeader(),
    header,
    formatSymbolLink("bybit", signal.symbol),
    `PnL: ${fmtSignedPercent(signal.data.leveragedReturnPct)}`,
    `Leverage: ${fmtNumber(signal.data.leverage, 2)}x | Unlev: ${fmtSignedPercent(signal.data.unleveredReturnPct)}`,
    "",
    ...totalsBlock(signal),
  ].join("\n");
}

export function formatExtremeSellPressureV64Messages(signals: StrategySignal[]): string[] {
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
    if (eventType === "EXIT_REPLACE_STOP") {
      continue;
    }

    out.push(formatExitMessage(signal));
  }
  return out;
}
