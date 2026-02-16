/**
 * Long25 strategy configuration.
 *
 * Keep strategy-tunable parameters centralized here.
 */

export interface Long25StrategyConfig {
  strategyId: string;
  strategyName: string;
  suiteStrategyId: string;
  suiteStrategyName: string;
  entry: {
    delayHoursAfterFundingSettlement: number;
    fundingHourlyEquivMax: number;
    basisMax: number;
    requirePriceAboveVwap: boolean;
    vwapLookbackHours: number;
  };
  exit: {
    minHoldHours: number;
    volumeMultipleThreshold: number;
    volumeAverageLookbackHours: number;
  };
  risk: {
    /**
     * Approximate isolated liquidation trigger from entry.
     * Example: -0.475 means liquidated after a 47.5% drawdown.
     */
    liquidationDrawdownPct: number;
  };
  market: {
    defaultFundingIntervalMinutes: number;
    klineLookbackHours: number;
  };
}

export const LONG25_CONFIG: Long25StrategyConfig = {
  strategyId: "bybit:long25:v1",
  strategyName: "Long Strategy V_vol25_min1",
  suiteStrategyId: "bybit:long25-suite:v1",
  suiteStrategyName: "Long25 Suite",
  entry: {
    // Strategy doc: evaluate at T+1h after funding settlement.
    delayHoursAfterFundingSettlement: 1,
    // Strategy doc: hourly equivalent <= -0.1%.
    fundingHourlyEquivMax: -0.001,
    // Strategy doc: basis < -0.5%.
    basisMax: -0.005,
    // Strategy doc: price > 24h VWAP.
    requirePriceAboveVwap: true,
    vwapLookbackHours: 24,
  },
  exit: {
    // Strategy doc: minimum hold 1h.
    minHoldHours: 1,
    // Strategy doc: hold while hourly volume > 2.5x 20h avg.
    volumeMultipleThreshold: 2.5,
    volumeAverageLookbackHours: 20,
  },
  risk: {
    // Not in the image, but required for liquidation stat tracking.
    liquidationDrawdownPct: -0.475,
  },
  market: {
    // Fallback if instrument interval is missing.
    defaultFundingIntervalMinutes: 480,
    // Must cover VWAP24 + volume(1 + 20) with a small buffer.
    klineLookbackHours: 72,
  },
};
