/**
 * Extreme sell-pressure strategy module entry (v9 config).
 */
import type { StrategyContext, StrategyModule, StrategySignal } from "../../core/domain/types.js";
import type { LoggerPort } from "../../core/ports/interfaces.js";
import { EXTREME_SELL_PRESSURE_CONFIG } from "./config.js";
import {
  evaluateExtremeSellPressureSignals,
  exportExtremeSellPressureState,
  hydrateExtremeSellPressureState,
  listExtremeSellPressureTrackedSetups,
  type ExtremeSellPressureInternalSignal,
} from "./logic.js";
import { formatExtremeSellPressureMessages } from "./messages.js";

export function createStrategyModule(deps: { logger: LoggerPort }): StrategyModule {
  return {
    id: EXTREME_SELL_PRESSURE_CONFIG.suiteStrategyId,
    name: EXTREME_SELL_PRESSURE_CONFIG.suiteStrategyName,
    exchange: "bybit",
    strategyIds: [
      EXTREME_SELL_PRESSURE_CONFIG.suiteStrategyId,
      EXTREME_SELL_PRESSURE_CONFIG.strategyId,
      ...EXTREME_SELL_PRESSURE_CONFIG.legacySuiteStrategyIds,
      ...EXTREME_SELL_PRESSURE_CONFIG.legacyStrategyIds,
    ],
    // Keep tracker-key compatibility so current persisted state carries forward through version bumps.
    trackerStateKey: `${EXTREME_SELL_PRESSURE_CONFIG.trackerStateLegacySuiteStrategyId}:trackers`,
    async evaluate(context: StrategyContext): Promise<StrategySignal[]> {
      const internal: ExtremeSellPressureInternalSignal[] =
        await evaluateExtremeSellPressureSignals(context);
      deps.logger.debug(`Extreme sell-pressure ${EXTREME_SELL_PRESSURE_CONFIG.version} evaluation complete`, {
        count: internal.length,
      });

      return internal.map((signal) => ({
        strategyId: EXTREME_SELL_PRESSURE_CONFIG.strategyId,
        strategyName: EXTREME_SELL_PRESSURE_CONFIG.strategyName,
        symbol: signal.symbol,
        phase: signal.phase,
        isReady: false,
        score: signal.score,
        generatedAtMs: context.nowMs,
        data: signal.data,
      }));
    },
    formatSignals(signals: StrategySignal[]): string[] {
      return formatExtremeSellPressureMessages(signals);
    },
    listTrackedSetups() {
      return listExtremeSellPressureTrackedSetups();
    },
    exportState(): Record<string, unknown> {
      return exportExtremeSellPressureState();
    },
    hydrateState(snapshot: unknown): void {
      hydrateExtremeSellPressureState(snapshot);
    },
  };
}
