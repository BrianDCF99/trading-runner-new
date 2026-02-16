# long25-suite

Implements the long strategy from the `V_vol25_min1_max12` spec image, with the explicit change requested:

- `max 12h cap` is **not implemented**.

Files:

- `index.ts`: strategy module boundary.
- `logic.ts`: state machine and signal generation.
- `messages.ts`: Telegram alert templates.
- `config.ts`: all mutable strategy parameters.
- `strategy.md`: strategy rule source.
