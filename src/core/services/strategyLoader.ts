/**
 * Dynamically loads strategies from configured directories.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AppConfig, StrategyModule } from "../domain/types.js";
import type { LoggerPort, StrategyLoaderPort } from "../ports/interfaces.js";

interface StrategyFactoryModule {
  createStrategyModule: (deps: { logger: LoggerPort }) => StrategyModule;
}

export class DynamicStrategyLoader implements StrategyLoaderPort {
  constructor(
    private readonly codeRoot: string,
    private readonly logger: LoggerPort
  ) {}

  async loadStrategies(config: AppConfig): Promise<StrategyModule[]> {
    const enabled = config.strategies.filter((strategy) => strategy.enabled);
    const modules: StrategyModule[] = [];

    for (const strategy of enabled) {
      const strategyDir = resolve(this.codeRoot, config.runner.strategyRoot, strategy.directory);
      const entryPath = this.resolveEntry(strategyDir);
      if (!entryPath) {
        this.logger.warn("Strategy entry not found", {
          strategyId: strategy.id,
          strategyDir,
        });
        continue;
      }

      const loaded = (await import(pathToFileURL(entryPath).href)) as StrategyFactoryModule;
      if (typeof loaded.createStrategyModule !== "function") {
        this.logger.warn("Strategy module missing createStrategyModule export", {
          strategyId: strategy.id,
          entryPath,
        });
        continue;
      }

      const module = loaded.createStrategyModule({ logger: this.logger });
      modules.push(module);
      this.logger.info("Strategy loaded", {
        strategyId: module.id,
        strategyName: module.name,
      });
    }

    return modules;
  }

  private resolveEntry(strategyDir: string): string | null {
    const candidates = [resolve(strategyDir, "index.ts"), resolve(strategyDir, "index.js")];
    for (const filePath of candidates) {
      if (existsSync(filePath)) return filePath;
    }
    return null;
  }
}
