/**
 * Extreme sell-pressure strategy configuration (v9).
 */
function readFiniteEnv(nameOrNames: string | string[], fallback: number): number {
  const names = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
  for (const name of names) {
    const raw = process.env[name];
    if (typeof raw !== "string" || raw.trim().length === 0) continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) continue;
    return parsed;
  }
  return fallback;
}

function readPositiveEnv(nameOrNames: string | string[], fallback: number): number {
  const parsed = readFiniteEnv(nameOrNames, fallback);
  return parsed > 0 ? parsed : fallback;
}

function readRatioOrPercentEnv(nameOrNames: string | string[], fallbackRatio: number): number {
  const parsed = readFiniteEnv(nameOrNames, fallbackRatio);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackRatio;
  // Allow either 0.05 style (ratio) or 5 style (percent).
  return parsed > 1 ? parsed / 100 : parsed;
}

export interface ExtremeSellPressureConfig {
  version: string;
  suiteStrategyId: string;
  suiteStrategyName: string;
  strategyId: string;
  strategyName: string;
  trackerStateLegacySuiteStrategyId: string;
  legacySuiteStrategyIds: string[];
  legacyStrategyIds: string[];
  entry: {
    side: "SHORT";
    sellRatioMax: number;
    minHourVolume: number;
    leverage: number;
    takeProfitPct: number;
    maxHoldHours: number;
  };
  capital: {
    startingEquityUsd: number;
    entryMarginPct: number;
  };
  portfolio: {
    maxOpenPositions: number;
    replaceLosingThresholdPct: number;
    preventDuplicateSymbolEntries: boolean;
  };
  market: {
    klineLookbackHours: number;
  };
  retention: {
    closedSignalRetentionHours: number;
  };
  testing: {
    // Testing mode: maintain totals from alert-flow events in-memory.
    eventDrivenTotals: boolean;
    // Optional one-time reset to zero summary totals on startup/hydrate.
    resetTotalsOnHydrate: boolean;
  };
}

const VERSION = "v9";

export const EXTREME_SELL_PRESSURE_CONFIG: ExtremeSellPressureConfig = {
  version: VERSION,
  suiteStrategyId: `bybit:extreme-sell-pressure-suite:${VERSION}`,
  suiteStrategyName: `Bybit Extreme Sell Pressure Suite ${VERSION}`,
  strategyId: `bybit:extreme-sell-pressure:${VERSION}`,
  strategyName: `Extreme Sell Pressure ${VERSION}`,
  // Keep tracker-key compatibility with persisted historical state.
  trackerStateLegacySuiteStrategyId: "bybit:extreme-sell-pressure-suite:v43",
  legacySuiteStrategyIds: ["bybit:extreme-sell-pressure-suite:v64", "bybit:extreme-sell-pressure-suite:v43"],
  legacyStrategyIds: ["bybit:extreme-sell-pressure:v64", "bybit:extreme-sell-pressure:v43"],
  entry: {
    side: "SHORT",
    // Event trigger: sell ratio <= 0.20.
    sellRatioMax: readPositiveEnv(["ESP_V9_SELL_RATIO_MAX", "ESP_V64_SELL_RATIO_MAX", "ESP_V43_SELL_RATIO_MAX"], 0.2),
    // Event trigger: same 1h candle volume >= 1,000,000.
    minHourVolume: readPositiveEnv(
      ["ESP_V9_MIN_HOUR_VOLUME", "ESP_V64_MIN_HOUR_VOLUME", "ESP_V43_MIN_HOUR_VOLUME"],
      1_000_000
    ),
    leverage: readPositiveEnv(["ESP_V9_LEVERAGE", "ESP_V64_LEVERAGE"], 5),
    // TP-only at +4% unlevered move in favor of the short.
    takeProfitPct: readRatioOrPercentEnv(["ESP_V9_TAKE_PROFIT_PCT", "ESP_V64_TAKE_PROFIT_PCT"], 0.04),
    maxHoldHours: Math.max(
      1,
      Math.floor(readPositiveEnv(["ESP_V9_MAX_HOLD_HOURS", "ESP_V64_MAX_HOLD_HOURS", "ESP_V43_MAX_HOLD_HOURS"], 48))
    ),
  },
  capital: {
    // Initial equity used for live portfolio accounting (cash + position value).
    startingEquityUsd: readPositiveEnv(["ESP_V9_STARTING_EQUITY_USD", "ESP_V64_STARTING_EQUITY_USD"], 10_000),
    // Position margin sizing as a fraction of current equity (default 1%).
    entryMarginPct: readRatioOrPercentEnv(["ESP_V9_ENTRY_MARGIN_PCT", "ESP_V64_ENTRY_MARGIN_PCT"], 0.01),
  },
  portfolio: {
    maxOpenPositions: Math.max(
      1,
      Math.floor(
        readPositiveEnv(["ESP_V9_MAX_OPEN_POSITIONS", "ESP_V64_MAX_OPEN_POSITIONS", "ESP_V43_MAX_OPEN_POSITIONS"], 15)
      )
    ),
    // At capacity, replace only if an open position is <= -5%.
    replaceLosingThresholdPct: readRatioOrPercentEnv(
      [
        "ESP_V9_REPLACE_LOSING_THRESHOLD_PCT",
        "ESP_V64_REPLACE_LOSING_THRESHOLD_PCT",
        "ESP_V43_REPLACE_LOSING_THRESHOLD_PCT",
      ],
      0.05
    ),
    // Skip a new signal when the same symbol already has an open position.
    preventDuplicateSymbolEntries:
      String(
        process.env.ESP_V9_PREVENT_DUPLICATE_SYMBOL_ENTRIES ??
          process.env.ESP_V64_PREVENT_DUPLICATE_SYMBOL_ENTRIES ??
          process.env.ESP_V43_PREVENT_DUPLICATE_SYMBOL_ENTRIES ??
          "true"
      ).toLowerCase() !== "false",
  },
  market: {
    klineLookbackHours: Math.max(
      2,
      Math.floor(
        readPositiveEnv(["ESP_V9_KLINE_LOOKBACK_HOURS", "ESP_V64_KLINE_LOOKBACK_HOURS", "ESP_V43_KLINE_LOOKBACK_HOURS"], 2)
      )
    ),
  },
  retention: {
    closedSignalRetentionHours: Math.max(
      1,
      Math.floor(
        readPositiveEnv(
          ["ESP_V9_CLOSED_SIGNAL_RETENTION_HOURS", "ESP_V64_CLOSED_SIGNAL_RETENTION_HOURS", "ESP_V43_CLOSED_SIGNAL_RETENTION_HOURS"],
          24
        )
      )
    ),
  },
  testing: {
    eventDrivenTotals: true,
    resetTotalsOnHydrate:
      String(process.env.ESP_V9_RESET_TOTALS_ON_HYDRATE ?? process.env.ESP_V64_RESET_TOTALS_ON_HYDRATE ?? "false").toLowerCase() ===
      "true",
  },
};
