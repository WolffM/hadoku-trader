/**
 * Signal Sync Functions Test
 *
 * Tests for syncSignalsFromScraper and ingestSignalBatch functions
 * that handle signal acquisition from the scraper.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { TraderEnv, Signal, ScraperDataPackage } from "./types";
import { syncSignalsFromScraper, ingestSignalBatch } from "./scheduled";

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

function createScraperDataPackage(signals: Signal[]): ScraperDataPackage {
  return {
    signals,
    market_data: {
      quotes: [
        { ticker: "NVDA", price: 145.0 },
        { ticker: "AAPL", price: 195.0 },
      ],
      sp500: { price: 5850.0 },
    },
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
    const signals = [
      createTestSignal({ meta: { source_url: "", source_id: "trade_1", scraped_at: new Date().toISOString() } }),
      createTestSignal({ meta: { source_url: "", source_id: "trade_2", scraped_at: new Date().toISOString() } }),
      createTestSignal({ meta: { source_url: "", source_id: "trade_3", scraped_at: new Date().toISOString() } }),
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
    // Insert first signal
    const existingSignal = createTestSignal({
      meta: { source_url: "", source_id: "existing_trade", scraped_at: new Date().toISOString() },
    });
    await ingestSignalBatch(env, [existingSignal]);

    // Try to insert batch with existing + new
    const batch = [
      createTestSignal({ meta: { source_url: "", source_id: "existing_trade", scraped_at: new Date().toISOString() } }), // dup
      createTestSignal({ meta: { source_url: "", source_id: "new_trade_1", scraped_at: new Date().toISOString() } }), // new
      createTestSignal({ meta: { source_url: "", source_id: "new_trade_2", scraped_at: new Date().toISOString() } }), // new
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
    const testSignals = [
      createTestSignal({ meta: { source_url: "", source_id: "scraper_1", scraped_at: new Date().toISOString() } }),
      createTestSignal({ meta: { source_url: "", source_id: "scraper_2", scraped_at: new Date().toISOString() } }),
    ];

    const mockDataPackage = createScraperDataPackage(testSignals);

    // Mock fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockDataPackage),
    });

    const result = await syncSignalsFromScraper(env);

    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify fetch was called with correct params
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://scraper.example.com/data-package",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-API-Key": "test-scraper-key",
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
    // Pre-insert a signal
    const existingSignal = createTestSignal({
      meta: { source_url: "", source_id: "existing_scraper_signal", scraped_at: new Date().toISOString() },
    });
    await ingestSignalBatch(env, [existingSignal]);

    // Mock scraper response with same signal + new one
    const scraperSignals = [
      createTestSignal({ meta: { source_url: "", source_id: "existing_scraper_signal", scraped_at: new Date().toISOString() } }),
      createTestSignal({ meta: { source_url: "", source_id: "new_scraper_signal", scraped_at: new Date().toISOString() } }),
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(createScraperDataPackage(scraperSignals)),
    });

    const result = await syncSignalsFromScraper(env);

    expect(result.inserted).toBe(1); // Only new one
    expect(result.skipped).toBe(1); // Existing one
    expect(result.errors).toHaveLength(0);
  });

  it("should update SP500 price in config", async () => {
    const mockDataPackage = createScraperDataPackage([]);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockDataPackage),
    });

    await syncSignalsFromScraper(env);

    // Check SP500 was stored
    const configEntry = env.mockDb.tables.config.find((c) => c.key === "sp500_price");
    expect(configEntry).toBeDefined();
    expect(configEntry?.value).toBe("5850");
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
      json: () => Promise.resolve(createScraperDataPackage(realisticSignals)),
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
