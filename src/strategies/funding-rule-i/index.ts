/**
 * Funding Rule I strategy module entry.
 */
import type { StrategyContext, StrategyModule, StrategySignal } from "../../core/domain/types.js";
import type { LoggerPort } from "../../core/ports/interfaces.js";
import {
  evaluateFundingRuleISignals,
  exportFundingState,
  hydrateFundingState,
  listFundingTrackedSetups,
  type FundingInternalSignal,
} from "./logic.js";
import { formatFundingMessages } from "./messages.js";

export function createStrategyModule(deps: { logger: LoggerPort }): StrategyModule {
  return {
    id: "bybit:funding:rule-i:v7",
    name: "Funding Rule I v7",
    exchange: "bybit",
    strategyIds: ["bybit:funding-suite:v7", "bybit:funding:rule-i:v7"],
    trackerStateKey: "bybit:funding:rule-i:v7:trackers",
    async evaluate(context: StrategyContext): Promise<StrategySignal[]> {
      // Run strategy state machine and get strategy-native signal objects.
      const internal: FundingInternalSignal[] = await evaluateFundingRuleISignals(context);
      deps.logger.debug("Funding evaluation complete", { count: internal.length });

      // Map strategy-native signals into runner-standard signal shape.
      return internal.map((signal) => ({
        strategyId: "bybit:funding:rule-i:v7",
        strategyName: "Funding Rule I v7",
        symbol: signal.symbol,
        phase: signal.phase,
        isReady: signal.phase === "READY",
        score: signal.score,
        generatedAtMs: context.nowMs,
        data: signal.data,
      }));
    },
    formatSignals(signals: StrategySignal[]): string[] {
      // Delegate formatting to strategy-local message formatter.
      return formatFundingMessages(signals);
    },
    listTrackedSetups() {
      return listFundingTrackedSetups();
    },
    exportState(): Record<string, unknown> {
      // Expose serializable strategy snapshot for persistence.
      return exportFundingState();
    },
    hydrateState(snapshot: unknown): void {
      // Restore strategy snapshot after runner restart.
      hydrateFundingState(snapshot);
    },
  };
}
