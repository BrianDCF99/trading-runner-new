/**
 * Extreme sell-pressure strategy logic.
 *
 * Live adaptation of the v9 research profile:
 * - trigger: sell_ratio <= 0.20 and latest 1h candle volume >= 1,000,000
 * - short entries only
 * - tp-only (4%), leverage 5x, max hold 48h
 * - max 15 open positions
 * - if at capacity, replace worst mark-return position when mark return <= -5%
 */
import type {
  BybitTicker,
  FundingHistoryPoint,
  Kline1h,
  StrategyContext,
  StrategyTrackedSetup,
} from "../../core/domain/types.js";
import { EXTREME_SELL_PRESSURE_CONFIG } from "./config.js";

const HOUR_MS = 60 * 60 * 1000;
const ENTRY_SCORE = 100;
const CLOSE_SCORE = 85;
const SELL_RATIO_CONCURRENCY = 8;
const FUNDING_HISTORY_CONCURRENCY = 4;

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
  entryMarginUsd: number;
  notionalUsd: number;
  takeProfitPct: number;
  maxHoldAtMs: number;
  sellRatioAtEntry: number;
  eventVolumeAtEntry: number;
  sellRatioTimestampMs: number;
  netFundingFeeUsd: number;
  fundingSettlementsApplied: number;
  lastFundingAppliedAtMs: number | null;
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
  realizedPnlUsd: number;
  netFundingFeeUsd: number;
}

interface PortfolioState {
  startingEquityUsd: number;
  cashUsd: number;
}

interface PortfolioSnapshot {
  currentEquityUsd: number;
  cashUsd: number;
  marginInUseUsd: number;
  openNotionalUsd: number;
  openPositionValueUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  totalPnlUsd: number;
  pnlPct: number;
}

interface TotalsSnapshot {
  entries: number;
  missedTrades: number;
  winners: number;
  losers: number;
  liquidated: number;
  replaced: number;
  startingEquityUsd: number;
  cashUsd: number;
  marginInUseUsd: number;
  openNotionalUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  netFundingFeeUsd: number;
  currentEquityUsd: number;
  totalPnlUsd: number;
  pnlPct: number;
  winPct: number;
  openPositions: number;
}

interface CloseResult {
  signal: ExtremeSellPressureInternalSignal;
  eventType: CloseEventType;
  leveragedReturnPct: number;
  realizedPnlUsd: number;
  netFundingFeeUsd: number;
}

export interface ExtremeSellPressureInternalSignal {
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
  realizedPnlUsd: 0,
  netFundingFeeUsd: 0,
};
const portfolioState: PortfolioState = {
  startingEquityUsd: EXTREME_SELL_PRESSURE_CONFIG.capital.startingEquityUsd,
  cashUsd: EXTREME_SELL_PRESSURE_CONFIG.capital.startingEquityUsd,
};
let nextPositionId = 1;

function listOpenPositions(): OpenPosition[] {
  return Object.values(openPositions);
}

function normalizeOpenPositionsToConfiguredLeverage(nowMs: number): void {
  const configuredLeverage = EXTREME_SELL_PRESSURE_CONFIG.entry.leverage;
  const configuredTakeProfitPct = EXTREME_SELL_PRESSURE_CONFIG.entry.takeProfitPct;
  for (const position of listOpenPositions()) {
    let mutated = false;
    if (position.leverage !== configuredLeverage) {
      position.leverage = configuredLeverage;
      position.notionalUsd = position.entryMarginUsd * configuredLeverage;
      const markMove = computeShortUnleveredReturn(position.entryPrice, position.lastMarkPrice);
      const markReturnPct = computeShortLeveredReturnPct(position.entryPrice, position.lastMarkPrice, configuredLeverage);
      if (markMove !== null) {
        position.lastMarkMovePct = toPercent(markMove);
      }
      if (markReturnPct !== null) {
        position.lastMarkReturnPct = markReturnPct;
      }
      mutated = true;
    }
    if (position.takeProfitPct !== configuredTakeProfitPct) {
      position.takeProfitPct = configuredTakeProfitPct;
      mutated = true;
    }
    if (mutated) {
      position.updatedAtMs = nowMs;
    }
  }
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

function realizedPnlFromLeveredReturn(entryMarginUsd: number, leveragedReturnPct: number): number {
  if (!Number.isFinite(entryMarginUsd) || entryMarginUsd <= 0) return 0;
  if (!Number.isFinite(leveragedReturnPct)) return 0;
  const boundedPct = Math.max(-100, leveragedReturnPct);
  return entryMarginUsd * (boundedPct / 100);
}

function computeOpenPositionUnrealizedPnlUsd(position: OpenPosition): number {
  const leveragedReturnPct = safeNumber(position.lastMarkReturnPct) ?? 0;
  return realizedPnlFromLeveredReturn(position.entryMarginUsd, leveragedReturnPct);
}

function computePositionFundingReturnPct(position: OpenPosition): number {
  if (!Number.isFinite(position.entryMarginUsd) || position.entryMarginUsd <= 0) return 0;
  const netFundingFeeUsd = safeNumber(position.netFundingFeeUsd) ?? 0;
  return (netFundingFeeUsd / position.entryMarginUsd) * 100;
}

function computeOpenPositionReturnPctWithFunding(position: OpenPosition): number {
  const markReturnPct = safeNumber(position.lastMarkReturnPct) ?? 0;
  return markReturnPct + computePositionFundingReturnPct(position);
}

function fundingFeeUsdForShortPosition(notionalUsd: number, fundingRate: number): number {
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return 0;
  if (!Number.isFinite(fundingRate)) return 0;
  // For shorts: positive funding means shorts receive; negative funding means shorts pay.
  return notionalUsd * fundingRate;
}

async function applyFundingForOpenPositions(context: StrategyContext): Promise<void> {
  const positions = listOpenPositions();
  if (positions.length === 0) return;

  const updates = await mapWithConcurrency(positions, FUNDING_HISTORY_CONCURRENCY, async (position) => {
    const anchorMs = position.lastFundingAppliedAtMs ?? position.entryAtMs;
    const startMs = anchorMs + 1;
    if (startMs > context.nowMs) {
      return {
        positionKey: position.positionKey,
        netFundingFeeUsdDelta: 0,
        settlementsApplied: 0,
        lastFundingAppliedAtMs: position.lastFundingAppliedAtMs,
      };
    }

    let history: FundingHistoryPoint[] = [];
    try {
      history = await context.getFundingHistory(position.symbol, startMs, context.nowMs, 200);
    } catch {
      history = [];
    }
    if (history.length === 0) {
      return {
        positionKey: position.positionKey,
        netFundingFeeUsdDelta: 0,
        settlementsApplied: 0,
        lastFundingAppliedAtMs: position.lastFundingAppliedAtMs,
      };
    }

    let netFundingFeeUsdDelta = 0;
    let settlementsApplied = 0;
    let lastFundingAppliedAtMs = position.lastFundingAppliedAtMs;
    const lowerBoundMs = position.lastFundingAppliedAtMs ?? position.entryAtMs;
    for (const point of history) {
      if (!Number.isFinite(point.timestampMs) || !Number.isFinite(point.fundingRate)) continue;
      if (point.timestampMs <= lowerBoundMs) continue;
      netFundingFeeUsdDelta += fundingFeeUsdForShortPosition(position.notionalUsd, point.fundingRate);
      settlementsApplied += 1;
      lastFundingAppliedAtMs = point.timestampMs;
    }

    return {
      positionKey: position.positionKey,
      netFundingFeeUsdDelta,
      settlementsApplied,
      lastFundingAppliedAtMs,
    };
  });

  for (const update of updates) {
    if (update.settlementsApplied <= 0 || update.netFundingFeeUsdDelta === 0) {
      // Preserve checkpoint even when aggregate delta is exactly zero.
      if (update.settlementsApplied > 0) {
        const position = openPositions[update.positionKey];
        if (!position) continue;
        position.fundingSettlementsApplied += update.settlementsApplied;
        position.lastFundingAppliedAtMs = update.lastFundingAppliedAtMs;
        position.updatedAtMs = context.nowMs;
      }
      continue;
    }

    const position = openPositions[update.positionKey];
    if (!position) continue;

    position.netFundingFeeUsd += update.netFundingFeeUsdDelta;
    position.fundingSettlementsApplied += update.settlementsApplied;
    position.lastFundingAppliedAtMs = update.lastFundingAppliedAtMs;
    position.updatedAtMs = context.nowMs;

    summaryStats.netFundingFeeUsd += update.netFundingFeeUsdDelta;
    portfolioState.cashUsd += update.netFundingFeeUsdDelta;
  }
}

function buildPortfolioSnapshot(): PortfolioSnapshot {
  let marginInUseUsd = 0;
  let openNotionalUsd = 0;
  let unrealizedPnlUsd = 0;
  for (const position of listOpenPositions()) {
    marginInUseUsd += position.entryMarginUsd;
    openNotionalUsd += position.notionalUsd;
    unrealizedPnlUsd += computeOpenPositionUnrealizedPnlUsd(position);
  }

  const openPositionValueUsd = marginInUseUsd + unrealizedPnlUsd;
  const currentEquityUsd = portfolioState.cashUsd + openPositionValueUsd;
  const totalPnlUsd = currentEquityUsd - portfolioState.startingEquityUsd;
  const pnlPct =
    portfolioState.startingEquityUsd > 0 ? (totalPnlUsd / portfolioState.startingEquityUsd) * 100 : 0;
  const realizedPnlUsd = summaryStats.realizedPnlUsd + summaryStats.netFundingFeeUsd;

  return {
    currentEquityUsd,
    cashUsd: portfolioState.cashUsd,
    marginInUseUsd,
    openNotionalUsd,
    openPositionValueUsd,
    unrealizedPnlUsd,
    realizedPnlUsd,
    totalPnlUsd,
    pnlPct,
  };
}

function computeEntryMarginUsdForNextTrade(): number | null {
  const portfolio = buildPortfolioSnapshot();
  const targetMarginUsd = portfolio.currentEquityUsd * EXTREME_SELL_PRESSURE_CONFIG.capital.entryMarginPct;
  if (!Number.isFinite(targetMarginUsd) || targetMarginUsd <= 0) return null;
  if (!Number.isFinite(portfolioState.cashUsd) || portfolioState.cashUsd <= 0) return null;
  const entryMarginUsd = Math.min(targetMarginUsd, portfolioState.cashUsd);
  if (!Number.isFinite(entryMarginUsd) || entryMarginUsd <= 0) return null;
  return entryMarginUsd;
}

function buildTotalsSnapshot(): TotalsSnapshot {
  const portfolio = buildPortfolioSnapshot();
  const closedCount = summaryStats.winners + summaryStats.losers + summaryStats.liquidated;
  const winPct = closedCount > 0 ? (summaryStats.winners / closedCount) * 100 : 0;
  return {
    entries: summaryStats.entries,
    missedTrades: summaryStats.missedTrades,
    winners: summaryStats.winners,
    losers: summaryStats.losers,
    liquidated: summaryStats.liquidated,
    replaced: summaryStats.replaced,
    startingEquityUsd: portfolioState.startingEquityUsd,
    cashUsd: portfolio.cashUsd,
    marginInUseUsd: portfolio.marginInUseUsd,
    openNotionalUsd: portfolio.openNotionalUsd,
    unrealizedPnlUsd: portfolio.unrealizedPnlUsd,
    realizedPnlUsd: portfolio.realizedPnlUsd,
    netFundingFeeUsd: summaryStats.netFundingFeeUsd,
    currentEquityUsd: portfolio.currentEquityUsd,
    totalPnlUsd: portfolio.totalPnlUsd,
    pnlPct: portfolio.pnlPct,
    winPct,
    openPositions: listOpenPositions().length,
  };
}

function withTotals(signal: ExtremeSellPressureInternalSignal): ExtremeSellPressureInternalSignal {
  return {
    ...signal,
    data: {
      ...signal.data,
      totals: buildTotalsSnapshot(),
    },
  };
}

function applyEntryToSummary(eventType: EntryEventType): void {
  if (!EXTREME_SELL_PRESSURE_CONFIG.testing.eventDrivenTotals) return;
  summaryStats.entries += 1;
  if (eventType === "ENTRY_REPLACE_OPEN_SHORT") {
    summaryStats.replaced += 1;
  }
}

function applyCloseToSummary(close: CloseResult): void {
  if (!EXTREME_SELL_PRESSURE_CONFIG.testing.eventDrivenTotals) return;
  summaryStats.realizedPnlUsd += close.realizedPnlUsd;
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
  if (!EXTREME_SELL_PRESSURE_CONFIG.testing.eventDrivenTotals) return;
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

  const realizedPnlUsd = realizedPnlFromLeveredReturn(position.entryMarginUsd, leveragedReturnPct);
  const netFundingFeeUsd = safeNumber(position.netFundingFeeUsd) ?? 0;
  const realizedPnlAfterFundingUsd = realizedPnlUsd + netFundingFeeUsd;
  portfolioState.cashUsd += position.entryMarginUsd + realizedPnlUsd;
  if (portfolioState.cashUsd < 0) {
    portfolioState.cashUsd = 0;
  }

  delete openPositions[position.positionKey];

  return {
    eventType,
    leveragedReturnPct,
    realizedPnlUsd,
    netFundingFeeUsd,
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
        entryMarginUsd: position.entryMarginUsd,
        notionalUsd: position.notionalUsd,
        realizedPnlUsd,
        netFundingFeeUsd,
        realizedPnlAfterFundingUsd,
        fundingSettlementsApplied: position.fundingSettlementsApplied,
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
  entryMarginUsd: number;
  extraData?: Record<string, unknown>;
}): ExtremeSellPressureInternalSignal {
  const { candidate, nowMs, eventType, entryMarginUsd, extraData } = input;
  const positionId = nextPositionId;
  const positionKey = `p${positionId}`;
  const leverage = EXTREME_SELL_PRESSURE_CONFIG.entry.leverage;
  const takeProfitPct = EXTREME_SELL_PRESSURE_CONFIG.entry.takeProfitPct;
  const takeProfitPrice = candidate.entryPrice * (1 - takeProfitPct);
  const notionalUsd = entryMarginUsd * leverage;

  const position: OpenPosition = {
    positionKey,
    symbol: candidate.symbol,
    positionId,
    entryAtMs: nowMs,
    entryPrice: candidate.entryPrice,
    leverage,
    entryMarginUsd,
    notionalUsd,
    takeProfitPct,
    maxHoldAtMs: nowMs + EXTREME_SELL_PRESSURE_CONFIG.entry.maxHoldHours * HOUR_MS,
    sellRatioAtEntry: candidate.sellRatio,
    eventVolumeAtEntry: candidate.hourVolume,
    sellRatioTimestampMs: candidate.sellRatioTimestampMs,
    netFundingFeeUsd: 0,
    fundingSettlementsApplied: 0,
    lastFundingAppliedAtMs: null,
    lastMarkPrice: candidate.entryPrice,
    lastMarkMovePct: 0,
    lastMarkReturnPct: 0,
    updatedAtMs: nowMs,
  };
  portfolioState.cashUsd = Math.max(0, portfolioState.cashUsd - entryMarginUsd);
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
      entryMarginUsd: position.entryMarginUsd,
      notionalUsd: position.notionalUsd,
      takeProfitPrice,
      leverage: position.leverage,
      takeProfitPct: toPercent(position.takeProfitPct),
      maxHoldHours: EXTREME_SELL_PRESSURE_CONFIG.entry.maxHoldHours,
      sellRatio: position.sellRatioAtEntry,
      hourVolume: position.eventVolumeAtEntry,
      sellRatioTimestampMs: position.sellRatioTimestampMs,
      markReturnPctWithFunding: computeOpenPositionReturnPctWithFunding(position),
      netFundingFeeUsd: position.netFundingFeeUsd,
      fundingSettlementsApplied: position.fundingSettlementsApplied,
      sellRatioThreshold: EXTREME_SELL_PRESSURE_CONFIG.entry.sellRatioMax,
      volumeThreshold: EXTREME_SELL_PRESSURE_CONFIG.entry.minHourVolume,
      openPositions: listOpenPositions().length,
      ...extraData,
    },
  };
}

function cleanupSymbolState(nowMs: number, activeSymbols: Set<string>): void {
  const retentionMs = EXTREME_SELL_PRESSURE_CONFIG.retention.closedSignalRetentionHours * HOUR_MS;
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
  const thresholdPct = -toPercent(EXTREME_SELL_PRESSURE_CONFIG.portfolio.replaceLosingThresholdPct);
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
    if (sellRatio > EXTREME_SELL_PRESSURE_CONFIG.entry.sellRatioMax) return null;

    const candles = await context.getKlines1h(symbol, EXTREME_SELL_PRESSURE_CONFIG.market.klineLookbackHours);
    const hourVolume = readLatestHourVolume(candles);
    state.lastObservedHourVolume = hourVolume;
    if (hourVolume === null || hourVolume < EXTREME_SELL_PRESSURE_CONFIG.entry.minHourVolume) {
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

export async function evaluateExtremeSellPressureSignals(
  context: StrategyContext
): Promise<ExtremeSellPressureInternalSignal[]> {
  const out: ExtremeSellPressureInternalSignal[] = [];
  const tickerBySymbol = new Map(context.tickers.map((ticker) => [ticker.symbol, ticker]));
  normalizeOpenPositionsToConfiguredLeverage(context.nowMs);
  await applyFundingForOpenPositions(context);

  const naturalExits = processNaturalExits(context, tickerBySymbol);
  for (const close of naturalExits) {
    applyCloseToSummary(close);
    out.push(withTotals(close.signal));
  }

  const eligibleSymbols = sortedEligibleSymbols(context);
  const candidatesRaw = await mapWithConcurrency(eligibleSymbols, SELL_RATIO_CONCURRENCY, (symbol) =>
    evaluateEntryCandidate({ symbol, context, tickerBySymbol })
  );
  const candidates = candidatesRaw.filter((item): item is EntryCandidate => item !== null);
  candidates.sort((a, b) => {
    if (a.sellRatioTimestampMs !== b.sellRatioTimestampMs) return a.sellRatioTimestampMs - b.sellRatioTimestampMs;
    return a.symbol.localeCompare(b.symbol);
  });

  for (const candidate of candidates) {
    markProcessedSellRatio(candidate.symbol, candidate.sellRatioTimestampMs, context.nowMs);

    if (EXTREME_SELL_PRESSURE_CONFIG.portfolio.preventDuplicateSymbolEntries) {
      const symbolAlreadyOpen = listOpenPositions().some((position) => position.symbol === candidate.symbol);
      if (symbolAlreadyOpen) {
        recordMissedTrade();
        continue;
      }
    }

    const openCount = listOpenPositions().length;
    if (openCount < EXTREME_SELL_PRESSURE_CONFIG.portfolio.maxOpenPositions) {
      const entryMarginUsd = computeEntryMarginUsdForNextTrade();
      if (entryMarginUsd === null) {
        recordMissedTrade();
        continue;
      }
      const entry = openPosition({
        candidate,
        nowMs: context.nowMs,
        eventType: "ENTRY_OPEN_SHORT",
        entryMarginUsd,
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
        EXTREME_SELL_PRESSURE_CONFIG.portfolio.replaceLosingThresholdPct
      ),
      extraData: {
        markReturnAtReplacementPct: replacement.markReturnPct,
      },
    });
    applyCloseToSummary(replacementClose);

    const replacementEntryMarginUsd = computeEntryMarginUsdForNextTrade();
    if (replacementEntryMarginUsd === null) {
      recordMissedTrade();
      continue;
    }

    const replacementEntry = openPosition({
      candidate,
      nowMs: context.nowMs,
      eventType: "ENTRY_REPLACE_OPEN_SHORT",
      entryMarginUsd: replacementEntryMarginUsd,
      extraData: {
        replacedSymbol: replacement.symbol,
        replacedPnlPct: replacementClose.leveragedReturnPct,
        replacedPnlUsd: replacementClose.realizedPnlUsd,
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

export function listExtremeSellPressureTrackedSetups(): StrategyTrackedSetup[] {
  return listOpenPositions().map((position) => ({
    key: `${EXTREME_SELL_PRESSURE_CONFIG.strategyId}:${position.positionId}`,
    strategyId: EXTREME_SELL_PRESSURE_CONFIG.strategyId,
    strategyName: EXTREME_SELL_PRESSURE_CONFIG.strategyName,
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
      entryMarginUsd: position.entryMarginUsd,
      notionalUsd: position.notionalUsd,
      takeProfitPrice: position.entryPrice * (1 - position.takeProfitPct),
      takeProfitPct: toPercent(position.takeProfitPct),
      maxHoldAtMs: position.maxHoldAtMs,
      sellRatio: position.sellRatioAtEntry,
      hourVolume: position.eventVolumeAtEntry,
      sellRatioTimestampMs: position.sellRatioTimestampMs,
      markPrice: position.lastMarkPrice,
      markMovePct: position.lastMarkMovePct,
      markReturnPct: position.lastMarkReturnPct,
      markReturnPctWithFunding: computeOpenPositionReturnPctWithFunding(position),
      netFundingFeeUsd: position.netFundingFeeUsd,
      fundingSettlementsApplied: position.fundingSettlementsApplied,
      lastFundingAppliedAtMs: position.lastFundingAppliedAtMs,
    },
    updatedAtMs: position.updatedAtMs,
  }));
}

export function exportExtremeSellPressureState(): Record<string, unknown> {
  return {
    openPositions,
    symbolStates,
    summaryStats,
    portfolioState,
    nextPositionId,
    snapshotStats: buildTotalsSnapshot(),
  };
}

export function hydrateExtremeSellPressureState(snapshot: unknown): void {
  if (!snapshot || typeof snapshot !== "object") return;
  const typed = snapshot as {
    openPositions?: Record<string, Partial<OpenPosition>>;
    symbolStates?: Record<string, Partial<SymbolSignalState>>;
    summaryStats?: Partial<SummaryStats>;
    portfolioState?: Partial<PortfolioState>;
    nextPositionId?: unknown;
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
  summaryStats.realizedPnlUsd = 0;
  summaryStats.netFundingFeeUsd = 0;
  portfolioState.startingEquityUsd = EXTREME_SELL_PRESSURE_CONFIG.capital.startingEquityUsd;
  portfolioState.cashUsd = EXTREME_SELL_PRESSURE_CONFIG.capital.startingEquityUsd;

  const hasHydratedPortfolioState =
    typed.portfolioState !== undefined && typed.portfolioState !== null && typeof typed.portfolioState === "object";
  if (hasHydratedPortfolioState) {
    const hydratedStartingEquityUsd = safeNumber(typed.portfolioState?.startingEquityUsd);
    const hydratedCashUsd = safeNumber(typed.portfolioState?.cashUsd);
    if (hydratedStartingEquityUsd !== null && hydratedStartingEquityUsd > 0) {
      portfolioState.startingEquityUsd = hydratedStartingEquityUsd;
    }
    if (hydratedCashUsd !== null && hydratedCashUsd >= 0) {
      portfolioState.cashUsd = hydratedCashUsd;
    }
  }

  if (typed.openPositions && typeof typed.openPositions === "object") {
    const configuredLeverage = EXTREME_SELL_PRESSURE_CONFIG.entry.leverage;
    const legacyEntryMarginDefaultUsd =
      portfolioState.startingEquityUsd * EXTREME_SELL_PRESSURE_CONFIG.capital.entryMarginPct;
    for (const [storedKey, raw] of Object.entries(typed.openPositions)) {
      if (!raw || typeof raw !== "object") continue;
      const rawSymbol = typeof raw.symbol === "string" && raw.symbol.trim().length > 0 ? raw.symbol.trim() : null;
      if (!rawSymbol) continue;
      const entryPrice = safeNumber(raw.entryPrice);
      const entryAtMs = safeNumber(raw.entryAtMs);
      const maxHoldAtMs = safeNumber(raw.maxHoldAtMs);
      const sellRatioAtEntry = safeNumber(raw.sellRatioAtEntry);
      const eventVolumeAtEntry = safeNumber(raw.eventVolumeAtEntry);
      const sellRatioTimestampMs = safeNumber(raw.sellRatioTimestampMs);
      if (
        entryPrice === null ||
        entryAtMs === null ||
        maxHoldAtMs === null ||
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
      const rawEntryMarginUsd = safeNumber(raw.entryMarginUsd);
      const entryMarginUsd =
        rawEntryMarginUsd !== null && rawEntryMarginUsd > 0
          ? rawEntryMarginUsd
          : hasHydratedPortfolioState
            ? Math.max(0, legacyEntryMarginDefaultUsd)
            : Math.max(0, Math.min(portfolioState.cashUsd, legacyEntryMarginDefaultUsd));
      const lastMarkPrice = safeNumber(raw.lastMarkPrice) ?? entryPrice;
      const hydratedMarkMove = computeShortUnleveredReturn(entryPrice, lastMarkPrice);
      const hydratedMarkReturnPct = computeShortLeveredReturnPct(entryPrice, lastMarkPrice, configuredLeverage);
      const notionalUsd = entryMarginUsd * configuredLeverage;

      openPositions[positionKey] = {
        positionKey,
        symbol: rawSymbol,
        positionId,
        entryAtMs: Math.floor(entryAtMs),
        entryPrice,
        leverage: configuredLeverage,
        entryMarginUsd,
        notionalUsd,
        takeProfitPct: EXTREME_SELL_PRESSURE_CONFIG.entry.takeProfitPct,
        maxHoldAtMs: Math.floor(maxHoldAtMs),
        sellRatioAtEntry,
        eventVolumeAtEntry,
        sellRatioTimestampMs: Math.floor(sellRatioTimestampMs),
        netFundingFeeUsd: safeNumber(raw.netFundingFeeUsd) ?? 0,
        fundingSettlementsApplied: Math.max(0, Math.floor(safeNumber(raw.fundingSettlementsApplied) ?? 0)),
        lastFundingAppliedAtMs: safeNumber(raw.lastFundingAppliedAtMs),
        lastMarkPrice,
        lastMarkMovePct: hydratedMarkMove === null ? 0 : toPercent(hydratedMarkMove),
        lastMarkReturnPct: hydratedMarkReturnPct ?? 0,
        updatedAtMs: Math.floor(safeNumber(raw.updatedAtMs) ?? entryAtMs),
      };
      if (!hasHydratedPortfolioState) {
        portfolioState.cashUsd = Math.max(0, portfolioState.cashUsd - entryMarginUsd);
      }
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
    const realizedPnlUsd = safeNumber(typed.summaryStats.realizedPnlUsd);
    if (realizedPnlUsd !== null) {
      summaryStats.realizedPnlUsd = realizedPnlUsd;
    }
    const netFundingFeeUsd = safeNumber(typed.summaryStats.netFundingFeeUsd);
    if (netFundingFeeUsd !== null) {
      summaryStats.netFundingFeeUsd = netFundingFeeUsd;
    }
  }

  if (EXTREME_SELL_PRESSURE_CONFIG.testing.resetTotalsOnHydrate) {
    summaryStats.entries = 0;
    summaryStats.missedTrades = 0;
    summaryStats.winners = 0;
    summaryStats.losers = 0;
    summaryStats.liquidated = 0;
    summaryStats.replaced = 0;
    summaryStats.realizedPnlUsd = 0;
    summaryStats.netFundingFeeUsd = 0;
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
}
