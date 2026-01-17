/**
 * Tests for the position monitoring engine
 * Run with: npx vitest run monitor.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PositionRow, AgentConfig, AssetType } from "./types";
import { CHATGPT_CONFIG, CLAUDE_CONFIG, GEMINI_CONFIG } from "./configs";

// Mock the loader and execution modules
vi.mock("./loader", () => ({
  getAgent: vi.fn(),
}));

vi.mock("./execution", () => ({
  executeSellOrder: vi.fn().mockResolvedValue({ success: true, order_id: "SELL123", total: 1000 }),
}));

// Mock getCurrentDate to return a fixed date for deterministic tests
// CRITICAL: Without this, tests will fail when run on different dates
vi.mock("./filters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./filters")>();
  return {
    ...actual,
    getCurrentDate: vi.fn().mockReturnValue("2026-01-16"),
  };
});

// Import after mocking
import {
  checkExitConditions,
  monitorPositions,
  closePosition,
  partialClosePosition,
  updateHighestPrice,
} from "./monitor";
import { getAgent } from "./loader";
import { executeSellOrder } from "./execution";

// Helper to create test position
function createTestPosition(overrides: Partial<PositionRow> = {}): PositionRow {
  return {
    id: "pos_123",
    agent_id: "chatgpt",
    ticker: "AAPL",
    shares: 10,
    entry_price: 100,
    entry_date: "2026-01-01",
    cost_basis: 1000,
    highest_price: 100,
    asset_type: "stock",
    status: "open",
    signal_id: "signal_123",
    partial_sold: 0,
    closed_at: null,
    close_price: null,
    close_reason: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// Helper to create mock environment
function createMockEnv() {
  return {
    TRADER_DB: {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: [] }),
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          first: vi.fn().mockResolvedValue(null),
        }),
      }),
    },
    TUNNEL_URL: "https://tunnel.example.com",
    TRADER_API_KEY: "test-api-key",
    SCRAPER_API_KEY: "scraper-key",
    SCRAPER_URL: "https://scraper.example.com",
  } as any;
}

describe("Position Monitoring Engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAgent as any).mockResolvedValue(CHATGPT_CONFIG);
  });

  describe("checkExitConditions - Stop Loss", () => {
    describe("Fixed stop-loss (ChatGPT/Claude)", () => {
      it("should trigger at threshold (-18% for ChatGPT)", () => {
        const position = createTestPosition({ entry_price: 100, highest_price: 100 });
        const currentPrice = 82; // -18% from entry

        const result = checkExitConditions(position, CHATGPT_CONFIG, currentPrice);

        expect(result).not.toBeNull();
        expect(result?.reason).toBe("stop_loss");
        expect(result?.sell_pct).toBe(100);
      });

      it("should trigger below threshold (-20%)", () => {
        const position = createTestPosition({ entry_price: 100 });
        const currentPrice = 80; // -20% from entry

        const result = checkExitConditions(position, CHATGPT_CONFIG, currentPrice);

        expect(result).not.toBeNull();
        expect(result?.reason).toBe("stop_loss");
      });

      it("should NOT trigger above threshold (-17%)", () => {
        const position = createTestPosition({ entry_price: 100 });
        const currentPrice = 83; // -17% from entry (above -18% threshold)

        const result = checkExitConditions(position, CHATGPT_CONFIG, currentPrice);

        expect(result).toBeNull();
      });

      it("should trigger at -15% for Claude", () => {
        const position = createTestPosition({ entry_price: 100, agent_id: "claude" });
        const currentPrice = 85; // -15% from entry

        const result = checkExitConditions(position, CLAUDE_CONFIG, currentPrice);

        expect(result).not.toBeNull();
        expect(result?.reason).toBe("stop_loss");
      });
    });

    describe("Trailing stop-loss (Gemini)", () => {
      it("should trigger on 20% drop from highest", () => {
        const position = createTestPosition({
          agent_id: "gemini",
          entry_price: 100,
          highest_price: 150, // Price went up to 150
        });
        const currentPrice = 120; // 20% below highest (150 × 0.8 = 120)

        const result = checkExitConditions(position, GEMINI_CONFIG, currentPrice);

        expect(result).not.toBeNull();
        expect(result?.reason).toBe("stop_loss");
      });

      it("should NOT trigger on 19% drop from highest", () => {
        const position = createTestPosition({
          agent_id: "gemini",
          entry_price: 100,
          highest_price: 150,
        });
        const currentPrice = 122; // ~18.7% below highest

        const result = checkExitConditions(position, GEMINI_CONFIG, currentPrice);

        expect(result).toBeNull();
      });

      it("should trigger even when still profitable", () => {
        // Position is still up overall but dropped 20% from peak
        const position = createTestPosition({
          agent_id: "gemini",
          entry_price: 100,
          highest_price: 200, // Doubled
        });
        const currentPrice = 160; // 20% below highest, but still +60% from entry

        const result = checkExitConditions(position, GEMINI_CONFIG, currentPrice);

        expect(result).not.toBeNull();
        expect(result?.reason).toBe("stop_loss");
      });
    });
  });

  describe("checkExitConditions - Take Profit", () => {
    it("should trigger partial sell at first tier (25%) for Claude", () => {
      const position = createTestPosition({
        agent_id: "claude",
        entry_price: 100,
        partial_sold: 0,
      });
      const currentPrice = 125; // +25%

      const result = checkExitConditions(position, CLAUDE_CONFIG, currentPrice);

      expect(result).not.toBeNull();
      expect(result?.reason).toBe("take_profit");
      expect(result?.action).toBe("partial");
      expect(result?.sell_pct).toBe(50); // First tier sells 50%
    });

    it("should trigger full sell at second tier (40%) for Claude", () => {
      const position = createTestPosition({
        agent_id: "claude",
        entry_price: 100,
        partial_sold: 1, // Already sold partial
      });
      const currentPrice = 140; // +40%

      const result = checkExitConditions(position, CLAUDE_CONFIG, currentPrice);

      expect(result).not.toBeNull();
      expect(result?.reason).toBe("take_profit");
      expect(result?.action).toBe("close");
      expect(result?.sell_pct).toBe(100);
    });

    it("should skip first tier if already partial sold", () => {
      const position = createTestPosition({
        agent_id: "claude",
        entry_price: 100,
        partial_sold: 1, // Already did partial sell
      });
      const currentPrice = 130; // +30% (above first tier, below second)

      const result = checkExitConditions(position, CLAUDE_CONFIG, currentPrice);

      expect(result).toBeNull(); // No action, waiting for second tier
    });

    it("should NOT trigger take-profit for ChatGPT (no take_profit config)", () => {
      const position = createTestPosition({
        agent_id: "chatgpt",
        entry_price: 100,
      });
      const currentPrice = 150; // +50%

      const result = checkExitConditions(position, CHATGPT_CONFIG, currentPrice);

      expect(result).toBeNull();
    });
  });

  describe("checkExitConditions - Time Exit", () => {
    it("should trigger at max_hold_days (120 for ChatGPT)", () => {
      const position = createTestPosition({
        entry_date: "2025-09-01", // 138 days ago from 2026-01-16
      });

      const result = checkExitConditions(position, CHATGPT_CONFIG, 100);

      expect(result).not.toBeNull();
      expect(result?.reason).toBe("time_exit");
    });

    it("should NOT trigger time_exit before max_hold_days (profitable position)", () => {
      // This test verifies time_exit doesn't trigger at 46 days (< 120 day limit)
      // Position must be profitable to avoid soft_stop triggering instead
      const position = createTestPosition({
        entry_date: "2025-12-01", // 46 days ago from 2026-01-16
        entry_price: 100,
      });
      const currentPrice = 110; // +10% profit - ensures soft_stop won't trigger

      const result = checkExitConditions(position, CHATGPT_CONFIG, currentPrice);

      expect(result).toBeNull();
    });

    it("should NOT trigger for Gemini (no max_hold_days)", () => {
      const position = createTestPosition({
        agent_id: "gemini",
        entry_date: "2024-01-01", // Very old
      });

      const result = checkExitConditions(position, GEMINI_CONFIG, 100);

      expect(result).toBeNull();
    });
  });

  describe("checkExitConditions - Soft Stop", () => {
    it("should trigger for ChatGPT stock with no progress after 30 days", () => {
      const position = createTestPosition({
        entry_date: "2025-12-01", // 46 days ago
        entry_price: 100,
        asset_type: "stock",
      });
      const currentPrice = 100; // 0% return

      const result = checkExitConditions(position, CHATGPT_CONFIG, currentPrice);

      expect(result).not.toBeNull();
      expect(result?.reason).toBe("soft_stop");
    });

    it("should trigger for ChatGPT option with no progress after 10 days", () => {
      const position = createTestPosition({
        entry_date: "2026-01-01", // 15 days ago
        entry_price: 100,
        asset_type: "option",
      });
      const currentPrice = 95; // -5% (still negative = no progress)

      const result = checkExitConditions(position, CHATGPT_CONFIG, currentPrice);

      expect(result).not.toBeNull();
      expect(result?.reason).toBe("soft_stop");
    });

    it("should NOT trigger if position is profitable", () => {
      const position = createTestPosition({
        entry_date: "2025-12-01", // 46 days ago
        entry_price: 100,
      });
      const currentPrice = 101; // +1% (positive progress)

      const result = checkExitConditions(position, CHATGPT_CONFIG, currentPrice);

      expect(result).toBeNull();
    });

    it("should NOT trigger for Claude (no soft_stop config)", () => {
      const position = createTestPosition({
        agent_id: "claude",
        entry_date: "2025-12-01",
        entry_price: 100,
      });
      const currentPrice = 100; // 0%

      const result = checkExitConditions(position, CLAUDE_CONFIG, currentPrice);

      expect(result).toBeNull();
    });
  });

  describe("Exit priority", () => {
    it("should prioritize stop-loss over other exits", () => {
      // Position qualifies for both stop-loss and time exit
      const position = createTestPosition({
        entry_date: "2025-09-01", // Old enough for time exit
        entry_price: 100,
      });
      const currentPrice = 80; // -20%, triggers stop-loss

      const result = checkExitConditions(position, CHATGPT_CONFIG, currentPrice);

      expect(result?.reason).toBe("stop_loss");
    });

    it("should check take-profit before time exit", () => {
      // Position qualifies for both take-profit and time exit
      const position = createTestPosition({
        agent_id: "claude",
        entry_date: "2025-09-01", // Old enough for time exit
        entry_price: 100,
        partial_sold: 0,
      });
      const currentPrice = 125; // +25%, triggers take-profit

      const result = checkExitConditions(position, CLAUDE_CONFIG, currentPrice);

      expect(result?.reason).toBe("take_profit");
    });
  });

  describe("Database operations", () => {
    it("should update highest price", async () => {
      const env = createMockEnv();
      let capturedBindArgs: any[] = [];

      env.TRADER_DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn((...args) => {
          capturedBindArgs = args;
          return {
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          };
        }),
      });

      await updateHighestPrice(env, "pos_123", 175);

      expect(capturedBindArgs).toContain(175);
      expect(capturedBindArgs).toContain("pos_123");
    });

    it("should close position with correct fields", async () => {
      const env = createMockEnv();
      let capturedBindArgs: any[] = [];

      env.TRADER_DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn((...args) => {
          capturedBindArgs = args;
          return {
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          };
        }),
      });

      await closePosition(env, "pos_123", "stop_loss", 85);

      expect(capturedBindArgs).toContain(85); // close_price
      expect(capturedBindArgs).toContain("stop_loss"); // close_reason
      expect(capturedBindArgs).toContain("pos_123"); // position id
    });

    it("should partial close position correctly", async () => {
      const env = createMockEnv();
      let capturedBindArgs: any[] = [];

      env.TRADER_DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn((...args) => {
          capturedBindArgs = args;
          return {
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          };
        }),
      });

      await partialClosePosition(env, "pos_123", 5, 125);

      expect(capturedBindArgs).toContain(5); // shares sold
      expect(capturedBindArgs).toContain("pos_123"); // position id
    });
  });

  describe("monitorPositions", () => {
    it("should return empty result when no positions", async () => {
      const env = createMockEnv();
      env.TRADER_DB.prepare = vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: [] }),
      });

      const result = await monitorPositions(env);

      expect(result.positions_checked).toBe(0);
      expect(result.exits_triggered).toBe(0);
      expect(result.exits).toHaveLength(0);
    });

    it("should update highest price when price increases", async () => {
      const env = createMockEnv();
      const position = createTestPosition({ highest_price: 100 });

      // Mock getting positions
      env.TRADER_DB.prepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("SELECT * FROM positions WHERE status")) {
          return {
            all: vi.fn().mockResolvedValue({ results: [position] }),
          };
        }
        if (sql.includes("current_price FROM positions")) {
          return {
            bind: vi.fn().mockReturnValue({
              first: vi.fn().mockResolvedValue({ current_price: 110 }), // Price went up
            }),
          };
        }
        return {
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          }),
        };
      });

      const result = await monitorPositions(env);

      expect(result.highest_price_updates).toBe(1);
    });

    it("should record errors for missing prices", async () => {
      const env = createMockEnv();
      const position = createTestPosition();

      env.TRADER_DB.prepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("SELECT * FROM positions WHERE status")) {
          return {
            all: vi.fn().mockResolvedValue({ results: [position] }),
          };
        }
        return {
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(null), // No price
          }),
        };
      });

      const result = await monitorPositions(env);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("No price available");
    });
  });
});
