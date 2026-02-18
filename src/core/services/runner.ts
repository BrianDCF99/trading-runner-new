/**
 * Main orchestration loop:
 * - fetches market snapshot
 * - evaluates enabled strategies
 * - emits strategy alerts
 * - updates runtime status/setups
 * - records execution prompts
 */
import { randomUUID } from "node:crypto";
import type {
  CycleRunResult,
  ExistingSetupState,
  MarketStateRow,
  RunnerStatusSnapshot,
  RuntimeSetupSnapshot,
  ScanRunRecord,
  SetupEventRecord,
  StrategyConfigSnapshot,
  StrategyContext,
  StrategySignal,
} from "../domain/types.js";
import type {
  LoggerPort,
  MarketDataPort,
  NotifierPort,
  RunnerPort,
  RuntimeStorePort,
  StateStorePort,
} from "../ports/interfaces.js";
import type { StrategyModule } from "../domain/types.js";
import { escapeHtml, formatSymbolLink } from "../utils/telegramSymbolLink.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NEW_LISTING_4H_MS = 4 * HOUR_MS;
const NEW_LISTING_8H_MS = 8 * HOUR_MS;
const NEW_LISTING_CLOSE_MS = 14 * DAY_MS;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isCheckpoint4hProcessed(setup: RuntimeSetupSnapshot): boolean {
  return setup.payload.checkpoint4hProcessed === true;
}

function isNewListingS7WatchCandidate(setup: RuntimeSetupSnapshot): boolean {
  if (setup.phase !== "WATCHING") return false;
  if (setup.strategyId !== "bybit:new-listing:s7-pumpdump:v2") return false;
  return isCheckpoint4hProcessed(setup);
}

function sortSnapshotSection(
  kind: "new" | "funding" | "long25" | "extremeFunding" | "sellPressure",
  sectionLabel: string,
  setups: RuntimeSetupSnapshot[]
): RuntimeSetupSnapshot[] {
  const sorted = [...setups];
  if (kind !== "new" || sectionLabel !== "WATCHING") {
    sorted.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return sorted;
  }

  sorted.sort((a, b) => {
    const aProcessed = isCheckpoint4hProcessed(a);
    const bProcessed = isCheckpoint4hProcessed(b);
    if (aProcessed !== bProcessed) return aProcessed ? 1 : -1;
    return a.symbol.localeCompare(b.symbol);
  });
  return sorted;
}

function readNumericPayload(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function percentFrom(base: number | null, current: number | null): number | null {
  if (base === null || current === null || !Number.isFinite(base) || base <= 0) return null;
  return (current - base) / base;
}

function formatSignedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

function formatCountdown(targetMs: number | null, nowMs: number): string {
  if (targetMs === null || !Number.isFinite(targetMs)) return "n/a";
  const remainingMs = Math.max(0, targetMs - nowMs);
  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}:${String(minutes).padStart(2, "0")}`;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function formatElapsed(startMs: number | null, nowMs: number): string {
  if (startMs === null || !Number.isFinite(startMs)) return "n/a";
  const elapsedMs = Math.max(0, nowMs - startMs);
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function formatPercent(value: number | null, digits = 3): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(digits)}%`;
}

function formatFundingIntervalLabel(minutes: number | null): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return "unknown";
  const roundedMinutes = Math.max(0, Math.floor(minutes));
  const hours = Math.floor(roundedMinutes / 60);
  const remainderMinutes = roundedMinutes % 60;
  if (remainderMinutes === 0) return `${hours}h`;
  return `${hours}:${String(remainderMinutes).padStart(2, "0")}`;
}

function formatExtremeFundingSnapshotRow(exchange: "bybit", setup: RuntimeSetupSnapshot): string {
  const symbolLink = formatSymbolLink(exchange, setup.symbol);
  const fundingRate = readNumericPayload(setup.payload, "fundingRate");
  const fundingIntervalMinutes = readNumericPayload(setup.payload, "fundingIntervalMinutes");
  const extremeStreak = readNumericPayload(setup.payload, "extremeStreak") ?? readNumericPayload(setup.payload, "extremeWindowsInRow");
  const priceChangeSinceLastNotification = readNumericPayload(setup.payload, "priceChangeSinceLastNotification");
  const priceChangeSinceFirstNotificationInStreak = readNumericPayload(
    setup.payload,
    "priceChangeSinceFirstNotificationInStreak"
  );
  const payloadSettlement = setup.payload.settlementLabel;
  const intervalLabel = formatFundingIntervalLabel(fundingIntervalMinutes);
  const settlementLabel =
    intervalLabel !== "unknown"
      ? intervalLabel
      : typeof payloadSettlement === "string" && payloadSettlement.trim().length > 0
        ? payloadSettlement.trim()
        : "unknown";
  const streakLabel =
    extremeStreak === null ? "n/a" : `${Math.max(0, Math.floor(extremeStreak))}`;
  return `${symbolLink} | ${formatPercent(fundingRate)} | ${escapeHtml(settlementLabel)} | streak ${streakLabel} | ${formatSignedPercent(priceChangeSinceLastNotification)} | ${formatSignedPercent(priceChangeSinceFirstNotificationInStreak)}`;
}

function formatNewListingSnapshotRow(exchange: "bybit", sectionLabel: string, setup: RuntimeSetupSnapshot, nowMs: number): string {
  const symbolLink = formatSymbolLink(exchange, setup.symbol);
  const launchTimeMs = readNumericPayload(setup.payload, "launchTimeMs");
  const checkpoint4hPrice = readNumericPayload(setup.payload, "checkpoint4hPrice");
  const checkpoint8hPrice = readNumericPayload(setup.payload, "checkpoint8hPrice");
  const lastPrice = readNumericPayload(setup.payload, "lastPrice");

  if (sectionLabel === "WATCHING") {
    const s7Watch = isNewListingS7WatchCandidate(setup);
    const targetMs = launchTimeMs === null ? null : launchTimeMs + (s7Watch ? NEW_LISTING_8H_MS : NEW_LISTING_4H_MS);
    const marker = s7Watch ? "* " : "";
    return `${marker}${symbolLink} | ${formatCountdown(targetMs, nowMs)}`;
  }

  if (sectionLabel === "LEG1") {
    const change = percentFrom(checkpoint4hPrice, lastPrice);
    const leg2Ms = launchTimeMs === null ? null : launchTimeMs + NEW_LISTING_8H_MS;
    return `${symbolLink} | ${formatSignedPercent(change)} | ${formatCountdown(leg2Ms, nowMs)}`;
  }

  if (sectionLabel === "LEG2" || sectionLabel === "S7") {
    const referencePrice = checkpoint8hPrice ?? checkpoint4hPrice;
    const change = percentFrom(referencePrice, lastPrice);
    const closeMs = launchTimeMs === null ? null : launchTimeMs + NEW_LISTING_CLOSE_MS;
    return `${symbolLink} | ${formatSignedPercent(change)} | ${formatCountdown(closeMs, nowMs)}`;
  }

  return symbolLink;
}

function setupKey(strategyId: string, symbol: string): string {
  return `${strategyId}:${symbol}`;
}

function resolveSetupActionLabel(setup: RuntimeSetupSnapshot): string {
  const payloadAction = setup.payload.action;
  if (typeof payloadAction === "string" && payloadAction.trim().length > 0) {
    return payloadAction.trim();
  }
  const payloadSide = setup.payload.side;
  if (typeof payloadSide === "string" && payloadSide.toUpperCase() === "LONG") {
    return "OPEN LONG";
  }
  return "OPEN SHORT";
}

function resolveModuleStrategyIds(strategy: StrategyModule): string[] {
  if (strategy.strategyIds && strategy.strategyIds.length > 0) return strategy.strategyIds;
  return [strategy.id];
}

function hasConfiguredEntry(snapshot: StrategyConfigSnapshot, strategyId: string): boolean {
  return snapshot.enabledIds.has(strategyId) || snapshot.disabledIds.has(strategyId);
}

function buildSetupEvents(
  exchange: "bybit",
  currentSetups: RuntimeSetupSnapshot[],
  existingMap: Map<string, ExistingSetupState>
): SetupEventRecord[] {
  const events: SetupEventRecord[] = [];

  for (const setup of currentSetups) {
    const prev = existingMap.get(setup.key);
    if (!prev) {
      events.push({
        exchange,
        setupKey: setup.key,
        strategyId: setup.strategyId,
        eventType: "NEW",
        message: `New setup ${setup.symbol} (${setup.strategyName}) phase=${setup.phase}`,
        payload: setup.payload,
      });
      if (setup.isReady) {
        events.push({
          exchange,
          setupKey: setup.key,
          strategyId: setup.strategyId,
          eventType: "READY",
          message: `Setup READY ${setup.symbol} (${setup.strategyName})`,
          payload: setup.payload,
        });
      }
      continue;
    }

    if (prev.phase !== setup.phase) {
      events.push({
        exchange,
        setupKey: setup.key,
        strategyId: setup.strategyId,
        eventType: "PHASE_CHANGE",
        message: `Setup phase changed ${setup.symbol} ${prev.phase} -> ${setup.phase}`,
        payload: setup.payload,
      });
    }

    if (!prev.isReady && setup.isReady) {
      events.push({
        exchange,
        setupKey: setup.key,
        strategyId: setup.strategyId,
        eventType: "READY",
        message: `Setup became READY ${setup.symbol} (${setup.strategyName})`,
        payload: setup.payload,
      });
    }
  }

  return events;
}

export class RunnerService implements RunnerPort {
  private running = false;
  private cycleInProgress = false;

  constructor(
    private readonly options: {
      runnerName: string;
      exchange: "bybit";
      scanIntervalMs: number;
      logger: LoggerPort;
      marketData: MarketDataPort;
      notifier: NotifierPort;
      stateStore: StateStorePort;
      runtimeStore: RuntimeStorePort;
      strategies: StrategyModule[];
    }
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.hydrateState();
    await this.runOnce("startup");

    while (this.running) {
      await sleep(this.options.scanIntervalMs);
      await this.runOnce("interval");
    }
  }

  async runOnce(trigger: "startup" | "interval" | "manual"): Promise<CycleRunResult> {
    if (this.cycleInProgress) {
      this.options.logger.warn("Cycle skipped because previous cycle is still running", { trigger });
      return {
        trigger,
        executed: false,
        signalCount: 0,
        readyCount: 0,
        durationMs: 0,
        signals: [],
      };
    }

    const startedAtMs = Date.now();
    this.cycleInProgress = true;
    this.options.logger.info("Starting scan cycle", { trigger });

    try {
      const [tickers, instruments] = await Promise.all([
        this.options.marketData.getTickers(),
        this.options.marketData.getInstruments(),
      ]);

      const context: StrategyContext = {
        nowMs: Date.now(),
        tickers,
        instruments,
        getKlines1h: (symbol: string, limit: number) => this.options.marketData.getKlines1h(symbol, limit),
        getSellRatio1h: (symbol: string) => this.options.marketData.getSellRatio1h(symbol),
      };

      const strategyConfig = await this.options.runtimeStore.getStrategyConfig(this.options.exchange);
      const runnableStrategies = this.options.strategies.filter((strategy) => {
        if (!strategyConfig || !strategyConfig.hasConfig) return true;
        const ids = resolveModuleStrategyIds(strategy);
        const hasEnabled = ids.some((id) => strategyConfig.enabledIds.has(id));
        if (hasEnabled) return true;
        const configured = ids.some((id) => hasConfiguredEntry(strategyConfig, id));
        return !configured;
      });

      const allSignals: StrategySignal[] = [];
      for (const strategy of runnableStrategies) {
        const signals = await strategy.evaluate(context);
        allSignals.push(...signals);

        const lines = strategy.formatSignals(signals);
        if (lines.length > 0) {
          const sent = await this.options.notifier.notify(lines);
          if (sent < lines.length) {
            this.options.logger.warn("Telegram alert delivery mismatch", {
              strategyId: strategy.id,
              expectedMessages: lines.length,
              sentMessages: sent,
            });
          }
        }
      }

      const setups = this.collectTrackedSetups(context.nowMs, allSignals, runnableStrategies);
      const existingSetups = await this.options.runtimeStore.getExistingSetups(
        setups.map((setup) => setup.key)
      );
      const events = buildSetupEvents(this.options.exchange, setups, existingSetups);
      await this.options.runtimeStore.upsertSetups(this.options.exchange, setups);
      await this.options.runtimeStore.insertSetupEvents(events);
      const marketRows: MarketStateRow[] = tickers.map((ticker) => ({
        exchange: this.options.exchange,
        symbol: ticker.symbol,
        price: ticker.lastPrice,
        change24h: ticker.price24hPcnt * 100,
        fundingRate: ticker.fundingRate,
        nextFundingTime: ticker.nextFundingTimeMs,
        openInterest: ticker.openInterest,
        volume24h: ticker.volume24h,
        updatedAt: new Date(context.nowMs).toISOString(),
      }));
      await this.options.runtimeStore.upsertMarketState(marketRows);
      await this.persistState();
      await this.sendReadyPrompts(trigger, setups, allSignals);

      const finishedAtMs = Date.now();
      const durationMs = finishedAtMs - startedAtMs;
      const readyCount = setups.filter((setup) => setup.isReady).length;
      const status: RunnerStatusSnapshot = {
        exchange: this.options.exchange,
        runnerName: this.options.runnerName,
        state: "ok",
        lastHeartbeat: new Date(finishedAtMs).toISOString(),
        lastRunAt: new Date(finishedAtMs).toISOString(),
        lastRunDurationMs: durationMs,
        setupCount: setups.length,
        readySetupCount: readyCount,
        lastError: null,
      };
      await this.options.runtimeStore.saveStatus(status);

      const runRecord: ScanRunRecord = {
        exchange: this.options.exchange,
        runnerName: this.options.runnerName,
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs,
        status: "ok",
        setupCount: setups.length,
        readySetupCount: readyCount,
        meta: {
          tickerCount: tickers.length,
          instrumentCount: instruments.length,
          strategyCount: runnableStrategies.length,
          enabledStrategyCount: strategyConfig?.hasConfig ? strategyConfig.enabledIds.size : 0,
        },
      };
      await this.options.runtimeStore.recordScanRun(runRecord);

      this.options.logger.info("Scan cycle completed", {
        trigger,
        durationMs,
        signalCount: allSignals.length,
        readyCount,
        setupCount: setups.length,
        strategyCount: runnableStrategies.length,
      });

      return {
        trigger,
        executed: true,
        signalCount: allSignals.length,
        readyCount,
        durationMs,
        signals: allSignals,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAtMs;
      const message = error instanceof Error ? error.message : String(error);
      const finishedAtMs = Date.now();
      await this.options.runtimeStore.saveStatus({
        exchange: this.options.exchange,
        runnerName: this.options.runnerName,
        state: "error",
        lastHeartbeat: new Date(finishedAtMs).toISOString(),
        lastRunAt: new Date(finishedAtMs).toISOString(),
        lastRunDurationMs: durationMs,
        setupCount: 0,
        readySetupCount: 0,
        lastError: message,
      });
      await this.options.runtimeStore.recordScanRun({
        exchange: this.options.exchange,
        runnerName: this.options.runnerName,
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs,
        status: "error",
        error: message,
        setupCount: 0,
        readySetupCount: 0,
      });
      this.options.logger.error("Scan cycle failed", {
        trigger,
        durationMs,
        error: message,
      });
      return {
        trigger,
        executed: true,
        signalCount: 0,
        readyCount: 0,
        durationMs,
        signals: [],
        error: message,
      };
    } finally {
      this.cycleInProgress = false;
    }
  }

  async getWatchingSnapshot(kind: "new" | "funding" | "long25" | "extremeFunding" | "sellPressure"): Promise<string> {
    const catalog =
      kind === "new"
        ? {
            title: "Bybit New Listing Short (FINAL)",
            strategyIds: [
              "bybit:new-listing-suite:v2",
              "bybit:new-listing:red4h-hivol:v2",
              "bybit:new-listing:s7-pumpdump:v2",
            ],
            sections: [
              { label: "WATCHING", phases: ["WATCHING"] },
              { label: "LEG1", phases: ["READY_LEG1"] },
              { label: "LEG2", phases: ["READY_LEG2"] },
              { label: "S7", phases: ["READY_S7"] },
              { label: "CLOSED", phases: ["CLOSED"] },
            ],
            subtitle: "👀 <b>Watching</b>",
          }
        : kind === "funding"
          ? {
              title: "Bybit Funding Rule I v7",
              strategyIds: [
                "bybit:funding:rule-i:v7",
                "bybit:funding-suite:v7",
                "bybit:funding-rule-i:v7",
              ],
              sections: [
                { label: "WATCHING", phases: ["WATCHING"] },
                { label: "READY", phases: ["READY"] },
                { label: "CLOSED", phases: ["CLOSED"] },
              ],
              subtitle: "👀 <b>Watching</b>",
            }
          : kind === "extremeFunding"
            ? {
                title: "Bybit Extreme Funding Alerts",
                strategyIds: ["bybit:extreme-funding-suite:v1", "bybit:extreme-funding:alerts:v1"],
                sections: [{ label: "ALERT", phases: ["ALERT"] }],
                subtitle: "🚨 <b>Triggered Alerts</b>",
              }
            : kind === "sellPressure"
              ? {
                  title: "Bybit Extreme Sell Pressure v6.4",
                  strategyIds: [
                    "bybit:extreme-sell-pressure-suite:v64",
                    "bybit:extreme-sell-pressure:v64",
                    "bybit:extreme-sell-pressure-suite:v43",
                    "bybit:extreme-sell-pressure:v43",
                  ],
                  sections: [{ label: "OPEN SHORT", phases: ["OPEN_SHORT"] }],
                  subtitle: "📉 <b>Open Positions</b>",
                }
            : {
                title: "Bybit Long Strategy V_vol25_min1",
                strategyIds: ["bybit:long25-suite:v1", "bybit:long25:v1"],
                sections: [{ label: "READY", phases: ["READY"] }],
                subtitle: "📈 <b>READY Entries</b>",
              };

    const tracked = await this.options.runtimeStore.getActiveSetups({
      exchange: this.options.exchange,
      strategyIds: catalog.strategyIds,
      limit: 300,
    });

    const lines = [
      `🎯 <b>${catalog.title}</b>`,
      `Exchange: <b>${this.options.exchange.toUpperCase()}</b>`,
      `Scope: <b>global strategy tracking only</b>`,
      `Tracked coins: <b>${tracked.length}</b>`,
      "",
      catalog.subtitle,
      "",
    ];
    if (kind === "sellPressure") {
      lines.push("<b>Ticker | PnL % Since Entry | Time Since Entry (h:mm)</b>");
      lines.push("");
    }
    const nowMs = Date.now();
    let renderedSectionCount = 0;

    for (const section of catalog.sections) {
      const sectionSetups = tracked.filter((setup) => section.phases.includes(setup.phase));
      const setups = sortSnapshotSection(kind, section.label, sectionSetups);

      if (setups.length === 0) {
        continue;
      }
      renderedSectionCount += 1;
      lines.push(`<b>${section.label}</b>`);

      for (const [index, setup] of setups.entries()) {
        if (kind === "new") {
          lines.push(`${index + 1}. ${formatNewListingSnapshotRow(this.options.exchange, section.label, setup, nowMs)}`);
          continue;
        }
        if (kind === "long25") {
          const entryPrice = readNumericPayload(setup.payload, "entryPrice");
          const entryAtMs = readNumericPayload(setup.payload, "entryAtMs");
          const held = formatElapsed(entryAtMs, nowMs);
          const entryPriceText = entryPrice === null ? "n/a" : `$${entryPrice.toLocaleString("en-US", { maximumFractionDigits: 8 })}`;
          lines.push(`${index + 1}. ${formatSymbolLink(this.options.exchange, setup.symbol)} | ${entryPriceText} | ${held}`);
          continue;
        }
        if (kind === "extremeFunding") {
          lines.push(`${index + 1}. ${formatExtremeFundingSnapshotRow(this.options.exchange, setup)}`);
          continue;
        }
        if (kind === "sellPressure") {
          const entryAtMs = readNumericPayload(setup.payload, "entryAtMs");
          const markReturnPct = readNumericPayload(setup.payload, "markReturnPct");
          // Fallback for older snapshots that only had unlevered move persisted.
          const legacyMarkMovePct = readNumericPayload(setup.payload, "markMovePct");
          const effectivePnlPct = markReturnPct ?? legacyMarkMovePct;
          const held = formatElapsed(entryAtMs, nowMs);
          const pnlText =
            effectivePnlPct === null ? "n/a" : `${effectivePnlPct > 0 ? "+" : ""}${effectivePnlPct.toFixed(2)}%`;
          lines.push(`${index + 1}. ${formatSymbolLink(this.options.exchange, setup.symbol)} | ${pnlText} | ${held}`);
          continue;
        }
        lines.push(`${index + 1}. ${formatSymbolLink(this.options.exchange, setup.symbol)}`);
      }
      lines.push("");
    }

    if (renderedSectionCount === 0) {
      lines.push(
        kind === "long25"
          ? "No READY entries right now."
          : kind === "extremeFunding"
            ? "No extreme funding alerts right now."
            : kind === "sellPressure"
              ? "No open sell-pressure positions right now."
            : "No active tracked coins right now."
      );
    }

    if (kind === "long25") {
      const stats = this.readLong25StatsFromModule();
      lines.push("");
      lines.push("📊 <b>Statistics</b>");
      lines.push(`Trades: <b>${stats.totalTrades}</b>`);
      lines.push(`Liquidations: <b>${stats.totalLiquidations}</b>`);
      lines.push(`Winners: <b>${stats.totalWinners}</b>`);
      lines.push(`Win %: <b>${stats.winRatePct.toFixed(2)}%</b>`);
    }

    if (kind === "sellPressure") {
      const stats = this.readSellPressureStatsFromModule();
      const pnlText = `${stats.pnlPct > 0 ? "+" : ""}${stats.pnlPct.toFixed(2)}%`;
      lines.push("");
      lines.push("📊 <b>Live Totals</b>");
      lines.push(`Entries: <b>${stats.entries}</b>`);
      lines.push(`Missed Trades: <b>${stats.missedTrades}</b>`);
      lines.push(`Winners: <b>${stats.winners}</b>`);
      lines.push(`Losers: <b>${stats.losers}</b>`);
      lines.push(`Liquidated: <b>${stats.liquidated}</b>`);
      lines.push(`Replaced: <b>${stats.replaced}</b>`);
      lines.push(`PnL: <b>${pnlText}</b>`);
      lines.push(`Win %: <b>${stats.winPct.toFixed(2)}%</b>`);
    }

    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    return lines.join("\n");
  }

  private collectTrackedSetups(
    nowMs: number,
    signals: StrategySignal[],
    evaluatedStrategies: StrategyModule[]
  ): RuntimeSetupSnapshot[] {
    const mapped = new Map<string, RuntimeSetupSnapshot>();
    const nowIso = new Date(nowMs).toISOString();
    const strategiesWithTracked = new Set<string>();

    for (const strategy of evaluatedStrategies) {
      if (strategy.listTrackedSetups) {
        strategiesWithTracked.add(strategy.id);
        for (const strategyId of resolveModuleStrategyIds(strategy)) {
          strategiesWithTracked.add(strategyId);
        }
      }
      if (!strategy.listTrackedSetups) continue;
      const setups = strategy.listTrackedSetups();
      for (const setup of setups) {
        const key = setup.key || setupKey(strategy.id, setup.symbol);
        mapped.set(key, {
          key,
          exchange: this.options.exchange,
          strategyId: setup.strategyId ?? strategy.id,
          strategyName: setup.strategyName ?? strategy.name,
          symbol: setup.symbol,
          phase: setup.phase,
          isReady: setup.isReady,
          score: setup.score,
          payload: setup.payload,
          updatedAt: new Date(setup.updatedAtMs ?? nowMs).toISOString(),
          active: true,
        });
      }
    }

    // Fallback for strategies that emit signals but don't export trackers.
    for (const signal of signals) {
      if (strategiesWithTracked.has(signal.strategyId)) continue;
      const key = setupKey(signal.strategyId, signal.symbol);
      if (mapped.has(key)) continue;
      mapped.set(key, {
        key,
        exchange: this.options.exchange,
        strategyId: signal.strategyId,
        strategyName: signal.strategyName,
        symbol: signal.symbol,
        phase: signal.phase,
        isReady: signal.isReady,
        score: signal.score,
        payload: signal.data,
        updatedAt: nowIso,
        active: true,
      });
    }

    return Array.from(mapped.values());
  }

  private async sendReadyPrompts(
    trigger: "startup" | "interval" | "manual",
    setups: RuntimeSetupSnapshot[],
    signals: StrategySignal[]
  ): Promise<void> {
    const setupByKey = new Map(setups.map((setup) => [setup.key, setup]));
    const promptedKeys = new Set<string>();

    for (const signal of signals.filter((item) => item.isReady)) {
      const key = setupKey(signal.strategyId, signal.symbol);
      const setup = setupByKey.get(key);
      if (!setup) continue;
      const decisionId = randomUUID();
      const messageId = await this.options.notifier.sendMessage(this.formatReadyPromptMessage(setup, "BECAME_READY"), {
        inlineKeyboard: [
          [
            { text: "Filled", callbackData: `exec:${decisionId}:filled` },
            { text: "Not Filled", callbackData: `exec:${decisionId}:not_filled` },
          ],
        ],
      });

      await this.options.runtimeStore.recordExecutionDecisionDefault({
        decisionId,
        exchange: this.options.exchange,
        runnerName: this.options.runnerName,
        setup,
        decisionReason: "BECAME_READY",
        telegramMessageId: messageId,
      });
      promptedKeys.add(setup.key);
    }

    if (trigger !== "startup") return;

    const readySetups = setups.filter((setup) => setup.isReady);
    if (readySetups.length === 0) return;

    const delivered = await this.options.runtimeStore.getSetupKeysWithDeliveredExecutionPrompts(
      this.options.exchange,
      readySetups.map((setup) => setup.key)
    );

    for (const setup of readySetups) {
      if (promptedKeys.has(setup.key)) continue;
      if (delivered.has(setup.key)) continue;

      const decisionId = randomUUID();
      const messageId = await this.options.notifier.sendMessage(
        this.formatReadyPromptMessage(setup, "STARTUP_CATCHUP_READY"),
        {
          inlineKeyboard: [
            [
              { text: "Filled", callbackData: `exec:${decisionId}:filled` },
              { text: "Not Filled", callbackData: `exec:${decisionId}:not_filled` },
            ],
          ],
        }
      );

      await this.options.runtimeStore.recordExecutionDecisionDefault({
        decisionId,
        exchange: this.options.exchange,
        runnerName: this.options.runnerName,
        setup,
        decisionReason: "STARTUP_CATCHUP_READY",
        telegramMessageId: messageId,
      });
    }
  }

  private readLong25StatsFromModule(): {
    totalTrades: number;
    totalLiquidations: number;
    totalWinners: number;
    winRatePct: number;
  } {
    const module = this.options.strategies.find(
      (strategy) =>
        strategy.id === "bybit:long25-suite:v1" ||
        (strategy.strategyIds ? strategy.strategyIds.includes("bybit:long25:v1") : false)
    );
    if (!module?.exportState) {
      return {
        totalTrades: 0,
        totalLiquidations: 0,
        totalWinners: 0,
        winRatePct: 0,
      };
    }

    const snapshot = module.exportState();
    if (!snapshot || typeof snapshot !== "object") {
      return {
        totalTrades: 0,
        totalLiquidations: 0,
        totalWinners: 0,
        winRatePct: 0,
      };
    }

    const rawStats = (snapshot as { summaryStats?: Record<string, unknown> }).summaryStats;
    const totalTrades = typeof rawStats?.totalTrades === "number" ? rawStats.totalTrades : 0;
    const totalLiquidations = typeof rawStats?.totalLiquidations === "number" ? rawStats.totalLiquidations : 0;
    const totalWinners = typeof rawStats?.totalWinners === "number" ? rawStats.totalWinners : 0;
    const winRatePct = totalTrades > 0 ? (totalWinners / totalTrades) * 100 : 0;
    return {
      totalTrades,
      totalLiquidations,
      totalWinners,
      winRatePct,
    };
  }

  private readSellPressureStatsFromModule(): {
    entries: number;
    missedTrades: number;
    winners: number;
    losers: number;
    liquidated: number;
    replaced: number;
    pnlPct: number;
    winPct: number;
  } {
    const module = this.options.strategies.find(
      (strategy) =>
        strategy.id === "bybit:extreme-sell-pressure-suite:v64" ||
        strategy.id === "bybit:extreme-sell-pressure-suite:v43" ||
        (strategy.strategyIds
          ? strategy.strategyIds.includes("bybit:extreme-sell-pressure:v64") ||
            strategy.strategyIds.includes("bybit:extreme-sell-pressure:v43")
          : false)
    );
    if (!module?.exportState) {
      return {
        entries: 0,
        missedTrades: 0,
        winners: 0,
        losers: 0,
        liquidated: 0,
        replaced: 0,
        pnlPct: 0,
        winPct: 0,
      };
    }

    const snapshot = module.exportState();
    if (!snapshot || typeof snapshot !== "object") {
      return {
        entries: 0,
        missedTrades: 0,
        winners: 0,
        losers: 0,
        liquidated: 0,
        replaced: 0,
        pnlPct: 0,
        winPct: 0,
      };
    }

    const rawStats = (snapshot as { snapshotStats?: Record<string, unknown> }).snapshotStats;
    const read = (key: string): number => {
      const value = rawStats?.[key];
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };
    return {
      entries: Math.max(0, Math.floor(read("entries"))),
      missedTrades: Math.max(0, Math.floor(read("missedTrades"))),
      winners: Math.max(0, Math.floor(read("winners"))),
      losers: Math.max(0, Math.floor(read("losers"))),
      liquidated: Math.max(0, Math.floor(read("liquidated"))),
      replaced: Math.max(0, Math.floor(read("replaced"))),
      pnlPct: read("pnlPct"),
      winPct: read("winPct"),
    };
  }

  private formatReadyPromptMessage(setup: RuntimeSetupSnapshot, reason: string): string {
    return [
      `✅ <b>${setup.phase} | READY</b>`,
      "",
      `<b>${setup.symbol}</b>`,
      `Action: <b>${resolveSetupActionLabel(setup)}</b>`,
      `Reason: ${reason}`,
      `Strategy: <b>${setup.strategyName}</b>`,
      "",
      "Confirm execution result:",
    ].join("\n");
  }

  private async hydrateState(): Promise<void> {
    const snapshot = await this.options.stateStore.load();
    for (const strategy of this.options.strategies) {
      if (!strategy.hydrateState) continue;
      const trackerKey = strategy.trackerStateKey ?? strategy.id;
      strategy.hydrateState(snapshot[trackerKey]);
    }
  }

  private async persistState(): Promise<void> {
    const snapshot: Record<string, unknown> = {};
    for (const strategy of this.options.strategies) {
      if (!strategy.exportState) continue;
      const trackerKey = strategy.trackerStateKey ?? strategy.id;
      snapshot[trackerKey] = strategy.exportState();
    }
    await this.options.stateStore.save(snapshot);
  }
}
