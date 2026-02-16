# trading-runner-new

Refactored runner with modular strategy loading, Telegram control-plane parity, and deployment-ready runtime state persistence.

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Required env vars for parity mode:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## Command Parity

The new runner now supports:

- `/ping`
- `/status`
- `/ready`
- `/scan`
- `/new`
- `/funding`
- `/watching`
- `/positions`
- `/refresh`

Every outbound Telegram message is prefixed with `NEW` so you can distinguish it from the legacy runner.

## Runtime Persistence

State is persisted in Supabase (same tables/flow as legacy runner), including:

- `signals`
- `engine_status`
- `scanner_runs`
- `setup_execution_decisions`
- `strategy_trackers`
- `strategy_configs` (for enable/disable behavior)

## Core Design

- Strategy activation stays YAML-driven (`config/app.yaml`).
- Each strategy remains isolated under `src/strategies/<strategy-name>/`.
- Runtime orchestration and Telegram command routing are separated into services.
- Infrastructure adapters (market, notifications, storage) stay behind ports.
- Command features use runtime snapshots, not strategy-internal coupling.
