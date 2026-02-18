/**
 * Public Bybit REST adapter used by strategies.
 */
import type {
  BybitInstrument,
  BybitTicker,
  FundingHistoryPoint,
  Kline1h,
  SellRatio1hSnapshot,
} from "../../core/domain/types.js";
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

function parseNullableNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseEpochMs(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

const SELL_RATIO_CACHE_TTL_MS = 5 * 60 * 1000;

interface SellRatioCacheEntry {
  fetchedAtMs: number;
  snapshot: SellRatio1hSnapshot;
}

export class BybitPublicClient implements MarketDataPort {
  private readonly sellRatioCache = new Map<string, SellRatioCacheEntry>();
  private readonly sellRatioInFlight = new Map<string, Promise<SellRatio1hSnapshot>>();

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

  async getSellRatio1h(symbol: string): Promise<SellRatio1hSnapshot> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    if (!normalizedSymbol) {
      return {
        symbol: "",
        sellRatio: null,
        timestampMs: null,
      };
    }

    const nowMs = Date.now();
    const cached = this.sellRatioCache.get(normalizedSymbol);
    if (cached && nowMs - cached.fetchedAtMs < SELL_RATIO_CACHE_TTL_MS) {
      return cached.snapshot;
    }

    const inFlight = this.sellRatioInFlight.get(normalizedSymbol);
    if (inFlight) {
      return inFlight;
    }

    const request = this.fetchSellRatio1h(normalizedSymbol)
      .catch(() => ({
        symbol: normalizedSymbol,
        sellRatio: null,
        timestampMs: null,
      }))
      .finally(() => {
        this.sellRatioInFlight.delete(normalizedSymbol);
      });

    this.sellRatioInFlight.set(normalizedSymbol, request);
    const snapshot = await request;
    this.sellRatioCache.set(normalizedSymbol, {
      fetchedAtMs: nowMs,
      snapshot,
    });
    return snapshot;
  }

  async getFundingHistory(
    symbol: string,
    startTimeMs: number,
    endTimeMs: number,
    limit = 200
  ): Promise<FundingHistoryPoint[]> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    if (!normalizedSymbol) return [];
    const start = Math.max(0, Math.floor(startTimeMs));
    const end = Math.max(start, Math.floor(endTimeMs));
    if (end <= 0 || end < start) return [];

    const clampedLimit = Math.max(1, Math.min(Math.floor(limit), 200));
    const url =
      `${this.apiBase}/v5/market/funding/history?category=linear` +
      `&symbol=${encodeURIComponent(normalizedSymbol)}` +
      `&startTime=${start}` +
      `&endTime=${end}` +
      `&limit=${clampedLimit}`;
    const raw = (await fetchJson(url, { timeoutMs: this.timeoutMs })) as {
      result?: { list?: Array<Record<string, unknown>> };
    };

    const rows = raw.result?.list ?? [];
    const points = rows
      .map((row) => {
        const timestampMs = parseEpochMs(row.fundingRateTimestamp);
        const fundingRate = parseNullableNumber(row.fundingRate);
        if (timestampMs === null || fundingRate === null) return null;
        return {
          symbol: normalizedSymbol,
          timestampMs,
          fundingRate,
        };
      })
      .filter((item): item is FundingHistoryPoint => item !== null)
      .sort((a, b) => a.timestampMs - b.timestampMs);

    return points;
  }

  private async fetchSellRatio1h(symbol: string): Promise<SellRatio1hSnapshot> {
    const url = `${this.apiBase}/v5/market/account-ratio?category=linear&symbol=${encodeURIComponent(symbol)}&period=1h&limit=1`;
    const raw = (await fetchJson(url, { timeoutMs: this.timeoutMs })) as {
      result?: { list?: Array<Record<string, unknown>> };
    };

    const list = raw.result?.list ?? [];
    if (list.length === 0) {
      return {
        symbol,
        sellRatio: null,
        timestampMs: null,
      };
    }

    let latest: SellRatio1hSnapshot = {
      symbol,
      sellRatio: null,
      timestampMs: null,
    };

    for (const row of list) {
      const timestampMs = parseEpochMs(row.timestamp);
      if (timestampMs === null) {
        continue;
      }
      if (latest.timestampMs !== null && latest.timestampMs >= timestampMs) {
        continue;
      }
      latest = {
        symbol,
        sellRatio: parseNullableNumber(row.sellRatio),
        timestampMs,
      };
    }

    if (latest.timestampMs === null) {
      const first = list[0] ?? {};
      return {
        symbol,
        sellRatio: parseNullableNumber(first.sellRatio),
        timestampMs: parseEpochMs(first.timestamp),
      };
    }

    return latest;
  }
}
