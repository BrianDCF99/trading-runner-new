/**
 * Creates the full runtime graph from config and adapters.
 */
import "dotenv/config";
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

  const logger = new ConsoleLogger();
  const config = await loadAppConfig(projectRoot);
  const runnerName = process.env.RUNNER_NAME?.trim() || config.runner.name;
  const scanIntervalMsEnv = Number.parseInt(process.env.SCAN_INTERVAL_MS ?? "", 10);
  const scanIntervalMs =
    Number.isFinite(scanIntervalMsEnv) && scanIntervalMsEnv > 0
      ? scanIntervalMsEnv
      : config.runner.scanIntervalSeconds * 1000;

  const marketData = new BybitPublicClient(
    process.env.BYBIT_API_BASE ?? config.exchange.bybit.apiBase,
    config.exchange.bybit.requestTimeoutMs
  );

  const notifier = new TelegramNotifier({
    enabled: config.telegram.enabled,
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? null,
    chatId: process.env.TELEGRAM_CHAT_ID ?? null,
    parseMode: config.telegram.parseMode,
    sendDelayMs: config.telegram.sendDelayMs,
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
