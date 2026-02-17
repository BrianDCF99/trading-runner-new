/**
 * Shared Telegram HTML helpers for ticker links.
 */
import type { ExchangeName } from "../domain/types.js";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function resolveTickerUrl(exchange: ExchangeName, symbol: string): string {
  const template = process.env.TELEGRAM_TICKER_URL_TEMPLATE?.trim();
  if (template && template.length > 0) {
    return template
      .replaceAll("{symbol}", encodeURIComponent(symbol))
      .replaceAll("{exchange}", encodeURIComponent(exchange));
  }
  if (exchange === "bybit") {
    return `https://www.bybit.com/trade/usdt/${encodeURIComponent(symbol)}`;
  }
  return `https://www.bybit.com/trade/usdt/${encodeURIComponent(symbol)}`;
}

export function formatSymbolLink(exchange: ExchangeName, symbol: string): string {
  const escapedUrl = escapeHtml(resolveTickerUrl(exchange, symbol));
  const escapedSymbol = escapeHtml(symbol);
  return `<b><a href="${escapedUrl}">${escapedSymbol}</a></b>`;
}
