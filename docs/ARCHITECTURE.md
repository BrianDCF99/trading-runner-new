# Architecture

## Goals

- Isolated strategies with zero runtime coupling.
- YAML-driven strategy activation.
- SRP-first file boundaries.
- Deployment-safe, readable structure.

## Runtime Flow

1. `src/main.ts` bootstraps the app.
2. `src/config/*` loads and validates YAML.
3. `src/core/services/strategyLoader.ts` dynamically loads enabled strategies.
4. `src/core/services/runner.ts` executes scan cycles and writes parity lifecycle data.
5. `src/core/services/telegramCommandRouter.ts` handles Telegram commands/callbacks.
6. `src/infrastructure/notifications/telegramNotifier.ts` sends alerts, interactive prompts, and polls updates.
7. `src/infrastructure/storage/supabaseStateStore.ts` persists strategy tracker state snapshots (`strategy_trackers`).
8. `src/infrastructure/storage/supabaseRuntimeStore.ts` persists runtime data (`signals`, `engine_status`, `scanner_runs`, `setup_execution_decisions`).

## Telegram Commands

- `/ping`: liveness check.
- `/status`: latest cycle heartbeat/error/status.
- `/ready`: top ready setups.
- `/scan`: manual scan trigger.
- `/new`: new-listing watching snapshot.
- `/funding`: funding watching snapshot.
- `/watching <new|funding>`: legacy alias.
- `/positions`: member-scoped positions based on filled confirmations.
- `/refresh`: resend pending ready confirmation prompts.

## Strategy Contract

Each strategy directory must export `createStrategyModule()` from `index.ts` and keep:

- `strategy.md` (human strategy doc)
- `logic.ts` (signal logic)
- `messages.ts` (strategy-specific message formatting)
- `README.md` (strategy-local implementation notes)

Optional strategy exports:

- `listTrackedSetups()` for command/query parity without coupling to strategy internals.
- `strategyIds` for strategy-config parity with legacy `strategy_configs` table.
- `trackerStateKey` for legacy tracker-key compatibility.
