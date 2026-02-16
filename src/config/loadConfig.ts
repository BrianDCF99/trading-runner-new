/**
 * Reads YAML config and maps snake_case fields to domain config types.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import yaml from "js-yaml";
import { appConfigSchema } from "./schema.js";
import type { AppConfig } from "../core/domain/types.js";

export async function loadAppConfig(projectRoot: string): Promise<AppConfig> {
  const configPath = process.env.RUNNER_CONFIG_PATH ?? "config/app.yaml";
  const absolutePath = resolve(projectRoot, configPath);
  const rawFile = await readFile(absolutePath, "utf8");
  const parsed = yaml.load(rawFile);
  const raw = appConfigSchema.parse(parsed);

  return {
    runner: {
      name: raw.runner.name,
      timezone: raw.runner.timezone,
      scanIntervalSeconds: raw.runner.scan_interval_seconds,
      strategyRoot: raw.runner.strategy_root,
    },
    strategies: raw.strategies.map((strategy) => ({
      id: strategy.id,
      enabled: strategy.enabled,
      directory: strategy.directory,
    })),
    exchange: {
      bybit: {
        enabled: raw.exchange.bybit.enabled,
        apiBase: raw.exchange.bybit.api_base,
        requestTimeoutMs: raw.exchange.bybit.request_timeout_ms,
      },
    },
    telegram: {
      enabled: raw.telegram.enabled,
      parseMode: raw.telegram.parse_mode,
      sendDelayMs: raw.telegram.send_delay_ms,
    },
  };
}
