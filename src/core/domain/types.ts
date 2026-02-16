/**
 * Shared domain types for runner orchestration and strategy execution.
 */

export type ExchangeName = "bybit";
export type RunnerTrigger = "startup" | "interval" | "manual";

export interface BybitTicker {
  symbol: string;
  lastPrice: number;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  turnover24h: number;
  volume24h: number;
  price24hPcnt: number;
  nextFundingTimeMs: number;
  openInterest: number;
}

export interface BybitInstrument {
  symbol: string;
  launchTimeMs: number | null;
  status: string;
  contractType?: string;
  fundingIntervalMinutes?: number | null;
}

export interface Kline1h {
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
}

export interface StrategyContext {
  nowMs: number;
  tickers: BybitTicker[];
  instruments: BybitInstrument[];
  getKlines1h(symbol: string, limit: number): Promise<Kline1h[]>;
}

export interface StrategySignal {
  strategyId: string;
  strategyName: string;
  symbol: string;
  phase: string;
  isReady: boolean;
  score: number;
  generatedAtMs: number;
  data: Record<string, unknown>;
}

export interface StrategyTrackedSetup {
  key: string;
  strategyId?: string;
  strategyName?: string;
  symbol: string;
  phase: string;
  isReady: boolean;
  score: number;
  payload: Record<string, unknown>;
  updatedAtMs?: number;
}

export interface StrategyModule {
  id: string;
  name: string;
  exchange: ExchangeName;
  strategyIds?: string[];
  trackerStateKey?: string;
  evaluate(context: StrategyContext): Promise<StrategySignal[]>;
  formatSignals(signals: StrategySignal[]): string[];
  listTrackedSetups?(): StrategyTrackedSetup[];
  exportState?(): Record<string, unknown>;
  hydrateState?(snapshot: unknown): void;
}

export interface RuntimeSetupSnapshot {
  key: string;
  exchange: ExchangeName;
  strategyId: string;
  strategyName: string;
  symbol: string;
  phase: string;
  isReady: boolean;
  score: number;
  payload: Record<string, unknown>;
  updatedAt: string;
  active: boolean;
}

export interface RunnerStatusSnapshot {
  exchange: ExchangeName;
  runnerName: string;
  state: "ok" | "error" | "idle";
  lastHeartbeat: string | null;
  lastRunAt: string | null;
  lastRunDurationMs: number | null;
  setupCount: number;
  readySetupCount: number;
  lastError: string | null;
}

export interface ExecutionDecision {
  id: string;
  exchange: ExchangeName;
  setupKey: string;
  strategyId: string;
  symbol: string;
  phase: string;
  decision: "filled" | "not_filled";
  decisionSource: "default_no_reply" | "telegram_button";
  decisionReason: string | null;
  telegramChatId: string | null;
  telegramMessageId: number | null;
  telegramUserId: number | null;
  createdAt: string;
  decidedAt: string;
}

export interface PendingExecutionPrompt {
  decisionId: string;
  setup: RuntimeSetupSnapshot;
}

export interface StrategyConfigSnapshot {
  hasConfig: boolean;
  enabledIds: Set<string>;
  disabledIds: Set<string>;
}

export interface ExistingSetupState {
  key: string;
  phase: string;
  isReady: boolean;
}

export interface SetupEventRecord {
  exchange: ExchangeName;
  setupKey: string;
  strategyId: string;
  eventType: "NEW" | "PHASE_CHANGE" | "READY";
  message: string;
  payload?: Record<string, unknown>;
}

export interface MarketStateRow {
  exchange: ExchangeName;
  symbol: string;
  price: number;
  change24h: number;
  fundingRate: number;
  nextFundingTime: number;
  openInterest: number;
  volume24h: number;
  updatedAt: string;
}

export interface ScanRunRecord {
  exchange: ExchangeName;
  runnerName: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: "ok" | "error";
  error?: string;
  setupCount: number;
  readySetupCount: number;
  meta?: Record<string, unknown>;
}

export interface CycleRunResult {
  trigger: RunnerTrigger;
  executed: boolean;
  signalCount: number;
  readyCount: number;
  durationMs: number;
  signals: StrategySignal[];
  error?: string;
}

export interface BotCommand {
  chatId: string;
  fromUserId: number;
  text: string;
  command: string;
  args: string[];
  updateId: number;
}

export interface BotCallback {
  callbackQueryId: string;
  chatId: string;
  messageId: number;
  data: string;
  fromUserId: number;
  updateId: number;
}

export interface StrategyDirectoryConfig {
  id: string;
  enabled: boolean;
  directory: string;
}

export interface RunnerConfig {
  name: string;
  timezone: string;
  scanIntervalSeconds: number;
  strategyRoot: string;
}

export interface ExchangeConfig {
  bybit: {
    enabled: boolean;
    apiBase: string;
    requestTimeoutMs: number;
  };
}

export interface TelegramConfig {
  enabled: boolean;
  parseMode: "HTML" | "Markdown" | "MarkdownV2";
  sendDelayMs: number;
}

export interface AppConfig {
  runner: RunnerConfig;
  strategies: StrategyDirectoryConfig[];
  exchange: ExchangeConfig;
  telegram: TelegramConfig;
}
