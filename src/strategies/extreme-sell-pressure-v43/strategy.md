# Extreme Sell Pressure v4.3 (Live Module)

## Trigger

- Sell ratio (`account-ratio`, 1h period) `<= 0.20`
- Latest 1h candle volume `>= 1,000,000`
- Direction: short

## Entry

- Opens a short-position tracker at current mark price.
- Portfolio cap: max 15 concurrent open positions.
- Duplicate-symbol protection is enabled by default, so new signals are skipped when the same symbol is already open.

## Exit

Exit order precedence:

1. Liquidation threshold reached
2. Take-profit reached (4% favorable underlying move)
3. Max hold reached (48h)

## Replacement Rule

When portfolio is at capacity and a new valid signal arrives:

- Evaluate mark return for each open position.
- If any position has mark return `<= -5%`, close the worst one and open the new signal.
- Forced replacement close is recorded as `-5%` leveraged return.

## State

Persists:

- Open positions
- Per-symbol processed sell-ratio timestamps
- Scan cursor and next position id

## Telegram

- Entry alerts for normal opens and replacement opens
- Exit alerts for TP / TIME / LIQ
- Replacement close is folded into `ENTRY REPLACE SHORT` (single replacement alert)
- Tickers are rendered as clickable links.
- All alerts include live totals: entries, missed trades, winners, losers, liquidated, replaced, pnl, win%.
