/**
 * New listing strategy module entry.
 */
import type { StrategyContext, StrategyModule, StrategySignal } from "../../core/domain/types.js";
import type { LoggerPort } from "../../core/ports/interfaces.js";
import {
  evaluateNewListingSignals,
  exportNewListingState,
  hydrateNewListingState,
  listNewListingTrackedSetups,
  type NewListingInternalSignal,
} from "./logic.js";
import { formatNewListingMessages } from "./messages.js";

export function createStrategyModule(deps: { logger: LoggerPort }): StrategyModule {
  return {
    id: "bybit:new-listing-suite:v2",
    name: "Bybit New Listing Suite",
    exchange: "bybit",
    strategyIds: [
      "bybit:new-listing-suite:v2",
      "bybit:new-listing:red4h-hivol:v2",
      "bybit:new-listing:s7-pumpdump:v2",
    ],
    trackerStateKey: "bybit:new-listing:v2:trackers",
    async evaluate(context: StrategyContext): Promise<StrategySignal[]> {
      // Run strategy logic to produce strategy-native transitions/signals.
      const internal: NewListingInternalSignal[] = await evaluateNewListingSignals(context);
      deps.logger.debug("New listing evaluation complete", { count: internal.length });

      // Map strategy-native records into runner-standard signal shape.
      return internal.map((signal) => ({
        strategyId: signal.strategyId,
        strategyName: signal.strategyName,
        symbol: signal.symbol,
        phase: signal.phase,
        isReady: signal.phase.startsWith("READY_"),
        score: signal.score,
        generatedAtMs: context.nowMs,
        data: signal.data,
      }));
    },
    formatSignals(signals: StrategySignal[]): string[] {
      // Delegate alert formatting to strategy-local formatter.
      return formatNewListingMessages(signals);
    },
    listTrackedSetups() {
      return listNewListingTrackedSetups();
    },
    exportState(): Record<string, unknown> {
      // Export in-memory tracker snapshot for persistence.
      return exportNewListingState();
    },
    hydrateState(snapshot: unknown): void {
      // Rehydrate tracker snapshot from state store.
      hydrateNewListingState(snapshot);
    },
  };
}
