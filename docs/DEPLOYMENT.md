# Deployment

## Prereqs

- Node.js 22+
- Valid `.env` with:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_CHAT_ID`
  - optional overrides like `BYBIT_API_BASE`

## Local Service (system process)

1. Install and build:

```bash
npm install
npm run build
```

2. Run:

```bash
npm start
```

3. Verify on Telegram:

- `/ping`
- `/status`
- `/new`
- `/funding`
- `/xfund`

All replies should include `NEW`.

## Runtime Persistence

The runner persists state in Supabase tables:

- `strategy_trackers`
- `signals`
- `engine_status`
- `scanner_runs`
- `setup_execution_decisions`
