/**
 * Extreme funding alert strategy configuration.
 */
export interface ExtremeFundingConfig {
  suiteStrategyId: string;
  suiteStrategyName: string;
  strategyId: string;
  strategyName: string;
  oneHourSettlementMinutes: number;
  thresholds: {
    oneHourSettlement: number;
    default: number;
  };
}

export const EXTREME_FUNDING_CONFIG: ExtremeFundingConfig = {
  suiteStrategyId: "bybit:extreme-funding-suite:v1",
  suiteStrategyName: "Bybit Extreme Funding Alerts",
  strategyId: "bybit:extreme-funding:alerts:v1",
  strategyName: "Extreme Funding Alerts v1",
  oneHourSettlementMinutes: 60,
  thresholds: {
    // -0.50% for 1h settlement contracts.
    oneHourSettlement: -0.005,
    // -1.00% for all non-1h settlement contracts.
    default: -0.01,
  },
};
