/**
 * Public Bybit REST adapter used by strategies.
 */
import type { BybitInstrument, BybitTicker, Kline1h } from "../../core/domain/types.js";
import type { MarketDataPort } from "../../core/ports/interfaces.js";

interface HttpOptions {
  timeoutMs: number;
}

async function fetchJson(url: string, options: HttpOptions): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseEpochMs(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

export class BybitPublicClient implements MarketDataPort {
  constructor(
    private readonly apiBase: string,
    private readonly timeoutMs: number
  ) {}

  async getTickers(): Promise<BybitTicker[]> {
    const url = `${this.apiBase}/v5/market/tickers?category=linear`;
    const raw = (await fetchJson(url, { timeoutMs: this.timeoutMs })) as {
      result?: { list?: Array<Record<string, unknown>> };
    };

    const list = raw.result?.list ?? [];
    return list.map((row) => ({
      symbol: String(row.symbol ?? ""),
      lastPrice: parseNumber(row.lastPrice),
      markPrice: parseNumber(row.markPrice),
      indexPrice: parseNumber(row.indexPrice),
      fundingRate: parseNumber(row.fundingRate),
      turnover24h: parseNumber(row.turnover24h),
      volume24h: parseNumber(row.volume24h),
      price24hPcnt: parseNumber(row.price24hPcnt),
      nextFundingTimeMs: Number.parseInt(String(row.nextFundingTime ?? 0), 10) || 0,
      openInterest: parseNumber(row.openInterest),
    }));
  }

  async getInstruments(): Promise<BybitInstrument[]> {
    const url = `${this.apiBase}/v5/market/instruments-info?category=linear&limit=1000`;
    const raw = (await fetchJson(url, { timeoutMs: this.timeoutMs })) as {
      result?: { list?: Array<Record<string, unknown>> };
    };

    const list = raw.result?.list ?? [];
    return list.map((row) => ({
      symbol: String(row.symbol ?? ""),
      launchTimeMs: parseEpochMs(row.launchTime),
      status: String(row.status ?? ""),
      contractType: String(row.contractType ?? ""),
      fundingIntervalMinutes: parseNumber(row.fundingInterval) || null,
    }));
  }

  async getKlines1h(symbol: string, limit: number): Promise<Kline1h[]> {
    const url = `${this.apiBase}/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=60&limit=${Math.max(1, Math.min(limit, 200))}`;
    const raw = (await fetchJson(url, { timeoutMs: this.timeoutMs })) as {
      result?: { list?: string[][] };
    };

    const rows = raw.result?.list ?? [];
    const mapped = rows
      .map((row) => ({
        openTimeMs: Number(row[0] ?? 0),
        open: parseNumber(row[1]),
        high: parseNumber(row[2]),
        low: parseNumber(row[3]),
        close: parseNumber(row[4]),
        volume: parseNumber(row[5]),
        turnover: parseNumber(row[6]),
      }))
      .filter((row) => Number.isFinite(row.openTimeMs) && row.openTimeMs > 0)
      .sort((a, b) => a.openTimeMs - b.openTimeMs);

    return mapped;
  }
}
