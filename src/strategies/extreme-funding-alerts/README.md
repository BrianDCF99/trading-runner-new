# extreme-funding-alerts

Alerts when funding reaches strategy-defined extreme negatives:

- 1h settlement contracts: funding <= -0.50%
- all other settlement intervals: funding <= -1.00%

Folder contract:

- `index.ts`: strategy module boundary
- `logic.ts`: threshold evaluation + active alert tracking
- `messages.ts`: Telegram alert formatting
- `config.ts`: strategy ids and thresholds
- `strategy.md`: source strategy rule
