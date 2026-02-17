/**
 * Extreme funding alerts strategy module entry.
 */
import type { StrategyContext, StrategyModule, StrategySignal } from "../../core/domain/types.js";
import type { LoggerPort } from "../../core/ports/interfaces.js";
import {
  evaluateExtremeFundingSignals,
  exportExtremeFundingState,
  hydrateExtremeFundingState,
  listExtremeFundingTrackedSetups,
  type ExtremeFundingInternalSignal,
} from "./logic.js";
import { formatExtremeFundingMessages } from "./messages.js";
import { EXTREME_FUNDING_CONFIG } from "./config.js";

export function createStrategyModule(deps: { logger: LoggerPort }): StrategyModule {
  return {
    id: EXTREME_FUNDING_CONFIG.suiteStrategyId,
    name: EXTREME_FUNDING_CONFIG.suiteStrategyName,
    exchange: "bybit",
    strategyIds: [EXTREME_FUNDING_CONFIG.suiteStrategyId, EXTREME_FUNDING_CONFIG.strategyId],
    trackerStateKey: `${EXTREME_FUNDING_CONFIG.suiteStrategyId}:trackers`,
    async evaluate(context: StrategyContext): Promise<StrategySignal[]> {
      const internal: ExtremeFundingInternalSignal[] = await evaluateExtremeFundingSignals(context);
      deps.logger.debug("Extreme funding evaluation complete", { count: internal.length });

      return internal.map((signal) => ({
        strategyId: EXTREME_FUNDING_CONFIG.strategyId,
        strategyName: EXTREME_FUNDING_CONFIG.strategyName,
        symbol: signal.symbol,
        phase: signal.phase,
        isReady: false,
        score: signal.score,
        generatedAtMs: context.nowMs,
        data: signal.data,
      }));
    },
    formatSignals(signals: StrategySignal[]): string[] {
      return formatExtremeFundingMessages(signals);
    },
    listTrackedSetups() {
      return listExtremeFundingTrackedSetups();
    },
    exportState(): Record<string, unknown> {
      return exportExtremeFundingState();
    },
    hydrateState(snapshot: unknown): void {
      hydrateExtremeFundingState(snapshot);
    },
  };
}
