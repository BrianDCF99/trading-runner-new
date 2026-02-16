# Long Strategy: V_vol25_min1_max12

## Entry Rules (at T+1h after funding settlement)

1. Funding rate negative (hourly equiv <= -0.1%)
2. Basis < -0.5% (perp trading below spot/index)
3. Price > 24h VWAP (recovery started, not catching falling knife)

## Exit Rules

- Hold while hourly volume > 2.5x 20-hour average
- Exit first hour it drops below 2.5x
- Minimum hold: 1h
- Max 12h safety cap (removed in runner implementation by explicit request)

## Runner-specific implementation note

- The 12h cap is intentionally not coded.
- Entry and exit alerts are emitted for all qualifying entry/exit conditions.
