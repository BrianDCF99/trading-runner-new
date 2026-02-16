# strategies

Each strategy lives in its own folder and is loaded dynamically from YAML.

Contract per strategy folder:

- `index.ts` exports `createStrategyModule()`
- `logic.ts` contains strategy logic only
- `messages.ts` contains Telegram formatting only
- `strategy.md` is the source strategy document
- `README.md` documents implementation choices
