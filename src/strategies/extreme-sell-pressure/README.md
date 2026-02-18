# extreme-sell-pressure

Live strategy module for the v9 core extreme sell-pressure winner profile.

Folder contract:

- `index.ts` module wiring
- `config.ts` strategy parameters
- `logic.ts` state machine and portfolio overlay
- `messages.ts` Telegram formatting
- `strategy.md` strategy spec summary

Implementation notes:

- Trigger uses Bybit account-ratio (`period=1h`) + latest 1h kline volume.
- Exits run before new entries each cycle.
- Open positions are capped at 15.
- Signals are skipped when the same symbol is already open (`preventDuplicateSymbolEntries=true`).
- At capacity, a new valid signal can replace the worst position if mark return is `<= -5%`.
- Replacement emits one alert (`ENTRY REPLACE SHORT`) containing old/new trade details.
- `config.testing.eventDrivenTotals` keeps live totals updated from alert-flow events.
- State is restart-safe through `exportState`/`hydrateState`.

Runtime parameter overrides (env):

- `ESP_V9_LEVERAGE` (default `5`)
- `ESP_V9_STARTING_EQUITY_USD` (default `10000`)
- `ESP_V9_ENTRY_MARGIN_PCT` (default `1` or `0.01`)
- `ESP_V9_RESET_TOTALS_ON_HYDRATE` (`true`/`false`, default `false`) to zero entries/win/loss/pnl totals at startup while keeping open positions
- `ESP_V9_TAKE_PROFIT_PCT` (default `4` or `0.04`)
- `ESP_V9_REPLACE_LOSING_THRESHOLD_PCT` (default `5` or `0.05`)
- `ESP_V9_MAX_HOLD_HOURS` (default `48`)
- `ESP_V9_MAX_OPEN_POSITIONS` (default `15`)
- `ESP_V9_PREVENT_DUPLICATE_SYMBOL_ENTRIES` (`true`/`false`, default `true`)
- `ESP_V9_SELL_RATIO_MAX` (default `0.2`)
- `ESP_V9_MIN_HOUR_VOLUME` (default `1000000`)

Legacy env names (`ESP_V64_*`, `ESP_V43_*`) are accepted as fallbacks for migration safety.
