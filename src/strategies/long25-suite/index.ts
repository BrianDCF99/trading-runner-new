/**
 * Long25 strategy module entry.
 */
import type { StrategyContext, StrategyModule, StrategySignal } from "../../core/domain/types.js";
import type { LoggerPort } from "../../core/ports/interfaces.js";
import {
  evaluateLong25Signals,
  exportLong25State,
  hydrateLong25State,
  listLong25TrackedSetups,
  type Long25InternalSignal,
} from "./logic.js";
import { formatLong25Messages } from "./messages.js";
import { LONG25_CONFIG } from "./config.js";

export function createStrategyModule(deps: { logger: LoggerPort }): StrategyModule {
  return {
    id: LONG25_CONFIG.suiteStrategyId,
    name: LONG25_CONFIG.suiteStrategyName,
    exchange: "bybit",
    strategyIds: [LONG25_CONFIG.suiteStrategyId, LONG25_CONFIG.strategyId],
    trackerStateKey: `${LONG25_CONFIG.suiteStrategyId}:trackers`,
    async evaluate(context: StrategyContext): Promise<StrategySignal[]> {
      const internal: Long25InternalSignal[] = await evaluateLong25Signals(context);
      deps.logger.debug("Long25 evaluation complete", { count: internal.length });

      return internal.map((signal) => ({
        strategyId: LONG25_CONFIG.strategyId,
        strategyName: LONG25_CONFIG.strategyName,
        symbol: signal.symbol,
        phase: signal.phase,
        isReady: signal.phase === "READY",
        score: signal.score,
        generatedAtMs: context.nowMs,
        data: signal.data,
      }));
    },
    formatSignals(signals: StrategySignal[]): string[] {
      return formatLong25Messages(signals);
    },
    listTrackedSetups() {
      return listLong25TrackedSetups();
    },
    exportState(): Record<string, unknown> {
      return exportLong25State();
    },
    hydrateState(snapshot: unknown): void {
      hydrateLong25State(snapshot);
    },
  };
}
