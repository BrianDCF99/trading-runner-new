/**
 * Supabase runtime store aligned to legacy trading-runner tables and semantics.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ExistingSetupState,
  ExecutionDecision,
  MarketStateRow,
  PendingExecutionPrompt,
  RunnerStatusSnapshot,
  RuntimeSetupSnapshot,
  ScanRunRecord,
  SetupEventRecord,
  StrategyConfigSnapshot,
} from "../../core/domain/types.js";
import type { RuntimeStorePort } from "../../core/ports/interfaces.js";

function parseNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toRuntimeSetup(row: Record<string, unknown>): RuntimeSetupSnapshot {
  return {
    key: String(row.signal_key ?? ""),
    exchange: "bybit",
    strategyId: String(row.strategy_id ?? ""),
    strategyName: String(row.strategy_name ?? ""),
    symbol: String(row.symbol ?? ""),
    phase: String(row.phase ?? ""),
    isReady: Boolean(row.is_ready),
    score: parseNumber(row.score),
    payload: ((row.payload as Record<string, unknown> | null) ?? {}) as Record<string, unknown>,
    updatedAt: String(row.updated_at ?? new Date().toISOString()),
    active: Boolean(row.active),
  };
}

function resolveSetupDirection(setup: RuntimeSetupSnapshot): "LONG" | "SHORT" {
  const side = setup.payload.side;
  if (typeof side === "string") {
    const normalized = side.trim().toUpperCase();
    if (normalized === "LONG" || normalized === "SHORT") return normalized;
  }

  const action = setup.payload.action;
  if (typeof action === "string") {
    const normalized = action.trim().toUpperCase();
    if (normalized.includes("LONG")) return "LONG";
    if (normalized.includes("SHORT")) return "SHORT";
  }

  return "SHORT";
}

export class SupabaseRuntimeStore implements RuntimeStorePort {
  constructor(
    private readonly client: SupabaseClient,
    private readonly exchange: "bybit"
  ) {}

  async getStrategyConfig(exchange: "bybit"): Promise<StrategyConfigSnapshot | null> {
    const { data, error } = await this.client
      .from("strategy_configs")
      .select("strategy_id, enabled")
      .eq("exchange", exchange);

    if (error) return null;

    const enabledIds = new Set<string>();
    const disabledIds = new Set<string>();
    for (const row of data ?? []) {
      const strategyId = String(row.strategy_id ?? "");
      if (!strategyId) continue;
      if (row.enabled) enabledIds.add(strategyId);
      else disabledIds.add(strategyId);
    }

    return {
      hasConfig: Boolean((data ?? []).length),
      enabledIds,
      disabledIds,
    };
  }

  async recordScanRun(run: ScanRunRecord): Promise<void> {
    await this.client.from("scanner_runs").insert({
      exchange: run.exchange,
      runner_name: run.runnerName,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      duration_ms: run.durationMs,
      status: run.status,
      error: run.error ?? null,
      signal_count: run.setupCount,
      ready_count: run.readySetupCount,
      meta: run.meta ?? {},
    });
  }

  async getExistingSetups(setupKeys: string[]): Promise<Map<string, ExistingSetupState>> {
    const map = new Map<string, ExistingSetupState>();
    if (setupKeys.length === 0) return map;

    const { data, error } = await this.client
      .from("signals")
      .select("signal_key, phase, is_ready")
      .in("signal_key", setupKeys);

    if (error) return map;
    for (const row of data ?? []) {
      const key = String(row.signal_key ?? "");
      if (!key) continue;
      map.set(key, {
        key,
        phase: String(row.phase ?? ""),
        isReady: Boolean(row.is_ready),
      });
    }
    return map;
  }

  async insertSetupEvents(events: SetupEventRecord[]): Promise<void> {
    if (events.length === 0) return;
    const rows = events.map((event) => ({
      exchange: event.exchange,
      signal_key: event.setupKey,
      strategy_id: event.strategyId,
      event_type: event.eventType,
      message: event.message,
      payload: event.payload ?? {},
    }));

    await this.client.from("signal_events").insert(rows);
  }

  async upsertMarketState(rows: MarketStateRow[]): Promise<void> {
    if (rows.length === 0) return;
    const payload = rows.map((row) => ({
      exchange: row.exchange,
      symbol: row.symbol,
      price: row.price,
      change_24h: row.change24h,
      funding_rate: row.fundingRate,
      next_funding_time: row.nextFundingTime,
      open_interest: row.openInterest,
      volume_24h: row.volume24h,
      updated_at: row.updatedAt,
    }));

    await this.client.from("market_state").upsert(payload, {
      onConflict: "exchange,symbol",
    });
  }

  async getStatus(exchange: "bybit", runnerName: string): Promise<RunnerStatusSnapshot> {
    const [{ data: runnerData }, { data: runData }, { count: readyCount }, { count: setupCount }] =
      await Promise.all([
        this.client
          .from("engine_status")
          .select("runner_name, status, last_error, last_heartbeat")
          .eq("exchange", exchange)
          .maybeSingle(),
        this.client
          .from("scanner_runs")
          .select("finished_at, duration_ms")
          .eq("exchange", exchange)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        this.client
          .from("signals")
          .select("signal_key", { count: "exact", head: true })
          .eq("exchange", exchange)
          .eq("active", true)
          .eq("is_ready", true),
        this.client
          .from("signals")
          .select("signal_key", { count: "exact", head: true })
          .eq("exchange", exchange)
          .eq("active", true),
      ]);

    const rawState = String(runnerData?.status ?? "idle");
    const state: RunnerStatusSnapshot["state"] =
      rawState === "ok" || rawState === "error" ? rawState : "idle";

    return {
      exchange,
      runnerName: String(runnerData?.runner_name ?? runnerName),
      state,
      lastHeartbeat: (runnerData?.last_heartbeat as string | null) ?? null,
      lastRunAt: (runData?.finished_at as string | null) ?? null,
      lastRunDurationMs: (runData?.duration_ms as number | null) ?? null,
      setupCount: setupCount ?? 0,
      readySetupCount: readyCount ?? 0,
      lastError: (runnerData?.last_error as string | null) ?? null,
    };
  }

  async saveStatus(status: RunnerStatusSnapshot): Promise<void> {
    await this.client.from("engine_status").upsert(
      {
        exchange: status.exchange,
        runner_name: status.runnerName,
        status: status.state,
        last_error: status.lastError,
        last_heartbeat: status.lastHeartbeat ?? new Date().toISOString(),
        meta: {
          setupCount: status.setupCount,
          readySetupCount: status.readySetupCount,
        },
      },
      { onConflict: "exchange" }
    );
  }

  async upsertSetups(exchange: "bybit", setups: RuntimeSetupSnapshot[]): Promise<void> {
    const seenAtIso = new Date().toISOString();
    const rows = setups.map((setup) => ({
      signal_key: setup.key,
      exchange,
      strategy_id: setup.strategyId,
      strategy_name: setup.strategyName,
      symbol: setup.symbol,
      direction: resolveSetupDirection(setup),
      phase: setup.phase,
      score: setup.score,
      is_ready: setup.isReady,
      active: true,
      payload: setup.payload,
      last_seen_at: seenAtIso,
      updated_at: setup.updatedAt || seenAtIso,
    }));

    if (rows.length > 0) {
      await this.client.from("signals").upsert(rows, { onConflict: "signal_key" });
    }

    const { data } = await this.client
      .from("signals")
      .select("signal_key")
      .eq("exchange", exchange)
      .eq("active", true);

    const activeSet = new Set(setups.map((setup) => setup.key));
    const staleKeys = (data ?? [])
      .map((row) => String(row.signal_key ?? ""))
      .filter((key) => key.length > 0)
      .filter((key) => !activeSet.has(key));

    if (staleKeys.length > 0) {
      await this.client
        .from("signals")
        .update({ active: false, updated_at: new Date().toISOString() })
        .in("signal_key", staleKeys);
    }
  }

  async getActiveSetups(input: {
    exchange: "bybit";
    strategyIds?: string[];
    limit: number;
  }): Promise<RuntimeSetupSnapshot[]> {
    let query = this.client
      .from("signals")
      .select(
        "signal_key, strategy_id, strategy_name, symbol, phase, score, is_ready, payload, updated_at, active"
      )
      .eq("exchange", input.exchange)
      .eq("active", true)
      .order("updated_at", { ascending: false })
      .limit(input.limit);

    if (input.strategyIds && input.strategyIds.length > 0) {
      query = query.in("strategy_id", input.strategyIds);
    }

    const { data, error } = await query;
    if (error) return [];
    return (data ?? []).map((row) => toRuntimeSetup(row as Record<string, unknown>));
  }

  async getReadySetups(exchange: "bybit", limit: number): Promise<RuntimeSetupSnapshot[]> {
    const { data, error } = await this.client
      .from("signals")
      .select(
        "signal_key, strategy_id, strategy_name, symbol, phase, score, is_ready, payload, updated_at, active"
      )
      .eq("exchange", exchange)
      .eq("active", true)
      .eq("is_ready", true)
      .order("score", { ascending: false })
      .limit(limit);

    if (error) return [];
    return (data ?? []).map((row) => toRuntimeSetup(row as Record<string, unknown>));
  }

  async recordExecutionDecisionDefault(input: {
    decisionId: string;
    exchange: "bybit";
    runnerName: string;
    setup: RuntimeSetupSnapshot;
    decisionReason: string;
    telegramChatId?: string;
    telegramMessageId?: number | null;
  }): Promise<void> {
    await this.client.from("setup_execution_decisions").insert({
      id: input.decisionId,
      exchange: input.exchange,
      setup_key: input.setup.key,
      strategy_id: input.setup.strategyId,
      symbol: input.setup.symbol,
      phase: input.setup.phase,
      runner_name: input.runnerName,
      decision: "not_filled",
      decision_source: "default_no_reply",
      decision_reason: input.decisionReason ?? null,
      telegram_chat_id: input.telegramChatId ?? null,
      telegram_message_id: input.telegramMessageId ?? null,
      decided_at: new Date().toISOString(),
    });
  }

  async updateExecutionDecision(input: {
    decisionId: string;
    decision: "filled" | "not_filled";
    telegramChatId?: string;
    telegramMessageId?: number;
    telegramUserId?: number;
  }): Promise<boolean> {
    const { data, error } = await this.client
      .from("setup_execution_decisions")
      .update({
        decision: input.decision,
        decision_source: "telegram_button",
        telegram_chat_id: input.telegramChatId ?? null,
        telegram_message_id: input.telegramMessageId ?? null,
        telegram_user_id: input.telegramUserId ?? null,
        decided_at: new Date().toISOString(),
      })
      .eq("id", input.decisionId)
      .select("id")
      .limit(1);

    if (error) return false;
    return (data ?? []).length > 0;
  }

  async getPendingExecutionPrompts(exchange: "bybit", limit: number): Promise<PendingExecutionPrompt[]> {
    const { data: decisionRows, error: decisionError } = await this.client
      .from("setup_execution_decisions")
      .select("id, setup_key, created_at")
      .eq("exchange", exchange)
      .eq("decision", "not_filled")
      .eq("decision_source", "default_no_reply")
      .order("created_at", { ascending: false })
      .limit(Math.max(limit * 5, 20));

    if (decisionError) return [];

    const latestDecisionBySetup = new Map<string, string>();
    for (const row of decisionRows ?? []) {
      const setupKey = String(row.setup_key ?? "");
      if (!setupKey || latestDecisionBySetup.has(setupKey)) continue;
      latestDecisionBySetup.set(setupKey, String(row.id ?? ""));
    }

    const setupKeys = Array.from(latestDecisionBySetup.keys());
    if (setupKeys.length === 0) return [];

    const { data: setupRows, error: setupError } = await this.client
      .from("signals")
      .select(
        "signal_key, strategy_id, strategy_name, symbol, phase, score, is_ready, payload, updated_at, active"
      )
      .eq("exchange", exchange)
      .eq("active", true)
      .eq("is_ready", true)
      .in("signal_key", setupKeys);

    if (setupError) return [];

    const setupByKey = new Map<string, RuntimeSetupSnapshot>();
    for (const row of setupRows ?? []) {
      const setup = toRuntimeSetup(row as Record<string, unknown>);
      setupByKey.set(setup.key, setup);
    }

    const results: PendingExecutionPrompt[] = [];
    for (const setupKey of setupKeys) {
      if (results.length >= limit) break;
      const setup = setupByKey.get(setupKey);
      if (!setup) continue;

      const payload = setup.payload;
      const hoursSinceListing = payload.hoursSinceListing;
      const entryWindowEnd = payload.entryWindowEnd;
      if (
        typeof hoursSinceListing === "number" &&
        typeof entryWindowEnd === "number" &&
        hoursSinceListing > entryWindowEnd
      ) {
        continue;
      }

      const decisionId = latestDecisionBySetup.get(setupKey);
      if (!decisionId) continue;
      results.push({ decisionId, setup });
    }

    return results;
  }

  async getSetupKeysWithDeliveredExecutionPrompts(exchange: "bybit", setupKeys: string[]): Promise<Set<string>> {
    const keys = new Set<string>();
    if (setupKeys.length === 0) return keys;

    const { data, error } = await this.client
      .from("setup_execution_decisions")
      .select("setup_key")
      .eq("exchange", exchange)
      .not("telegram_message_id", "is", null)
      .in("setup_key", setupKeys);

    if (error) return keys;
    for (const row of data ?? []) {
      const setupKey = String(row.setup_key ?? "");
      if (setupKey) keys.add(setupKey);
    }
    return keys;
  }

  async getPositionsForMember(input: {
    exchange: "bybit";
    chatId: string;
    userId: number;
    limit: number;
  }): Promise<RuntimeSetupSnapshot[]> {
    const { data: decisionRows, error: decisionError } = await this.client
      .from("setup_execution_decisions")
      .select("setup_key, decided_at")
      .eq("exchange", input.exchange)
      .eq("telegram_chat_id", input.chatId)
      .eq("telegram_user_id", input.userId)
      .eq("decision", "filled")
      .order("decided_at", { ascending: false })
      .limit(Math.max(input.limit * 10, 50));

    if (decisionError) return [];

    const setupKeys = Array.from(
      new Set((decisionRows ?? []).map((row) => String(row.setup_key ?? "")).filter(Boolean))
    );
    if (setupKeys.length === 0) return [];

    const positionPhases = [
      "HOLDING_LEG1",
      "HOLDING_LEG1_LEG2",
      "HOLDING_S7",
      "READY",
      "READY_CLOSE",
      "CLOSED",
    ];

    const { data: setupRows, error: setupError } = await this.client
      .from("signals")
      .select(
        "signal_key, strategy_id, strategy_name, symbol, phase, score, is_ready, payload, updated_at, active"
      )
      .eq("exchange", input.exchange)
      .eq("active", true)
      .in("signal_key", setupKeys)
      .in("phase", positionPhases)
      .order("updated_at", { ascending: false })
      .limit(input.limit);

    if (setupError) return [];
    return (setupRows ?? []).map((row) => toRuntimeSetup(row as Record<string, unknown>));
  }

  async getExecutionDecision(decisionId: string): Promise<ExecutionDecision | null> {
    const { data, error } = await this.client
      .from("setup_execution_decisions")
      .select("*")
      .eq("id", decisionId)
      .maybeSingle();

    if (error || !data) return null;
    return {
      id: String(data.id),
      exchange: "bybit",
      setupKey: String(data.setup_key ?? ""),
      strategyId: String(data.strategy_id ?? ""),
      symbol: String(data.symbol ?? ""),
      phase: String(data.phase ?? ""),
      decision: data.decision === "filled" ? "filled" : "not_filled",
      decisionSource: data.decision_source === "telegram_button" ? "telegram_button" : "default_no_reply",
      decisionReason: (data.decision_reason as string | null) ?? null,
      telegramChatId: (data.telegram_chat_id as string | null) ?? null,
      telegramMessageId:
        typeof data.telegram_message_id === "number"
          ? data.telegram_message_id
          : data.telegram_message_id
            ? Number(data.telegram_message_id)
            : null,
      telegramUserId:
        typeof data.telegram_user_id === "number"
          ? data.telegram_user_id
          : data.telegram_user_id
            ? Number(data.telegram_user_id)
            : null,
      createdAt: String(data.created_at ?? ""),
      decidedAt: String(data.decided_at ?? ""),
    };
  }
}
