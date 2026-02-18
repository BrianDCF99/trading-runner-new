/**
 * Extreme sell-pressure v4.3 strategy module entry.
 */
import type { StrategyContext, StrategyModule, StrategySignal } from "../../core/domain/types.js";
import type { LoggerPort } from "../../core/ports/interfaces.js";
import { EXTREME_SELL_PRESSURE_V43_CONFIG } from "./config.js";
import {
  evaluateExtremeSellPressureV43Signals,
  exportExtremeSellPressureV43State,
  hydrateExtremeSellPressureV43State,
  listExtremeSellPressureV43TrackedSetups,
  type ExtremeSellPressureV43InternalSignal,
} from "./logic.js";
import { formatExtremeSellPressureV43Messages } from "./messages.js";

export function createStrategyModule(deps: { logger: LoggerPort }): StrategyModule {
  return {
    id: EXTREME_SELL_PRESSURE_V43_CONFIG.suiteStrategyId,
    name: EXTREME_SELL_PRESSURE_V43_CONFIG.suiteStrategyName,
    exchange: "bybit",
    strategyIds: [
      EXTREME_SELL_PRESSURE_V43_CONFIG.suiteStrategyId,
      EXTREME_SELL_PRESSURE_V43_CONFIG.strategyId,
    ],
    trackerStateKey: `${EXTREME_SELL_PRESSURE_V43_CONFIG.suiteStrategyId}:trackers`,
    async evaluate(context: StrategyContext): Promise<StrategySignal[]> {
      const internal: ExtremeSellPressureV43InternalSignal[] =
        await evaluateExtremeSellPressureV43Signals(context);
      deps.logger.debug("Extreme sell-pressure v4.3 evaluation complete", {
        count: internal.length,
      });

      return internal.map((signal) => ({
        strategyId: EXTREME_SELL_PRESSURE_V43_CONFIG.strategyId,
        strategyName: EXTREME_SELL_PRESSURE_V43_CONFIG.strategyName,
        symbol: signal.symbol,
        phase: signal.phase,
        isReady: false,
        score: signal.score,
        generatedAtMs: context.nowMs,
        data: signal.data,
      }));
    },
    formatSignals(signals: StrategySignal[]): string[] {
      return formatExtremeSellPressureV43Messages(signals);
    },
    listTrackedSetups() {
      return listExtremeSellPressureV43TrackedSetups();
    },
    exportState(): Record<string, unknown> {
      return exportExtremeSellPressureV43State();
    },
    hydrateState(snapshot: unknown): void {
      hydrateExtremeSellPressureV43State(snapshot);
    },
  };
}
