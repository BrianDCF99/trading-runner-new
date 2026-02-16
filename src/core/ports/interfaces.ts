/**
 * Ports used by application services.
 */
import type {
  AppConfig,
  BybitInstrument,
  BybitTicker,
  CycleRunResult,
  ExchangeName,
  ExistingSetupState,
  ExecutionDecision,
  Kline1h,
  MarketStateRow,
  PendingExecutionPrompt,
  ScanRunRecord,
  RunnerStatusSnapshot,
  RunnerTrigger,
  RuntimeSetupSnapshot,
  SetupEventRecord,
  StrategyConfigSnapshot,
  StrategyModule,
} from "../domain/types.js";

export interface LoggerPort {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

export interface MarketDataPort {
  getTickers(): Promise<BybitTicker[]>;
  getInstruments(): Promise<BybitInstrument[]>;
  getKlines1h(symbol: string, limit: number): Promise<Kline1h[]>;
}

export interface InlineKeyboardButton {
  text: string;
  callbackData: string;
}

export interface NotifierPort {
  notify(lines: string[]): Promise<number>;
  sendMessage(
    text: string,
    options?: {
      chatId?: string;
      inlineKeyboard?: InlineKeyboardButton[][];
    }
  ): Promise<number | null>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}

export interface StateStorePort {
  load(): Promise<Record<string, unknown>>;
  save(snapshot: Record<string, unknown>): Promise<void>;
}

export interface RuntimeStorePort {
  getStrategyConfig(exchange: ExchangeName): Promise<StrategyConfigSnapshot | null>;
  recordScanRun(run: ScanRunRecord): Promise<void>;
  getExistingSetups(setupKeys: string[]): Promise<Map<string, ExistingSetupState>>;
  insertSetupEvents(events: SetupEventRecord[]): Promise<void>;
  upsertMarketState(rows: MarketStateRow[]): Promise<void>;
  getStatus(exchange: ExchangeName, runnerName: string): Promise<RunnerStatusSnapshot>;
  saveStatus(status: RunnerStatusSnapshot): Promise<void>;
  upsertSetups(exchange: ExchangeName, setups: RuntimeSetupSnapshot[]): Promise<void>;
  getActiveSetups(input: { exchange: ExchangeName; strategyIds?: string[]; limit: number }): Promise<RuntimeSetupSnapshot[]>;
  getReadySetups(exchange: ExchangeName, limit: number): Promise<RuntimeSetupSnapshot[]>;
  recordExecutionDecisionDefault(input: {
    decisionId: string;
    exchange: ExchangeName;
    runnerName: string;
    setup: RuntimeSetupSnapshot;
    decisionReason: string;
    telegramChatId?: string;
    telegramMessageId?: number | null;
  }): Promise<void>;
  updateExecutionDecision(input: {
    decisionId: string;
    decision: "filled" | "not_filled";
    telegramChatId?: string;
    telegramMessageId?: number;
    telegramUserId?: number;
  }): Promise<boolean>;
  getPendingExecutionPrompts(exchange: ExchangeName, limit: number): Promise<PendingExecutionPrompt[]>;
  getSetupKeysWithDeliveredExecutionPrompts(exchange: ExchangeName, setupKeys: string[]): Promise<Set<string>>;
  getPositionsForMember(input: {
    exchange: ExchangeName;
    chatId: string;
    userId: number;
    limit: number;
  }): Promise<RuntimeSetupSnapshot[]>;
  getExecutionDecision(decisionId: string): Promise<ExecutionDecision | null>;
}

export interface StrategyLoaderPort {
  loadStrategies(config: AppConfig): Promise<StrategyModule[]>;
}

export interface RunnerPort {
  start(): Promise<void>;
  runOnce(trigger: RunnerTrigger): Promise<CycleRunResult>;
  getWatchingSnapshot(kind: "new" | "funding" | "long25"): Promise<string>;
}
