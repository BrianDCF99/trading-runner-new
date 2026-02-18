/**
 * Extreme sell-pressure v4.3 strategy configuration.
 */
function readFiniteEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function readPositiveEnv(name: string, fallback: number): number {
  const parsed = readFiniteEnv(name, fallback);
  return parsed > 0 ? parsed : fallback;
}

function readRatioOrPercentEnv(name: string, fallbackRatio: number): number {
  const parsed = readFiniteEnv(name, fallbackRatio);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackRatio;
  // Allow either 0.05 style (ratio) or 5 style (percent).
  return parsed > 1 ? parsed / 100 : parsed;
}

export interface ExtremeSellPressureV43Config {
  suiteStrategyId: string;
  suiteStrategyName: string;
  strategyId: string;
  strategyName: string;
  entry: {
    side: "SHORT";
    sellRatioMax: number;
    minHourVolume: number;
    leverage: number;
    takeProfitPct: number;
    maxHoldHours: number;
  };
  portfolio: {
    maxOpenPositions: number;
    replaceLosingThresholdPct: number;
    preventDuplicateSymbolEntries: boolean;
  };
  market: {
    sellRatioScanBatchSize: number;
    klineLookbackHours: number;
  };
  retention: {
    closedSignalRetentionHours: number;
  };
  testing: {
    // Testing mode: maintain totals from alert-flow events in-memory.
    eventDrivenTotals: boolean;
  };
}

export const EXTREME_SELL_PRESSURE_V43_CONFIG: ExtremeSellPressureV43Config = {
  suiteStrategyId: "bybit:extreme-sell-pressure-suite:v43",
  suiteStrategyName: "Bybit Extreme Sell Pressure Suite v4.3",
  strategyId: "bybit:extreme-sell-pressure:v43",
  strategyName: "Extreme Sell Pressure v4.3",
  entry: {
    side: "SHORT",
    // Event trigger: sell ratio <= 0.20. Override: ESP_V43_SELL_RATIO_MAX
    sellRatioMax: readPositiveEnv("ESP_V43_SELL_RATIO_MAX", 0.2),
    // Event trigger: same 1h candle volume >= 1,000,000. Override: ESP_V43_MIN_HOUR_VOLUME
    minHourVolume: readPositiveEnv("ESP_V43_MIN_HOUR_VOLUME", 1_000_000),
    // Override: ESP_V43_LEVERAGE
    leverage: readPositiveEnv("ESP_V43_LEVERAGE", 5),
    // TP-only at +4% unlevered move in favor of the short. Override: ESP_V43_TAKE_PROFIT_PCT (4 or 0.04)
    takeProfitPct: readRatioOrPercentEnv("ESP_V43_TAKE_PROFIT_PCT", 0.04),
    // Override: ESP_V43_MAX_HOLD_HOURS
    maxHoldHours: Math.max(1, Math.floor(readPositiveEnv("ESP_V43_MAX_HOLD_HOURS", 48))),
  },
  portfolio: {
    // Override: ESP_V43_MAX_OPEN_POSITIONS
    maxOpenPositions: Math.max(1, Math.floor(readPositiveEnv("ESP_V43_MAX_OPEN_POSITIONS", 15))),
    // At capacity, replace only if an open position is <= -5%. Override: ESP_V43_REPLACE_LOSING_THRESHOLD_PCT (5 or 0.05)
    replaceLosingThresholdPct: readRatioOrPercentEnv("ESP_V43_REPLACE_LOSING_THRESHOLD_PCT", 0.05),
    // V4.4 behavior: skip if symbol already has an open position.
    preventDuplicateSymbolEntries:
      String(process.env.ESP_V43_PREVENT_DUPLICATE_SYMBOL_ENTRIES ?? "true").toLowerCase() !== "false",
  },
  market: {
    // Cap external sell-ratio requests each cycle to keep runtime stable.
    sellRatioScanBatchSize: Math.max(1, Math.floor(readPositiveEnv("ESP_V43_SELL_RATIO_SCAN_BATCH_SIZE", 120))),
    klineLookbackHours: Math.max(2, Math.floor(readPositiveEnv("ESP_V43_KLINE_LOOKBACK_HOURS", 2))),
  },
  retention: {
    closedSignalRetentionHours: Math.max(1, Math.floor(readPositiveEnv("ESP_V43_CLOSED_SIGNAL_RETENTION_HOURS", 24))),
  },
  testing: {
    eventDrivenTotals: true,
  },
};
