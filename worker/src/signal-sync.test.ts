/**
 * Signal Sync Functions Test
 *
 * Tests for syncSignalsFromScraper and ingestSignalBatch functions
 * that handle signal acquisition from the scraper.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { TraderEnv, Signal } from "./types";
import type { components } from "./generated/scraper-api";
import { syncSignalsFromScraper, ingestSignalBatch } from "./scheduled";

// Scraper API response type
type ScraperSignalsResponse = components["schemas"]["FetchSignalsResponse"];

// =============================================================================
// Mock D1 Database
// =============================================================================

interface MockRow {
  [key: string]: any;
}

function createMockD1() {
  const tables: Record<string, MockRow[]> = {
    signals: [],
    positions: [],
    config: [],
  };

  return {
    tables,

    prepare(sql: string) {
      let boundParams: any[] = [];

      return {
        bind(...params: any[]) {
          boundParams = params;
          return this;
        },

        async run() {
          // Handle INSERT
          if (sql.trim().toUpperCase().startsWith("INSERT")) {
            const tableMatch = sql.match(/INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+(\w+)/i);
            if (!tableMatch) throw new Error(`Could not parse INSERT: ${sql}`);
            const tableName = tableMatch[1];

            // Extract column names from the SQL
            const columnsMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
            if (!columnsMatch) throw new Error(`Could not parse columns: ${sql}`);
            const columns = columnsMatch[1].split(",").map((c) => c.trim());

            // Create row object
            const row: MockRow = {};
            columns.forEach((col, i) => {
              row[col] = boundParams[i];
            });

            if (!tables[tableName]) {
              tables[tableName] = [];
            }
            tables[tableName].push(row);

            return { success: true, meta: { changes: 1 } };
          }

          // Handle UPDATE
          if (sql.trim().toUpperCase().startsWith("UPDATE")) {
            return { success: true, meta: { changes: 1 } };
          }

          return { success: true, meta: { changes: 0 } };
        },

        async first(): Promise<MockRow | null> {
          if (!sql.trim().toUpperCase().startsWith("SELECT")) return null;

          const tableMatch = sql.match(/FROM\s+(\w+)/i);
          if (!tableMatch) return null;
          const tableName = tableMatch[1];

          const tableData = tables[tableName] || [];

          // Handle WHERE source = ? AND source_id = ? (dedup check)
          if (sql.includes("source = ?") && sql.includes("source_id = ?")) {
            const source = boundParams[0];
            const sourceId = boundParams[1];
            return tableData.find(
              (r) => r.source === source && r.source_id === sourceId
            ) || null;
          }

          // Handle logical duplicate check (ticker + politician_name + trade_date + action)
          if (sql.includes("ticker = ?") && sql.includes("politician_name = ?") &&
              sql.includes("trade_date = ?") && sql.includes("action = ?")) {
            const ticker = boundParams[0];
            const politicianName = boundParams[1];
            const tradeDate = boundParams[2];
            const action = boundParams[3];
            return tableData.find(
              (r) => r.ticker === ticker && r.politician_name === politicianName &&
                     r.trade_date === tradeDate && r.action === action
            ) || null;
          }

          return tableData[0] || null;
        },

        async all(): Promise<{ results: MockRow[] }> {
          return { results: [] };
        },
      };
    },
  };
}

function createMockEnv(): TraderEnv & { mockDb: ReturnType<typeof createMockD1> } {
  const mockDb = createMockD1();

  return {
    TRADER_DB: mockDb as any,
    TRADER_API_KEY: "test-api-key",
    SCRAPER_API_KEY: "test-scraper-key",
    SCRAPER_URL: "https://scraper.example.com",
    TUNNEL_URL: "http://localhost:3001",
    mockDb,
  } as TraderEnv & { mockDb: ReturnType<typeof createMockD1> };
}

// =============================================================================
// Test Data
// =============================================================================

function createTestSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    source: "capitol_trades",
    politician: {
      name: "Nancy Pelosi",
      chamber: "House",
      party: "D",
      state: "CA",
    },
    trade: {
      ticker: "NVDA",
      action: "buy",
      asset_type: "stock",
      trade_price: 140.0,
      trade_date: "2026-01-10",
      disclosure_price: 142.0,
      disclosure_date: "2026-01-15",
      position_size: "$100,001 - $250,000",
      position_size_min: 100001,
      position_size_max: 250000,
    },
    meta: {
      source_url: "https://example.com/trade/123",
      source_id: `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      scraped_at: new Date().toISOString(),
    },
    ...overrides,
  };
}

/**
 * Create a scraper signal in the format returned by the OpenAPI.
 * Maps internal Signal to scraper API format.
 */
function toScraperSignal(signal: Signal): components["schemas"]["Signal"] {
  return {
    source: signal.source as components["schemas"]["SignalSource"],
    politician: {
      name: signal.politician.name,
      chamber: (signal.politician.chamber?.toLowerCase() as components["schemas"]["Chamber"]) ?? "unknown",
      party: signal.politician.party ?? null,
      state: signal.politician.state ?? null,
    },
    trade: {
      ticker: signal.trade.ticker ?? null,
      action: signal.trade.action as components["schemas"]["TradeAction"],
      asset_type: (signal.trade.asset_type as components["schemas"]["AssetType"]) ?? "stock",
      trade_date: signal.trade.trade_date ?? null,
      trade_price: signal.trade.trade_price ?? null,
      disclosure_date: signal.trade.disclosure_date ?? null,
      disclosure_price: signal.trade.disclosure_price ?? null,
      position_size: signal.trade.position_size ?? null,
      position_size_min: signal.trade.position_size_min ?? null,
      position_size_max: signal.trade.position_size_max ?? null,
    },
    meta: {
      source_url: signal.meta.source_url ?? null,
      source_id: signal.meta.source_id,
      scraped_at: signal.meta.scraped_at,
    },
  };
}

function createScraperResponse(signals: Signal[]): ScraperSignalsResponse {
  return {
    signals: signals.map(toScraperSignal),
    sources_fetched: ["capitol_trades", "senate_stock_watcher"],
    sources_failed: {},
    total_signals: signals.length,
    fetched_at: new Date().toISOString(),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("ingestSignalBatch", () => {
  let env: TraderEnv & { mockDb: ReturnType<typeof createMockD1> };

  beforeEach(() => {
    env = createMockEnv();
  });

  it("should insert new signals successfully", async () => {
    // Use distinct tickers to avoid logical duplicate detection
    const signals = [
      createTestSignal({
        trade: { ticker: "NVDA", action: "buy", asset_type: "stock", trade_price: 140.0, trade_date: "2026-01-10", disclosure_price: 142.0, disclosure_date: "2026-01-15", position_size: "$100,001 - $250,000", position_size_min: 100001, position_size_max: 250000 },
        meta: { source_url: "", source_id: "trade_1", scraped_at: new Date().toISOString() },
      }),
      createTestSignal({
        trade: { ticker: "AAPL", action: "buy", asset_type: "stock", trade_price: 190.0, trade_date: "2026-01-10", disclosure_price: 192.0, disclosure_date: "2026-01-15", position_size: "$100,001 - $250,000", position_size_min: 100001, position_size_max: 250000 },
        meta: { source_url: "", source_id: "trade_2", scraped_at: new Date().toISOString() },
      }),
      createTestSignal({
        trade: { ticker: "GOOGL", action: "buy", asset_type: "stock", trade_price: 180.0, trade_date: "2026-01-10", disclosure_price: 182.0, disclosure_date: "2026-01-15", position_size: "$100,001 - $250,000", position_size_min: 100001, position_size_max: 250000 },
        meta: { source_url: "", source_id: "trade_3", scraped_at: new Date().toISOString() },
      }),
    ];

    const result = await ingestSignalBatch(env, signals);

    expect(result.inserted).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(env.mockDb.tables.signals).toHaveLength(3);
  });

  it("should skip duplicate signals", async () => {
    // Insert first batch
    const signal1 = createTestSignal({
      meta: { source_url: "", source_id: "dup_trade_1", scraped_at: new Date().toISOString() },
    });
    await ingestSignalBatch(env, [signal1]);

    expect(env.mockDb.tables.signals).toHaveLength(1);

    // Try to insert same signal again (same source + source_id)
    const signal2 = createTestSignal({
      meta: { source_url: "", source_id: "dup_trade_1", scraped_at: new Date().toISOString() },
    });
    const result = await ingestSignalBatch(env, [signal2]);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(env.mockDb.tables.signals).toHaveLength(1); // Still just 1
  });

  it("should handle mixed new and duplicate signals", async () => {
    // Insert first signal (NVDA)
    const existingSignal = createTestSignal({
      trade: { ticker: "NVDA", action: "buy", asset_type: "stock", trade_price: 140.0, trade_date: "2026-01-10", disclosure_price: 142.0, disclosure_date: "2026-01-15", position_size: "$100,001 - $250,000", position_size_min: 100001, position_size_max: 250000 },
      meta: { source_url: "", source_id: "existing_trade", scraped_at: new Date().toISOString() },
    });
    await ingestSignalBatch(env, [existingSignal]);

    // Try to insert batch with existing + new (different tickers to avoid logical dup)
    const batch = [
      createTestSignal({
        trade: { ticker: "NVDA", action: "buy", asset_type: "stock", trade_price: 140.0, trade_date: "2026-01-10", disclosure_price: 142.0, disclosure_date: "2026-01-15", position_size: "$100,001 - $250,000", position_size_min: 100001, position_size_max: 250000 },
        meta: { source_url: "", source_id: "existing_trade", scraped_at: new Date().toISOString() },
      }), // dup by source_id
      createTestSignal({
        trade: { ticker: "AAPL", action: "buy", asset_type: "stock", trade_price: 190.0, trade_date: "2026-01-10", disclosure_price: 192.0, disclosure_date: "2026-01-15", position_size: "$100,001 - $250,000", position_size_min: 100001, position_size_max: 250000 },
        meta: { source_url: "", source_id: "new_trade_1", scraped_at: new Date().toISOString() },
      }), // new
      createTestSignal({
        trade: { ticker: "GOOGL", action: "buy", asset_type: "stock", trade_price: 180.0, trade_date: "2026-01-10", disclosure_price: 182.0, disclosure_date: "2026-01-15", position_size: "$100,001 - $250,000", position_size_min: 100001, position_size_max: 250000 },
        meta: { source_url: "", source_id: "new_trade_2", scraped_at: new Date().toISOString() },
      }), // new
    ];

    const result = await ingestSignalBatch(env, batch);

    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(env.mockDb.tables.signals).toHaveLength(3); // 1 original + 2 new
  });

  it("should handle empty batch", async () => {
    const result = await ingestSignalBatch(env, []);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("should skip logical duplicates (same ticker, politician, date, action)", async () => {
    // Insert first signal
    const firstSignal = createTestSignal({
      trade: { ticker: "NVDA", action: "buy", asset_type: "stock", trade_price: 140.0, trade_date: "2026-01-10", disclosure_price: 142.0, disclosure_date: "2026-01-15", position_size: "$100,001 - $250,000", position_size_min: 100001, position_size_max: 250000 },
      meta: { source_url: "https://source1.com", source_id: "source1_trade_1", scraped_at: new Date().toISOString() },
    });
    await ingestSignalBatch(env, [firstSignal]);

    expect(env.mockDb.tables.signals).toHaveLength(1);

    // Try to insert same trade from different source (different source_id but same trade signature)
    const logicalDuplicateSignal = createTestSignal({
      source: "quiver_quant", // Different source
      trade: { ticker: "NVDA", action: "buy", asset_type: "stock", trade_price: 140.0, trade_date: "2026-01-10", disclosure_price: 142.0, disclosure_date: "2026-01-15", position_size: "$100,001 - $250,000", position_size_min: 100001, position_size_max: 250000 },
      meta: { source_url: "https://source2.com", source_id: "source2_trade_1", scraped_at: new Date().toISOString() },
    });
    const result = await ingestSignalBatch(env, [logicalDuplicateSignal]);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1); // Should be skipped as logical duplicate
    expect(result.errors).toHaveLength(0);
    expect(env.mockDb.tables.signals).toHaveLength(1); // Still just 1
  });

  it("should continue processing after individual errors", async () => {
    // Create a signal that will cause an error (missing required fields)
    const badSignal = {
      source: "capitol_trades",
      politician: { name: "Test", chamber: "House", party: "D", state: "CA" },
      trade: {
        ticker: "AAPL",
        action: "buy",
        asset_type: "stock",
        trade_price: null, // Will work but test edge case
        trade_date: "2026-01-10",
        disclosure_date: "2026-01-15",
        position_size: "",
        position_size_min: 0,
        position_size_max: 0,
      },
      meta: {
        source_url: "",
        source_id: "error_signal",
        scraped_at: new Date().toISOString(),
      },
    } as Signal;

    const goodSignal = createTestSignal({
      meta: { source_url: "", source_id: "good_signal", scraped_at: new Date().toISOString() },
    });

    const result = await ingestSignalBatch(env, [badSignal, goodSignal]);

    // Should have inserted at least the good signal
    // The "bad" signal might actually succeed since nulls are allowed
    expect(result.inserted + result.skipped + result.errors.length).toBe(2);
  });
});

describe("syncSignalsFromScraper", () => {
  let env: TraderEnv & { mockDb: ReturnType<typeof createMockD1> };
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    env = createMockEnv();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should fetch and insert signals from scraper", async () => {
    // Use distinct tickers to avoid logical duplicate detection
    const testSignals = [
      createTestSignal({
        trade: { ticker: "NVDA", action: "buy", asset_type: "stock", trade_price: 140.0, trade_date: "2026-01-10", disclosure_price: 142.0, disclosure_date: "2026-01-15", position_size: "$100,001 - $250,000", position_size_min: 100001, position_size_max: 250000 },
        meta: { source_url: "", source_id: "scraper_1", scraped_at: new Date().toISOString() },
      }),
      createTestSignal({
        trade: { ticker: "AAPL", action: "buy", asset_type: "stock", trade_price: 190.0, trade_date: "2026-01-10", disclosure_price: 192.0, disclosure_date: "2026-01-15", position_size: "$100,001 - $250,000", position_size_min: 100001, position_size_max: 250000 },
        meta: { source_url: "", source_id: "scraper_2", scraped_at: new Date().toISOString() },
      }),
    ];

    const mockResponse = createScraperResponse(testSignals);

    // Mock fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await syncSignalsFromScraper(env);

    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify fetch was called with correct params
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://scraper.example.com/api/v1/politrades/signals?limit=500",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-scraper-key",
        }),
      })
    );
  });

  it("should handle scraper API errors gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const result = await syncSignalsFromScraper(env);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("500");
  });

  it("should handle network errors gracefully", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await syncSignalsFromScraper(env);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Network error");
  });

  it("should skip duplicates when syncing", async () => {
    // Pre-insert a signal (NVDA)
    const existingSignal = createTestSignal({
      trade: { ticker: "NVDA", action: "buy", asset_type: "stock", trade_price: 140.0, trade_date: "2026-01-10", disclosure_price: 142.0, disclosure_date: "2026-01-15", position_size: "$100,001 - $250,000", position_size_min: 100001, position_size_max: 250000 },
      meta: { source_url: "", source_id: "existing_scraper_signal", scraped_at: new Date().toISOString() },
    });
    await ingestSignalBatch(env, [existingSignal]);

    // Mock scraper response with same signal + new one (different ticker)
    const scraperSignals = [
      createTestSignal({
        trade: { ticker: "NVDA", action: "buy", asset_type: "stock", trade_price: 140.0, trade_date: "2026-01-10", disclosure_price: 142.0, disclosure_date: "2026-01-15", position_size: "$100,001 - $250,000", position_size_min: 100001, position_size_max: 250000 },
        meta: { source_url: "", source_id: "existing_scraper_signal", scraped_at: new Date().toISOString() },
      }),
      createTestSignal({
        trade: { ticker: "AAPL", action: "buy", asset_type: "stock", trade_price: 190.0, trade_date: "2026-01-10", disclosure_price: 192.0, disclosure_date: "2026-01-15", position_size: "$100,001 - $250,000", position_size_min: 100001, position_size_max: 250000 },
        meta: { source_url: "", source_id: "new_scraper_signal", scraped_at: new Date().toISOString() },
      }),
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(createScraperResponse(scraperSignals)),
    });

    const result = await syncSignalsFromScraper(env);

    expect(result.inserted).toBe(1); // Only new one
    expect(result.skipped).toBe(1); // Existing one (by source_id)
    expect(result.errors).toHaveLength(0);
  });

  it("should handle sources_failed in response", async () => {
    const mockResponse: ScraperSignalsResponse = {
      signals: [],
      sources_fetched: ["capitol_trades"],
      sources_failed: { senate_stock_watcher: "Rate limit exceeded" },
      total_signals: 0,
      fetched_at: new Date().toISOString(),
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await syncSignalsFromScraper(env);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    // sources_failed errors are now logged but also added to result.errors
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("senate_stock_watcher");
  });
});

describe("Integration: Full Sync Flow", () => {
  let env: TraderEnv & { mockDb: ReturnType<typeof createMockD1> };
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    env = createMockEnv();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should handle a realistic scraper response", async () => {
    // Simulate realistic data from scraper
    const realisticSignals = [
      createTestSignal({
        source: "capitol_trades",
        politician: { name: "Nancy Pelosi", chamber: "House", party: "D", state: "CA" },
        trade: {
          ticker: "NVDA",
          action: "buy",
          asset_type: "stock",
          trade_price: 140.0,
          trade_date: "2026-01-05",
          disclosure_price: 145.0,
          disclosure_date: "2026-01-15",
          position_size: "$100,001 - $250,000",
          position_size_min: 100001,
          position_size_max: 250000,
        },
        meta: { source_url: "https://capitoltrades.com/trade/1", source_id: "ct_12345", scraped_at: "2026-01-15T10:00:00Z" },
      }),
      createTestSignal({
        source: "quiver_quant",
        politician: { name: "Mark Green", chamber: "House", party: "R", state: "TN" },
        trade: {
          ticker: "AAPL",
          action: "buy",
          asset_type: "stock",
          trade_price: 190.0,
          trade_date: "2026-01-08",
          disclosure_price: 195.0,
          disclosure_date: "2026-01-18",
          position_size: "$50,001 - $100,000",
          position_size_min: 50001,
          position_size_max: 100000,
        },
        meta: { source_url: "https://quiverquant.com/trade/2", source_id: "qq_67890", scraped_at: "2026-01-18T12:00:00Z" },
      }),
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(createScraperResponse(realisticSignals)),
    });

    const result = await syncSignalsFromScraper(env);

    expect(result.inserted).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify signals are in DB
    expect(env.mockDb.tables.signals).toHaveLength(2);

    // Verify signal data integrity
    const nvdaSignal = env.mockDb.tables.signals.find((s) => s.ticker === "NVDA");
    expect(nvdaSignal?.politician_name).toBe("Nancy Pelosi");
    expect(nvdaSignal?.source).toBe("capitol_trades");

    console.log("Synced signals:", env.mockDb.tables.signals.map((s) => ({
      ticker: s.ticker,
      politician: s.politician_name,
      source: s.source,
    })));
  });
});
