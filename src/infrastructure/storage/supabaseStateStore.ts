/**
 * Supabase-backed tracker snapshot store.
 * Uses strategy_trackers table for restart-safe strategy state.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StateStorePort } from "../../core/ports/interfaces.js";

export class SupabaseStateStore implements StateStorePort {
  constructor(
    private readonly client: SupabaseClient,
    private readonly exchange: "bybit"
  ) {}

  async load(): Promise<Record<string, unknown>> {
    const map: Record<string, unknown> = {};

    const { data, error } = await this.client
      .from("strategy_trackers")
      .select("tracker_key, state")
      .eq("exchange", this.exchange);

    if (error) {
      return map;
    }

    for (const row of data ?? []) {
      const key = String(row.tracker_key ?? "");
      if (!key) continue;
      map[key] = (row.state as Record<string, unknown> | null) ?? {};
    }

    return map;
  }

  async save(snapshot: Record<string, unknown>): Promise<void> {
    const rows = Object.entries(snapshot).map(([trackerKey, state]) => ({
      exchange: this.exchange,
      tracker_key: trackerKey,
      state: (state as Record<string, unknown>) ?? {},
    }));

    if (rows.length === 0) return;

    await this.client.from("strategy_trackers").upsert(rows, {
      onConflict: "exchange,tracker_key",
    });
  }
}
