/**
 * Extreme sell-pressure v6.4 strategy logic.
 *
 * Live adaptation of the v6.4 research rules:
 * - trigger: sell_ratio <= 0.20 and latest 1h candle volume >= 1,000,000
 * - short entries only
 * - tp-only (4%), leverage 5x, max hold 48h
 * - max 15 open positions
 * - if at capacity, replace worst mark-return position when mark return <= -5%
 */
import type { BybitTicker, Kline1h, StrategyContext, StrategyTrackedSetup } from "../../core/domain/types.js";
import { EXTREME_SELL_PRESSURE_V64_CONFIG } from "./config.js";

const HOUR_MS = 60 * 60 * 1000;
const ENTRY_SCORE = 100;
const CLOSE_SCORE = 85;
const SELL_RATIO_CONCURRENCY = 8;

type ExtremeSellPressurePhase = "OPEN_SHORT" | "CLOSED";
type ExtremeSellPressureEventType =
  | "ENTRY_OPEN_SHORT"
  | "ENTRY_REPLACE_OPEN_SHORT"
  | "EXIT_TP"
  | "EXIT_TIME"
  | "EXIT_LIQUIDATED"
  | "EXIT_REPLACE_STOP";

type EntryEventType = Extract<ExtremeSellPressureEventType, "ENTRY_OPEN_SHORT" | "ENTRY_REPLACE_OPEN_SHORT">;
type CloseEventType = Extract<
  ExtremeSellPressureEventType,
  "EXIT_TP" | "EXIT_TIME" | "EXIT_LIQUIDATED" | "EXIT_REPLACE_STOP"
>;

interface OpenPosition {
  positionKey: string;
  symbol: string;
  positionId: number;
  entryAtMs: number;
  entryPrice: number;
  leverage: number;
  takeProfitPct: number;
  maxHoldAtMs: number;
  sellRatioAtEntry: number;
  eventVolumeAtEntry: number;
  sellRatioTimestampMs: number;
  lastMarkPrice: number;
  lastMarkMovePct: number;
  lastMarkReturnPct: number;
  updatedAtMs: number;
}

interface SymbolSignalState {
  symbol: string;
  lastProcessedSellRatioTimestampMs: number | null;
  lastObservedSellRatio: number | null;
  lastObservedSellRatioTimestampMs: number | null;
  lastObservedHourVolume: number | null;
  updatedAtMs: number;
}

interface EntryCandidate {
  symbol: string;
  entryPrice: number;
  sellRatio: number;
  sellRatioTimestampMs: number;
  hourVolume: number;
}

interface SummaryStats {
  entries: number;
  missedTrades: number;
  winners: number;
  losers: number;
  liquidated: number;
  replaced: number;
  realizedPnlPct: number;
}

interface TotalsSnapshot {
  entries: number;
  missedTrades: number;
  winners: number;
  losers: number;
  liquidated: number;
  replaced: number;
  pnlPct: number;
  winPct: number;
  openPositions: number;
}

interface CloseResult {
  signal: ExtremeSellPressureV64InternalSignal;
  eventType: CloseEventType;
  leveragedReturnPct: number;
}

export interface ExtremeSellPressureV64InternalSignal {
  symbol: string;
  phase: ExtremeSellPressurePhase;
  score: number;
  data: Record<string, unknown>;
}

const openPositions: Record<string, OpenPosition> = {};
const symbolStates: Record<string, SymbolSignalState> = {};
const summaryStats: SummaryStats = {
  entries: 0,
  missedTrades: 0,
  winners: 0,
  losers: 0,
  liquidated: 0,
  replaced: 0,
  realizedPnlPct: 0,
};
let nextPositionId = 1;
let symbolScanCursor = 0;

function listOpenPositions(): OpenPosition[] {
  return Object.values(openPositions);
}

function safeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function toPercent(value: number): number {
  return value * 100;
}

function computeShortUnleveredReturn(entryPrice: number, markPrice: number): number | null {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (!Number.isFinite(markPrice) || markPrice <= 0) return null;
  return (entryPrice - markPrice) / entryPrice;
}

function computeShortLeveredReturnPct(entryPrice: number, markPrice: number, leverage: number): number | null {
  const unlevered = computeShortUnleveredReturn(entryPrice, markPrice);
  if (unlevered === null) return null;
  if (!Number.isFinite(leverage) || leverage <= 0) return null;
  return toPercent(unlevered * leverage);
}

function shortPriceFromReturnPct(entryPrice: number, unleveredReturnPct: number): number | null {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (!Number.isFinite(unleveredReturnPct)) return null;
  // For short: return = (entry - exit) / entry.
  return entryPrice * (1 - unleveredReturnPct / 100);
}

function isEligibleInstrument(input: { symbol: string; status: string; contractType?: string | null }): boolean {
  if (input.status.toLowerCase() !== "trading") return false;
  if (input.symbol.includes("-")) return false;
  if (typeof input.contractType === "string" && input.contractType.toLowerCase().includes("futures")) {
    return false;
  }
  return true;
}

function getOrCreateSymbolState(symbol: string, nowMs: number): SymbolSignalState {
  const existing = symbolStates[symbol];
  if (existing) {
    existing.updatedAtMs = nowMs;
    return existing;
  }
  const created: SymbolSignalState = {
    symbol,
    lastProcessedSellRatioTimestampMs: null,
    lastObservedSellRatio: null,
    lastObservedSellRatioTimestampMs: null,
    lastObservedHourVolume: null,
    updatedAtMs: nowMs,
  };
  symbolStates[symbol] = created;
  return created;
}

function selectScanBatch(symbols: string[], batchSize: number): string[] {
  if (symbols.length === 0) return [];
  const normalizedBatchSize = Math.max(1, Math.min(batchSize, symbols.length));
  const start = symbolScanCursor % symbols.length;
  const out: string[] = [];
  for (let i = 0; i < normalizedBatchSize; i += 1) {
    out.push(symbols[(start + i) % symbols.length] as string);
  }
  symbolScanCursor = (start + normalizedBatchSize) % symbols.length;
  return out;
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  handler: (item: T, index: number) => Promise<U>
): Promise<U[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const out = new Array<U>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      out[idx] = await handler(items[idx] as T, idx);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return out;
}

function readLatestHourVolume(candles: Kline1h[]): number | null {
  if (candles.length === 0) return null;
  const latest = candles[candles.length - 1];
  if (!latest) return null;
  if (!Number.isFinite(latest.volume) || latest.volume < 0) return null;
  return latest.volume;
}

function updatePositionMark(position: OpenPosition, ticker: BybitTicker | undefined, nowMs: number): void {
  if (!ticker) return;
  if (!Number.isFinite(ticker.lastPrice) || ticker.lastPrice <= 0) return;
  const markMove = computeShortUnleveredReturn(position.entryPrice, ticker.lastPrice);
  const markReturnPct = computeShortLeveredReturnPct(position.entryPrice, ticker.lastPrice, position.leverage);
  position.lastMarkPrice = ticker.lastPrice;
  position.lastMarkMovePct = markMove === null ? position.lastMarkMovePct : toPercent(markMove);
  position.lastMarkReturnPct = markReturnPct ?? position.lastMarkReturnPct;
  position.updatedAtMs = nowMs;
}

function computeUnrealizedPnlPct(): number {
  return listOpenPositions().reduce((acc, position) => {
    const value = safeNumber(position.lastMarkReturnPct);
    return acc + (value ?? 0);
  }, 0);
}

function buildTotalsSnapshot(): TotalsSnapshot {
  const closedCount = summaryStats.winners + summaryStats.losers + summaryStats.liquidated;
  const winPct = closedCount > 0 ? (summaryStats.winners / closedCount) * 100 : 0;
  return {
    entries: summaryStats.entries,
    missedTrades: summaryStats.missedTrades,
    winners: summaryStats.winners,
    losers: summaryStats.losers,
    liquidated: summaryStats.liquidated,
    replaced: summaryStats.replaced,
    pnlPct: summaryStats.realizedPnlPct + computeUnrealizedPnlPct(),
    winPct,
    openPositions: listOpenPositions().length,
  };
}

function withTotals(signal: ExtremeSellPressureV64InternalSignal): ExtremeSellPressureV64InternalSignal {
  return {
    ...signal,
    data: {
      ...signal.data,
      totals: buildTotalsSnapshot(),
    },
  };
}

function applyEntryToSummary(eventType: EntryEventType): void {
  if (!EXTREME_SELL_PRESSURE_V64_CONFIG.testing.eventDrivenTotals) return;
  summaryStats.entries += 1;
  if (eventType === "ENTRY_REPLACE_OPEN_SHORT") {
    summaryStats.replaced += 1;
  }
}

function applyCloseToSummary(close: CloseResult): void {
  if (!EXTREME_SELL_PRESSURE_V64_CONFIG.testing.eventDrivenTotals) return;
  summaryStats.realizedPnlPct += close.leveragedReturnPct;
  if (close.eventType === "EXIT_LIQUIDATED") {
    summaryStats.liquidated += 1;
    return;
  }
  if (close.leveragedReturnPct > 0) {
    summaryStats.winners += 1;
    return;
  }
  summaryStats.losers += 1;
}

function recordMissedTrade(): void {
  if (!EXTREME_SELL_PRESSURE_V64_CONFIG.testing.eventDrivenTotals) return;
  summaryStats.missedTrades += 1;
}

function closePosition(input: {
  position: OpenPosition;
  nowMs: number;
  eventType: CloseEventType;
  markPrice: number;
  forcedLeveredReturnPct?: number;
  extraData?: Record<string, unknown>;
}): CloseResult {
  const { position, nowMs, eventType, markPrice, forcedLeveredReturnPct, extraData } = input;

  let leveragedReturnPct: number;
  let unleveredReturnPct: number;
  let exitPrice: number;

  if (typeof forcedLeveredReturnPct === "number" && Number.isFinite(forcedLeveredReturnPct)) {
    leveragedReturnPct = forcedLeveredReturnPct;
    unleveredReturnPct = leveragedReturnPct / position.leverage;
    exitPrice = shortPriceFromReturnPct(position.entryPrice, unleveredReturnPct) ?? markPrice;
  } else {
    const computedLevered = computeShortLeveredReturnPct(position.entryPrice, markPrice, position.leverage) ?? 0;
    leveragedReturnPct = computedLevered;
    unleveredReturnPct = leveragedReturnPct / position.leverage;
    exitPrice = markPrice;
  }

  delete openPositions[position.positionKey];

  return {
    eventType,
    leveragedReturnPct,
    signal: {
      symbol: position.symbol,
      phase: "CLOSED",
      score: CLOSE_SCORE,
      data: {
        eventType,
        action: "CLOSE SHORT",
        side: "SHORT",
        positionId: position.positionId,
        entryAtMs: position.entryAtMs,
        closedAtMs: nowMs,
        heldHours: (nowMs - position.entryAtMs) / HOUR_MS,
        entryPrice: position.entryPrice,
        exitPrice,
        markPrice,
        leverage: position.leverage,
        takeProfitPrice: position.entryPrice * (1 - position.takeProfitPct),
        unleveredReturnPct,
        leveragedReturnPct,
        ...extraData,
      },
    },
  };
}

function openPosition(input: {
  candidate: EntryCandidate;
  nowMs: number;
  eventType: EntryEventType;
  extraData?: Record<string, unknown>;
}): ExtremeSellPressureV64InternalSignal {
  const { candidate, nowMs, eventType, extraData } = input;
  const positionId = nextPositionId;
  const positionKey = `p${positionId}`;
  const leverage = EXTREME_SELL_PRESSURE_V64_CONFIG.entry.leverage;
  const takeProfitPct = EXTREME_SELL_PRESSURE_V64_CONFIG.entry.takeProfitPct;
  const takeProfitPrice = candidate.entryPrice * (1 - takeProfitPct);

  const position: OpenPosition = {
    positionKey,
    symbol: candidate.symbol,
    positionId,
    entryAtMs: nowMs,
    entryPrice: candidate.entryPrice,
    leverage,
    takeProfitPct,
    maxHoldAtMs: nowMs + EXTREME_SELL_PRESSURE_V64_CONFIG.entry.maxHoldHours * HOUR_MS,
    sellRatioAtEntry: candidate.sellRatio,
    eventVolumeAtEntry: candidate.hourVolume,
    sellRatioTimestampMs: candidate.sellRatioTimestampMs,
    lastMarkPrice: candidate.entryPrice,
    lastMarkMovePct: 0,
    lastMarkReturnPct: 0,
    updatedAtMs: nowMs,
  };
  openPositions[position.positionKey] = position;
  nextPositionId += 1;

  return {
    symbol: position.symbol,
    phase: "OPEN_SHORT",
    score: ENTRY_SCORE,
    data: {
      eventType,
      action: "OPEN SHORT",
      side: "SHORT",
      positionId: position.positionId,
      entryAtMs: position.entryAtMs,
      entryPrice: position.entryPrice,
      takeProfitPrice,
      leverage: position.leverage,
      takeProfitPct: toPercent(position.takeProfitPct),
      maxHoldHours: EXTREME_SELL_PRESSURE_V64_CONFIG.entry.maxHoldHours,
      sellRatio: position.sellRatioAtEntry,
      hourVolume: position.eventVolumeAtEntry,
      sellRatioTimestampMs: position.sellRatioTimestampMs,
      sellRatioThreshold: EXTREME_SELL_PRESSURE_V64_CONFIG.entry.sellRatioMax,
      volumeThreshold: EXTREME_SELL_PRESSURE_V64_CONFIG.entry.minHourVolume,
      openPositions: listOpenPositions().length,
      ...extraData,
    },
  };
}

function cleanupSymbolState(nowMs: number, activeSymbols: Set<string>): void {
  const retentionMs = EXTREME_SELL_PRESSURE_V64_CONFIG.retention.closedSignalRetentionHours * HOUR_MS;
  const openSymbols = new Set(listOpenPositions().map((position) => position.symbol));
  for (const [symbol, state] of Object.entries(symbolStates)) {
    const isOpen = openSymbols.has(symbol);
    const isActiveSymbol = activeSymbols.has(symbol);
    if (isOpen || isActiveSymbol) continue;
    if (nowMs - state.updatedAtMs <= retentionMs) continue;
    delete symbolStates[symbol];
  }
}

function markProcessedSellRatio(symbol: string, sellRatioTimestampMs: number, nowMs: number): void {
  const state = getOrCreateSymbolState(symbol, nowMs);
  state.lastProcessedSellRatioTimestampMs = sellRatioTimestampMs;
  state.updatedAtMs = nowMs;
}

function selectReplacementCandidate(input: {
  nowMs: number;
  tickerBySymbol: Map<string, BybitTicker>;
}): { positionKey: string; symbol: string; markPrice: number; markReturnPct: number } | null {
  const { nowMs, tickerBySymbol } = input;
  const thresholdPct = -toPercent(EXTREME_SELL_PRESSURE_V64_CONFIG.portfolio.replaceLosingThresholdPct);
  let chosen: { positionKey: string; symbol: string; markPrice: number; markReturnPct: number } | null = null;

  for (const position of listOpenPositions()) {
    const ticker = tickerBySymbol.get(position.symbol);
    if (!ticker || !Number.isFinite(ticker.lastPrice) || ticker.lastPrice <= 0) continue;
    updatePositionMark(position, ticker, nowMs);
    const markReturnPct = safeNumber(position.lastMarkReturnPct);
    if (markReturnPct === null) continue;
    if (markReturnPct > thresholdPct) continue;
    if (!chosen || markReturnPct < chosen.markReturnPct) {
      chosen = {
        positionKey: position.positionKey,
        symbol: position.symbol,
        markPrice: ticker.lastPrice,
        markReturnPct,
      };
    }
  }

  return chosen;
}

function processNaturalExits(
  context: StrategyContext,
  tickerBySymbol: Map<string, BybitTicker>
): CloseResult[] {
  const out: CloseResult[] = [];
  for (const position of listOpenPositions()) {
    const ticker = tickerBySymbol.get(position.symbol);
    if (!ticker || !Number.isFinite(ticker.lastPrice) || ticker.lastPrice <= 0) continue;

    updatePositionMark(position, ticker, context.nowMs);

    const adverseMovePct = (ticker.lastPrice - position.entryPrice) / position.entryPrice;
    const liquidationAdversePct = 1 / position.leverage;
    if (adverseMovePct >= liquidationAdversePct) {
      const liquidationPrice = position.entryPrice * (1 + liquidationAdversePct);
      out.push(
        closePosition({
          position,
          nowMs: context.nowMs,
          eventType: "EXIT_LIQUIDATED",
          markPrice: liquidationPrice,
          forcedLeveredReturnPct: -100,
        })
      );
      continue;
    }

    const favorableMovePct = (position.entryPrice - ticker.lastPrice) / position.entryPrice;
    if (favorableMovePct >= position.takeProfitPct) {
      out.push(
        closePosition({
          position,
          nowMs: context.nowMs,
          eventType: "EXIT_TP",
          markPrice: ticker.lastPrice,
        })
      );
      continue;
    }

    if (context.nowMs >= position.maxHoldAtMs) {
      out.push(
        closePosition({
          position,
          nowMs: context.nowMs,
          eventType: "EXIT_TIME",
          markPrice: ticker.lastPrice,
        })
      );
    }
  }
  return out;
}

async function evaluateEntryCandidate(input: {
  symbol: string;
  context: StrategyContext;
  tickerBySymbol: Map<string, BybitTicker>;
}): Promise<EntryCandidate | null> {
  const { symbol, context, tickerBySymbol } = input;
  try {
    const ticker = tickerBySymbol.get(symbol);
    if (!ticker || !Number.isFinite(ticker.lastPrice) || ticker.lastPrice <= 0) return null;

    const state = getOrCreateSymbolState(symbol, context.nowMs);
    const sellRatioSnapshot = await context.getSellRatio1h(symbol);
    state.lastObservedSellRatio = sellRatioSnapshot.sellRatio;
    state.lastObservedSellRatioTimestampMs = sellRatioSnapshot.timestampMs;
    state.updatedAtMs = context.nowMs;

    const sellRatio = sellRatioSnapshot.sellRatio;
    const sellRatioTimestampMs = sellRatioSnapshot.timestampMs;
    if (sellRatio === null || sellRatioTimestampMs === null) return null;
    if (
      state.lastProcessedSellRatioTimestampMs !== null &&
      sellRatioTimestampMs <= state.lastProcessedSellRatioTimestampMs
    ) {
      return null;
    }
    if (sellRatio > EXTREME_SELL_PRESSURE_V64_CONFIG.entry.sellRatioMax) return null;

    const candles = await context.getKlines1h(symbol, EXTREME_SELL_PRESSURE_V64_CONFIG.market.klineLookbackHours);
    const hourVolume = readLatestHourVolume(candles);
    state.lastObservedHourVolume = hourVolume;
    if (hourVolume === null || hourVolume < EXTREME_SELL_PRESSURE_V64_CONFIG.entry.minHourVolume) {
      return null;
    }

    return {
      symbol,
      entryPrice: ticker.lastPrice,
      sellRatio,
      sellRatioTimestampMs,
      hourVolume,
    };
  } catch {
    return null;
  }
}

function sortedEligibleSymbols(context: StrategyContext): string[] {
  const instrumentMap = new Map(context.instruments.map((instrument) => [instrument.symbol, instrument]));
  const tickers = context.tickers
    .filter((ticker) => {
      const instrument = instrumentMap.get(ticker.symbol);
      if (!instrument) return false;
      if (
        !isEligibleInstrument({
          symbol: instrument.symbol,
          status: instrument.status,
          contractType: instrument.contractType,
        })
      ) {
        return false;
      }
      return Number.isFinite(ticker.lastPrice) && ticker.lastPrice > 0;
    })
    .sort((a, b) => {
      if (b.volume24h !== a.volume24h) return b.volume24h - a.volume24h;
      return a.symbol.localeCompare(b.symbol);
    });
  return tickers.map((ticker) => ticker.symbol);
}

export async function evaluateExtremeSellPressureV64Signals(
  context: StrategyContext
): Promise<ExtremeSellPressureV64InternalSignal[]> {
  const out: ExtremeSellPressureV64InternalSignal[] = [];
  const tickerBySymbol = new Map(context.tickers.map((ticker) => [ticker.symbol, ticker]));

  const naturalExits = processNaturalExits(context, tickerBySymbol);
  for (const close of naturalExits) {
    applyCloseToSummary(close);
    out.push(withTotals(close.signal));
  }

  const eligibleSymbols = sortedEligibleSymbols(context);
  const scanSymbols = selectScanBatch(
    eligibleSymbols,
    EXTREME_SELL_PRESSURE_V64_CONFIG.market.sellRatioScanBatchSize
  );

  const candidatesRaw = await mapWithConcurrency(scanSymbols, SELL_RATIO_CONCURRENCY, (symbol) =>
    evaluateEntryCandidate({ symbol, context, tickerBySymbol })
  );
  const candidates = candidatesRaw.filter((item): item is EntryCandidate => item !== null);
  candidates.sort((a, b) => {
    if (a.sellRatioTimestampMs !== b.sellRatioTimestampMs) return a.sellRatioTimestampMs - b.sellRatioTimestampMs;
    return a.symbol.localeCompare(b.symbol);
  });

  for (const candidate of candidates) {
    markProcessedSellRatio(candidate.symbol, candidate.sellRatioTimestampMs, context.nowMs);

    if (EXTREME_SELL_PRESSURE_V64_CONFIG.portfolio.preventDuplicateSymbolEntries) {
      const symbolAlreadyOpen = listOpenPositions().some((position) => position.symbol === candidate.symbol);
      if (symbolAlreadyOpen) {
        recordMissedTrade();
        continue;
      }
    }

    const openCount = listOpenPositions().length;
    if (openCount < EXTREME_SELL_PRESSURE_V64_CONFIG.portfolio.maxOpenPositions) {
      const entry = openPosition({
        candidate,
        nowMs: context.nowMs,
        eventType: "ENTRY_OPEN_SHORT",
      });
      applyEntryToSummary("ENTRY_OPEN_SHORT");
      out.push(withTotals(entry));
      continue;
    }

    const replacement = selectReplacementCandidate({ nowMs: context.nowMs, tickerBySymbol });
    if (!replacement) {
      recordMissedTrade();
      continue;
    }

    const victim = openPositions[replacement.positionKey];
    if (!victim) {
      recordMissedTrade();
      continue;
    }

    const replacementClose = closePosition({
      position: victim,
      nowMs: context.nowMs,
      eventType: "EXIT_REPLACE_STOP",
      markPrice: replacement.markPrice,
      forcedLeveredReturnPct: -toPercent(
        EXTREME_SELL_PRESSURE_V64_CONFIG.portfolio.replaceLosingThresholdPct
      ),
      extraData: {
        markReturnAtReplacementPct: replacement.markReturnPct,
      },
    });
    applyCloseToSummary(replacementClose);

    const replacementEntry = openPosition({
      candidate,
      nowMs: context.nowMs,
      eventType: "ENTRY_REPLACE_OPEN_SHORT",
      extraData: {
        replacedSymbol: replacement.symbol,
        replacedPnlPct: replacementClose.leveragedReturnPct,
        replacedUnleveredPct: safeNumber(replacementClose.signal.data.unleveredReturnPct),
        replacedLeverage: safeNumber(replacementClose.signal.data.leverage),
        replacedEntryPrice: safeNumber(replacementClose.signal.data.entryPrice),
        replacedExitPrice: safeNumber(replacementClose.signal.data.exitPrice),
        replacedHeldHours: safeNumber(replacementClose.signal.data.heldHours),
      },
    });
    applyEntryToSummary("ENTRY_REPLACE_OPEN_SHORT");
    out.push(withTotals(replacementEntry));
  }

  // Refresh mark values for all survivors after entries/replacements.
  for (const position of listOpenPositions()) {
    updatePositionMark(position, tickerBySymbol.get(position.symbol), context.nowMs);
  }

  cleanupSymbolState(context.nowMs, new Set(eligibleSymbols));
  return out;
}

export function listExtremeSellPressureV64TrackedSetups(): StrategyTrackedSetup[] {
  return listOpenPositions().map((position) => ({
    key: `${EXTREME_SELL_PRESSURE_V64_CONFIG.strategyId}:${position.positionId}`,
    strategyId: EXTREME_SELL_PRESSURE_V64_CONFIG.strategyId,
    strategyName: EXTREME_SELL_PRESSURE_V64_CONFIG.strategyName,
    symbol: position.symbol,
    phase: "OPEN_SHORT",
    isReady: false,
    score: ENTRY_SCORE,
    payload: {
      action: "OPEN SHORT",
      side: "SHORT",
      positionId: position.positionId,
      entryAtMs: position.entryAtMs,
      entryPrice: position.entryPrice,
      leverage: position.leverage,
      takeProfitPrice: position.entryPrice * (1 - position.takeProfitPct),
      takeProfitPct: toPercent(position.takeProfitPct),
      maxHoldAtMs: position.maxHoldAtMs,
      sellRatio: position.sellRatioAtEntry,
      hourVolume: position.eventVolumeAtEntry,
      sellRatioTimestampMs: position.sellRatioTimestampMs,
      markPrice: position.lastMarkPrice,
      markMovePct: position.lastMarkMovePct,
      markReturnPct: position.lastMarkReturnPct,
    },
    updatedAtMs: position.updatedAtMs,
  }));
}

export function exportExtremeSellPressureV64State(): Record<string, unknown> {
  return {
    openPositions,
    symbolStates,
    summaryStats,
    nextPositionId,
    symbolScanCursor,
    snapshotStats: buildTotalsSnapshot(),
  };
}

export function hydrateExtremeSellPressureV64State(snapshot: unknown): void {
  if (!snapshot || typeof snapshot !== "object") return;
  const typed = snapshot as {
    openPositions?: Record<string, Partial<OpenPosition>>;
    symbolStates?: Record<string, Partial<SymbolSignalState>>;
    summaryStats?: Partial<SummaryStats>;
    nextPositionId?: unknown;
    symbolScanCursor?: unknown;
  };

  for (const key of Object.keys(openPositions)) {
    delete openPositions[key];
  }
  for (const key of Object.keys(symbolStates)) {
    delete symbolStates[key];
  }

  summaryStats.entries = 0;
  summaryStats.missedTrades = 0;
  summaryStats.winners = 0;
  summaryStats.losers = 0;
  summaryStats.liquidated = 0;
  summaryStats.replaced = 0;
  summaryStats.realizedPnlPct = 0;

  if (typed.openPositions && typeof typed.openPositions === "object") {
    for (const [storedKey, raw] of Object.entries(typed.openPositions)) {
      if (!raw || typeof raw !== "object") continue;
      const rawSymbol = typeof raw.symbol === "string" && raw.symbol.trim().length > 0 ? raw.symbol.trim() : null;
      if (!rawSymbol) continue;
      const entryPrice = safeNumber(raw.entryPrice);
      const entryAtMs = safeNumber(raw.entryAtMs);
      const leverage = safeNumber(raw.leverage);
      const maxHoldAtMs = safeNumber(raw.maxHoldAtMs);
      const takeProfitPct = safeNumber(raw.takeProfitPct);
      const sellRatioAtEntry = safeNumber(raw.sellRatioAtEntry);
      const eventVolumeAtEntry = safeNumber(raw.eventVolumeAtEntry);
      const sellRatioTimestampMs = safeNumber(raw.sellRatioTimestampMs);
      if (
        entryPrice === null ||
        entryAtMs === null ||
        leverage === null ||
        maxHoldAtMs === null ||
        takeProfitPct === null ||
        sellRatioAtEntry === null ||
        eventVolumeAtEntry === null ||
        sellRatioTimestampMs === null
      ) {
        continue;
      }

      const positionId = Math.max(1, Math.floor(safeNumber(raw.positionId) ?? 1));
      const positionKey =
        typeof raw.positionKey === "string" && raw.positionKey.trim().length > 0
          ? raw.positionKey.trim()
          : storedKey;

      openPositions[positionKey] = {
        positionKey,
        symbol: rawSymbol,
        positionId,
        entryAtMs: Math.floor(entryAtMs),
        entryPrice,
        leverage,
        takeProfitPct,
        maxHoldAtMs: Math.floor(maxHoldAtMs),
        sellRatioAtEntry,
        eventVolumeAtEntry,
        sellRatioTimestampMs: Math.floor(sellRatioTimestampMs),
        lastMarkPrice: safeNumber(raw.lastMarkPrice) ?? entryPrice,
        lastMarkMovePct: safeNumber(raw.lastMarkMovePct) ?? 0,
        lastMarkReturnPct: safeNumber(raw.lastMarkReturnPct) ?? 0,
        updatedAtMs: Math.floor(safeNumber(raw.updatedAtMs) ?? entryAtMs),
      };
    }
  }

  if (typed.symbolStates && typeof typed.symbolStates === "object") {
    for (const [symbol, raw] of Object.entries(typed.symbolStates)) {
      if (!raw || typeof raw !== "object") continue;
      symbolStates[symbol] = {
        symbol,
        lastProcessedSellRatioTimestampMs: safeNumber(raw.lastProcessedSellRatioTimestampMs),
        lastObservedSellRatio: safeNumber(raw.lastObservedSellRatio),
        lastObservedSellRatioTimestampMs: safeNumber(raw.lastObservedSellRatioTimestampMs),
        lastObservedHourVolume: safeNumber(raw.lastObservedHourVolume),
        updatedAtMs: Math.floor(safeNumber(raw.updatedAtMs) ?? Date.now()),
      };
    }
  }

  if (typed.summaryStats && typeof typed.summaryStats === "object") {
    summaryStats.entries = Math.max(0, Math.floor(safeNumber(typed.summaryStats.entries) ?? 0));
    summaryStats.missedTrades = Math.max(0, Math.floor(safeNumber(typed.summaryStats.missedTrades) ?? 0));
    summaryStats.winners = Math.max(0, Math.floor(safeNumber(typed.summaryStats.winners) ?? 0));
    summaryStats.losers = Math.max(0, Math.floor(safeNumber(typed.summaryStats.losers) ?? 0));
    summaryStats.liquidated = Math.max(0, Math.floor(safeNumber(typed.summaryStats.liquidated) ?? 0));
    summaryStats.replaced = Math.max(0, Math.floor(safeNumber(typed.summaryStats.replaced) ?? 0));
    summaryStats.realizedPnlPct = safeNumber(typed.summaryStats.realizedPnlPct) ?? 0;
  }

  const snapshotNextPositionId = safeNumber(typed.nextPositionId);
  if (snapshotNextPositionId !== null && snapshotNextPositionId >= 1) {
    nextPositionId = Math.floor(snapshotNextPositionId);
  }

  const maxHydratedPositionId =
    Object.values(openPositions).reduce((acc, position) => Math.max(acc, position.positionId), 0) + 1;
  if (nextPositionId < maxHydratedPositionId) {
    nextPositionId = maxHydratedPositionId;
  }

  const snapshotScanCursor = safeNumber(typed.symbolScanCursor);
  if (snapshotScanCursor !== null && snapshotScanCursor >= 0) {
    symbolScanCursor = Math.floor(snapshotScanCursor);
  }
}
