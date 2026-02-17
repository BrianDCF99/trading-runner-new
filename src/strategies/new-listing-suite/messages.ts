/**
 * New listing strategy message formatter.
 */
import type { StrategySignal } from "../../core/domain/types.js";
import { escapeHtml, formatSymbolLink } from "../../core/utils/telegramSymbolLink.js";

type ListingEventType =
  | "LISTING_RELEASED"
  | "CHECKPOINT_4H_LEG1_READY"
  | "CHECKPOINT_4H_WATCH_S7"
  | "CHECKPOINT_8H_LEG2_READY"
  | "CHECKPOINT_8H_S7_READY"
  | "FORCED_CLOSE_14D";

function fmtPercent(value: unknown): string {
  // Percent formatter with invalid-value fallback.
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(2)}%`;
}

function fmtUsd(value: unknown, maxFractionDigits = 8): string {
  // Price formatter for listing/checkpoint values.
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: maxFractionDigits })}`;
}

function readEventType(signal: StrategySignal): ListingEventType | null {
  const value = signal.data.eventType;
  if (typeof value !== "string") return null;
  if (
    value === "LISTING_RELEASED" ||
    value === "CHECKPOINT_4H_LEG1_READY" ||
    value === "CHECKPOINT_4H_WATCH_S7" ||
    value === "CHECKPOINT_8H_LEG2_READY" ||
    value === "CHECKPOINT_8H_S7_READY" ||
    value === "FORCED_CLOSE_14D"
  ) {
    return value;
  }
  return null;
}

function formatReleaseMessage(signal: StrategySignal): string {
  return [
    "📡 <b>Bybit New Listing Detected</b>",
    formatSymbolLink("bybit", signal.symbol),
    `Listing price: ${fmtUsd(signal.data.listingPrice)}`,
    `Turnover_1h snapshot: ${fmtUsd(signal.data.turnover1h, 2)}`,
    "Status: <b>WATCHING</b>",
  ].join("\n");
}

function format4hLeg1Message(signal: StrategySignal): string {
  return [
    "⏱️ <b>4H Checkpoint</b>",
    formatSymbolLink("bybit", signal.symbol),
    "Result: <b>LEG1 QUALIFIED</b>",
    `ret_4h: ${fmtPercent(signal.data.ret4h)} | turnover_1h: ${fmtUsd(signal.data.turnover1h, 2)}`,
    "Next: evaluate LEG2 at 8h",
  ].join("\n");
}

function format4hWatchMessage(signal: StrategySignal): string {
  const detail = typeof signal.data.eventDetail === "string" ? signal.data.eventDetail : "LEG1 conditions not met.";
  return [
    "⏱️ <b>4H Checkpoint</b>",
    formatSymbolLink("bybit", signal.symbol),
    "Result: <b>LEG1 NOT QUALIFIED</b>",
    "Action: <b>WATCH S7 AT 8H</b>",
    `ret_4h: ${fmtPercent(signal.data.ret4h)} | max_pump_4h: ${fmtPercent(signal.data.pump4h)}`,
    `Reason: ${escapeHtml(detail)}`,
  ].join("\n");
}

function format8hLeg2Message(signal: StrategySignal): string {
  return [
    "⏱️ <b>8H Checkpoint</b>",
    formatSymbolLink("bybit", signal.symbol),
    "Result: <b>LEG2 QUALIFIED</b>",
    `ret_8h: ${fmtPercent(signal.data.ret8h)}`,
  ].join("\n");
}

function format8hS7Message(signal: StrategySignal): string {
  return [
    "⏱️ <b>8H Checkpoint</b>",
    formatSymbolLink("bybit", signal.symbol),
    "Result: <b>S7 QUALIFIED</b>",
    `ret_8h: ${fmtPercent(signal.data.ret8h)} | max_pump_4h: ${fmtPercent(signal.data.pump4h)}`,
  ].join("\n");
}

function formatForcedCloseMessage(signal: StrategySignal): string {
  return [
    "🔵 <b>14D Close Window</b>",
    formatSymbolLink("bybit", signal.symbol),
    "Result: <b>CLOSED</b>",
    "Reason: 14-day max hold reached",
  ].join("\n");
}

export function formatNewListingMessages(signals: StrategySignal[]): string[] {
  const lines: string[] = [];
  for (const signal of signals) {
    const eventType = readEventType(signal);
    if (eventType === "LISTING_RELEASED") {
      lines.push(formatReleaseMessage(signal));
      continue;
    }
    if (eventType === "CHECKPOINT_4H_LEG1_READY") {
      lines.push(format4hLeg1Message(signal));
      continue;
    }
    if (eventType === "CHECKPOINT_4H_WATCH_S7") {
      lines.push(format4hWatchMessage(signal));
      continue;
    }
    if (eventType === "CHECKPOINT_8H_LEG2_READY") {
      lines.push(format8hLeg2Message(signal));
      continue;
    }
    if (eventType === "CHECKPOINT_8H_S7_READY") {
      lines.push(format8hS7Message(signal));
      continue;
    }
    if (eventType === "FORCED_CLOSE_14D" || signal.phase === "CLOSED") {
      lines.push(formatForcedCloseMessage(signal));
      continue;
    }
  }
  return lines;
}
