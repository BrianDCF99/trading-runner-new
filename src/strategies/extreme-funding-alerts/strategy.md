# Extreme Funding Alerts

Purpose: notify when funding is deeply negative based on settlement interval.

Rule:

1. For contracts with `fundingIntervalMinutes = 60`, trigger alert if funding `<= -0.5%`.
2. For all other contracts, trigger alert if funding `<= -1.0%`.

Alert behavior:

- Emit one Telegram alert when a symbol newly breaches its threshold.
- Keep symbol tracked while it remains extreme.
- Remove tracking once funding normalizes above threshold.
