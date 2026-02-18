/**
 * Creates the full runtime graph from config and adapters.
 */
import { config as loadDotEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "../config/loadConfig.js";
import { ConsoleLogger } from "../infrastructure/logging/consoleLogger.js";
import { BybitPublicClient } from "../infrastructure/market/bybitPublicClient.js";
import { TelegramNotifier } from "../infrastructure/notifications/telegramNotifier.js";
import { createSupabaseServiceClient } from "../infrastructure/storage/supabaseClient.js";
import { SupabaseRuntimeStore } from "../infrastructure/storage/supabaseRuntimeStore.js";
import { SupabaseStateStore } from "../infrastructure/storage/supabaseStateStore.js";
import { DynamicStrategyLoader } from "../core/services/strategyLoader.js";
import { RunnerService } from "../core/services/runner.js";
import type { AppConfig } from "../core/domain/types.js";
import type { RuntimeStorePort, StateStorePort } from "../core/ports/interfaces.js";

function readEnv(name: string): string | null {
  const raw = process.env[name];
  if (!raw) return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

export async function bootstrapRunner(): Promise<{
  runner: RunnerService;
  notifier: TelegramNotifier;
  runtimeStore: RuntimeStorePort;
  logger: ConsoleLogger;
  config: AppConfig;
  runnerName: string;
}> {
  const codeRoot = dirname(fileURLToPath(import.meta.url));
  const srcRoot = resolve(codeRoot, "..");
  const projectRoot = resolve(srcRoot, "..");
  loadDotEnv({ path: resolve(projectRoot, ".env") });
  loadDotEnv({ path: resolve(projectRoot, ".env.local"), override: true });

  const logger = new ConsoleLogger();
  const config = await loadAppConfig(projectRoot);
  const runnerName = readEnv("RUNNER_NAME") ?? config.runner.name;
  const scanIntervalMsEnv = Number.parseInt(process.env.SCAN_INTERVAL_MS ?? "", 10);
  const scanIntervalMs =
    Number.isFinite(scanIntervalMsEnv) && scanIntervalMsEnv > 0
      ? scanIntervalMsEnv
      : config.runner.scanIntervalSeconds * 1000;

  const marketData = new BybitPublicClient(
    readEnv("BYBIT_API_BASE") ?? config.exchange.bybit.apiBase,
    config.exchange.bybit.requestTimeoutMs
  );

  const telegramBotToken = readEnv("TELEGRAM_BOT_TOKEN");
  const telegramChatId = readEnv("TELEGRAM_CHAT_ID");
  const notifier = new TelegramNotifier({
    enabled: config.telegram.enabled,
    botToken: telegramBotToken,
    chatId: telegramChatId,
    parseMode: config.telegram.parseMode,
    sendDelayMs: config.telegram.sendDelayMs,
  });
  logger.info("Telegram notifier config", {
    enabled: config.telegram.enabled,
    hasBotToken: Boolean(telegramBotToken),
    hasChatId: Boolean(telegramChatId),
  });

  const supabaseClient = createSupabaseServiceClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  if (!supabaseClient) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for trading-runner-new parity mode."
    );
  }

  const stateStore: StateStorePort = new SupabaseStateStore(supabaseClient, "bybit");
  const runtimeStore: RuntimeStorePort = new SupabaseRuntimeStore(supabaseClient, "bybit");

  const strategyLoader = new DynamicStrategyLoader(srcRoot, logger);
  const strategies = await strategyLoader.loadStrategies(config);

  const runner = new RunnerService({
    runnerName,
    exchange: "bybit",
    scanIntervalMs,
    logger,
    marketData,
    notifier,
    stateStore,
    runtimeStore,
    strategies,
  });

  logger.info("Runner bootstrapped", {
    strategyCount: strategies.length,
    scanIntervalSeconds: config.runner.scanIntervalSeconds,
  });

  return { runner, notifier, runtimeStore, logger, config, runnerName };
}
