import assert from "node:assert/strict";
import test from "node:test";
import type { BybitTicker, Kline1h, StrategyContext } from "../src/core/domain/types.js";
import {
  evaluateNewListingSignals,
  exportNewListingState,
  hydrateNewListingState,
  listNewListingTrackedSetups,
  resetNewListingState,
} from "../src/strategies/new-listing-suite/logic.js";

const HOUR_MS = 60 * 60 * 1000;

function ticker(symbol: string): BybitTicker {
  return {
    symbol,
    lastPrice: 101,
    markPrice: 101,
    indexPrice: 101,
    fundingRate: 0,
    turnover24h: 100_000,
    volume24h: 1_000,
    price24hPcnt: 0.01,
    nextFundingTimeMs: 0,
    openInterest: 0,
  };
}

function candles(launchTimeMs: number): Kline1h[] {
  return Array.from({ length: 12 }, (_, index) => ({
    openTimeMs: launchTimeMs + index * HOUR_MS,
    open: index === 0 ? 100 : 101,
    high: index < 4 ? 102 : 101.5,
    low: 99,
    close: 101,
    volume: 1_000,
    turnover: index === 0 ? 40_000 : 50_000,
  }));
}

function contextForLateNonQualifier(symbol: string, nowMs: number): StrategyContext {
  const launchTimeMs = nowMs - 9 * HOUR_MS;
  return {
    nowMs,
    tickers: [ticker(symbol)],
    instruments: [
      {
        symbol,
        launchTimeMs,
        status: "Trading",
      },
    ],
    getKlines1h: async () => candles(launchTimeMs),
    getSellRatio1h: async () => ({ symbol, sellRatio: null, timestampMs: null }),
    getFundingHistory: async () => [],
  };
}

test("late non-qualifying new listings do not replay release/checkpoint alerts each cycle", async () => {
  resetNewListingState();
  const ctx = contextForLateNonQualifier("REPLAYAUSDT", 1_800_000_000_000);

  const first = await evaluateNewListingSignals(ctx);
  assert.deepEqual(
    first.map((signal) => signal.data.eventType),
    ["LISTING_RELEASED", "CHECKPOINT_4H_WATCH_S7"]
  );
  assert.equal(listNewListingTrackedSetups().some((setup) => setup.symbol === "REPLAYAUSDT"), false);

  const second = await evaluateNewListingSignals(ctx);
  assert.equal(second.length, 0);
});

test("persisted disqualified new listings suppress replay after restart hydration", async () => {
  resetNewListingState();
  const ctx = contextForLateNonQualifier("REPLAYBUSDT", 1_800_000_000_000);

  const first = await evaluateNewListingSignals(ctx);
  assert.equal(first.length, 2);
  const snapshot = JSON.parse(JSON.stringify(exportNewListingState())) as Record<string, unknown>;

  resetNewListingState();
  hydrateNewListingState(snapshot);

  const afterRestart = await evaluateNewListingSignals(ctx);
  assert.equal(afterRestart.length, 0);
});
