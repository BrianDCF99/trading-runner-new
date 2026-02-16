# Adding a New Strategy

## 1. Create a strategy folder

Create a new folder in `src/strategies/<your-strategy-name>/`.

Required files:

- `index.ts`
- `logic.ts`
- `messages.ts`
- `strategy.md`
- `README.md`

## 2. Export strategy module

`index.ts` must export:

```ts
export function createStrategyModule(...) { ... }
```

Optional for command/query parity:

```ts
listTrackedSetups(): StrategyTrackedSetup[]
```

## 3. Register in YAML

Edit `config/app.yaml` and add one item under `strategies:`:

```yaml
- id: exchange:your-strategy:v1
  enabled: true
  directory: your-strategy-name
```

No runtime code changes are required.

## 4. Start runner

```bash
npm run dev
```

The runner will dynamically load the strategy directory and execute it on each cycle.
