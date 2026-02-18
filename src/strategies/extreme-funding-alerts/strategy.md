# Extreme Funding Alerts

Purpose: notify when funding is deeply negative based on settlement interval.

Rule:

1. For contracts with `fundingIntervalMinutes = 60`, trigger alert if funding `<= -0.5%`.
2. For all other contracts, trigger alert if funding `<= -1.0%`.

Alert behavior:

- Emit alerts on funding window rollover only (no intra-window duplicates).
- While still extreme, emit one follow-up alert each time a new funding window starts.
- Remove tracking once funding normalizes above threshold.
