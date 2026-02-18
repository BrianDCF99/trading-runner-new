/**
 * Extreme sell-pressure v6.4 strategy module entry.
 */
import type { StrategyContext, StrategyModule, StrategySignal } from "../../core/domain/types.js";
import type { LoggerPort } from "../../core/ports/interfaces.js";
import { EXTREME_SELL_PRESSURE_V64_CONFIG } from "./config.js";
import {
  evaluateExtremeSellPressureV64Signals,
  exportExtremeSellPressureV64State,
  hydrateExtremeSellPressureV64State,
  listExtremeSellPressureV64TrackedSetups,
  type ExtremeSellPressureV64InternalSignal,
} from "./logic.js";
import { formatExtremeSellPressureV64Messages } from "./messages.js";

export function createStrategyModule(deps: { logger: LoggerPort }): StrategyModule {
  return {
    id: EXTREME_SELL_PRESSURE_V64_CONFIG.suiteStrategyId,
    name: EXTREME_SELL_PRESSURE_V64_CONFIG.suiteStrategyName,
    exchange: "bybit",
    strategyIds: [
      EXTREME_SELL_PRESSURE_V64_CONFIG.suiteStrategyId,
      EXTREME_SELL_PRESSURE_V64_CONFIG.strategyId,
    ],
    // Keep the legacy tracker key so current persisted state carries forward through the version rename.
    trackerStateKey: `${EXTREME_SELL_PRESSURE_V64_CONFIG.legacySuiteStrategyId}:trackers`,
    async evaluate(context: StrategyContext): Promise<StrategySignal[]> {
      const internal: ExtremeSellPressureV64InternalSignal[] =
        await evaluateExtremeSellPressureV64Signals(context);
      deps.logger.debug("Extreme sell-pressure v6.4 evaluation complete", {
        count: internal.length,
      });

      return internal.map((signal) => ({
        strategyId: EXTREME_SELL_PRESSURE_V64_CONFIG.strategyId,
        strategyName: EXTREME_SELL_PRESSURE_V64_CONFIG.strategyName,
        symbol: signal.symbol,
        phase: signal.phase,
        isReady: false,
        score: signal.score,
        generatedAtMs: context.nowMs,
        data: signal.data,
      }));
    },
    formatSignals(signals: StrategySignal[]): string[] {
      return formatExtremeSellPressureV64Messages(signals);
    },
    listTrackedSetups() {
      return listExtremeSellPressureV64TrackedSetups();
    },
    exportState(): Record<string, unknown> {
      return exportExtremeSellPressureV64State();
    },
    hydrateState(snapshot: unknown): void {
      hydrateExtremeSellPressureV64State(snapshot);
    },
  };
}
