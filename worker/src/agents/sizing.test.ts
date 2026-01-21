/**
 * Tests for the position sizing engine
 * Run with: npx vitest run sizing.test.ts
 */

import { describe, it, expect } from "vitest";
import type { AgentConfig } from "./types";
import {
  calculatePositionSize,
  calculateShares,
  validatePositionSize,
  calculateSmartBudgetSize,
  getBucketForSize,
  getSmartBudgetBreakdown,
} from "./sizing";
import { DEFAULT_BUCKET_CONFIG } from "./configs";

// =============================================================================
// Test-specific agent configs (isolated from production config changes)
// =============================================================================

const TEST_SCORE_SQUARED_AGENT: AgentConfig = {
  id: "test_score_squared",
  name: "Test Score Squared",
  monthly_budget: 1000,
  politician_whitelist: null,
  allowed_asset_types: ["stock"],
  max_signal_age_days: 45,
  max_price_move_pct: 25,
  scoring: null,
  execute_threshold: 0.55,
  half_size_threshold: 0.45,
  sizing: {
    mode: "score_squared",
    base_multiplier: 0.2,
    max_position_pct: 0.2,
    max_position_amount: 200,
    min_position_amount: 50,
    max_open_positions: 9999,
    max_per_ticker: 9999,
  },
  exit: {
    stop_loss: { mode: "fixed", threshold_pct: 18 },
    max_hold_days: 120,
  },
};

const TEST_SCORE_LINEAR_AGENT: AgentConfig = {
  id: "test_score_linear",
  name: "Test Score Linear",
  monthly_budget: 1000,
  politician_whitelist: null,
  allowed_asset_types: ["stock"],
  max_signal_age_days: 45,
  max_price_move_pct: 30,
  scoring: null,
  execute_threshold: 0.55,
  half_size_threshold: null,
  sizing: {
    mode: "score_linear",
    base_amount: 200,
    max_position_pct: 1.0,
    max_position_amount: 250,
    min_position_amount: 50,
    max_open_positions: 9999,
    max_per_ticker: 9999,
  },
  exit: {
    stop_loss: { mode: "fixed", threshold_pct: 15 },
    max_hold_days: 90,
  },
};

const TEST_EQUAL_SPLIT_AGENT: AgentConfig = {
  id: "test_equal_split",
  name: "Test Equal Split",
  monthly_budget: 1000,
  politician_whitelist: null,
  allowed_asset_types: ["stock"],
  max_signal_age_days: 45,
  max_price_move_pct: 15,
  scoring: null,
  execute_threshold: 0,
  half_size_threshold: null,
  sizing: {
    mode: "equal_split",
    max_position_pct: 0.3,
    max_position_amount: 1000,
    min_position_amount: 0,
    max_open_positions: 9999,
    max_per_ticker: 9999,
  },
  exit: {
    stop_loss: { mode: "trailing", threshold_pct: 20 },
    max_hold_days: null,
  },
};

const TEST_SMART_BUDGET_AGENT: AgentConfig = {
  id: "test_smart_budget",
  name: "Test Smart Budget",
  monthly_budget: 1000,
  politician_whitelist: null,
  allowed_asset_types: ["stock"],
  max_signal_age_days: 45,
  max_price_move_pct: 15,
  scoring: null,
  execute_threshold: 0,
  half_size_threshold: null,
  sizing: {
    mode: "smart_budget",
    bucket_config: DEFAULT_BUCKET_CONFIG,
    max_position_pct: 1.0,
    max_position_amount: 1000,
    min_position_amount: 0,
    max_open_positions: 9999,
    max_per_ticker: 9999,
  },
  exit: {
    stop_loss: { mode: "trailing", threshold_pct: 20 },
    max_hold_days: null,
  },
};

describe("Position Sizing Engine", () => {
  describe("score_squared mode", () => {
    const agent = TEST_SCORE_SQUARED_AGENT;

    it("should calculate correctly at score 1.0", () => {
      // 1.0² × 0.2 × 1000 = 1 × 200 = $200
      const size = calculatePositionSize(agent, 1.0, { remaining: 1000 });
      expect(size).toBe(200);
    });

    it("should calculate correctly at score 0.7", () => {
      // 0.7² × 0.2 × 1000 = 0.49 × 200 = $98
      const size = calculatePositionSize(agent, 0.7, { remaining: 1000 });
      expect(size).toBe(98);
    });

    it("should calculate correctly at score 0.8", () => {
      // 0.8² × 0.2 × 1000 = 0.64 × 200 = $128
      const size = calculatePositionSize(agent, 0.8, { remaining: 1000 });
      expect(size).toBe(128);
    });

    it("should calculate correctly at score 0.55", () => {
      // 0.55² × 0.2 × 1000 = 0.3025 × 200 = $60.50
      const size = calculatePositionSize(agent, 0.55, { remaining: 1000 });
      expect(size).toBe(60.5);
    });

    it("should throw error if score is null", () => {
      expect(() => {
        calculatePositionSize(agent, null, { remaining: 1000 });
      }).toThrow("score_squared mode requires a score");
    });
  });

  describe("score_linear mode", () => {
    const agent = TEST_SCORE_LINEAR_AGENT;

    it("should calculate correctly at score 1.0", () => {
      // 200 × 1.0 = $200
      const size = calculatePositionSize(agent, 1.0, { remaining: 1000 });
      expect(size).toBe(200);
    });

    it("should calculate correctly at score 0.55", () => {
      // 200 × 0.55 = $110
      const size = calculatePositionSize(agent, 0.55, { remaining: 1000 });
      expect(size).toBe(110);
    });

    it("should calculate correctly at score 0.75", () => {
      // 200 × 0.75 = $150
      const size = calculatePositionSize(agent, 0.75, { remaining: 1000 });
      expect(size).toBe(150);
    });

    it("should respect max_position_amount ($250)", () => {
      // Even with score > 1.25 that would give > $250, should cap at $250
      const size = calculatePositionSize(agent, 1.5, { remaining: 1000 });
      // 200 × 1.5 = $300, but capped at $250
      expect(size).toBe(250);
    });

    it("should throw error if score is null", () => {
      expect(() => {
        calculatePositionSize(agent, null, { remaining: 1000 });
      }).toThrow("score_linear mode requires a score");
    });
  });

  describe("equal_split mode", () => {
    const agent = TEST_EQUAL_SPLIT_AGENT;

    it("should split budget equally with 5 signals", () => {
      // 1000 / 5 = $200
      const size = calculatePositionSize(agent, null, { remaining: 1000 }, 5);
      expect(size).toBe(200);
    });

    it("should split budget equally with 10 signals", () => {
      // 1000 / 10 = $100
      const size = calculatePositionSize(agent, null, { remaining: 1000 }, 10);
      expect(size).toBe(100);
    });

    it("should use full budget with 1 signal", () => {
      // 1000 / 1 = $1000, but capped at max_position_pct (30% = $300)
      const size = calculatePositionSize(agent, null, { remaining: 1000 }, 1);
      expect(size).toBe(300); // 30% of $1000
    });

    it("should handle 0 signals gracefully (treat as 1)", () => {
      const size = calculatePositionSize(agent, null, { remaining: 1000 }, 0);
      // 1000 / 1 = $1000, capped at 30% = $300
      expect(size).toBe(300);
    });

    it("should not require score in equal_split mode", () => {
      // Should not throw even with null score
      const size = calculatePositionSize(agent, null, { remaining: 1000 }, 5);
      expect(size).toBe(200);
    });
  });

  describe("Constraint enforcement", () => {
    it("should respect max_position_amount ($200)", () => {
      // Even with perfect score, capped at $200
      const size = calculatePositionSize(TEST_SCORE_SQUARED_AGENT, 1.0, {
        remaining: 1000,
      });
      expect(size).toBeLessThanOrEqual(200);
    });

    it("should respect max_position_pct (20%)", () => {
      // Create agent with higher base_multiplier so raw calculation exceeds pct cap
      // This isolates the max_position_pct constraint from other constraints
      const agent: AgentConfig = {
        ...TEST_SCORE_SQUARED_AGENT,
        sizing: {
          ...TEST_SCORE_SQUARED_AGENT.sizing,
          base_multiplier: 0.5, // 50% instead of 20%
          max_position_amount: 1000, // Raise high so it doesn't interfere
        },
      };
      // Raw calculation: 1.0² × 0.5 × 1000 = $500
      // But max_position_pct is 20%, so cap at 20% of $1000 = $200
      const size = calculatePositionSize(agent, 1.0, { remaining: 1000 });
      expect(size).toBe(200);
    });

    it("should respect budget remaining", () => {
      // Only $75 left, should cap at that
      const size = calculatePositionSize(TEST_SCORE_SQUARED_AGENT, 1.0, {
        remaining: 75,
      });
      expect(size).toBe(75);
    });

    it("should return 0 if calculated size is below minimum ($50)", () => {
      // With very low score, size will be below $50
      // 0.4² × 0.2 × 1000 = 0.16 × 200 = $32 < $50
      const size = calculatePositionSize(TEST_SCORE_SQUARED_AGENT, 0.4, {
        remaining: 1000,
      });
      expect(size).toBe(0);
    });

    it("should return 0 if budget remaining is below minimum", () => {
      const size = calculatePositionSize(TEST_SCORE_SQUARED_AGENT, 1.0, { remaining: 30 });
      // Would calculate $200 but capped at $30 which is < $50 min
      expect(size).toBe(0);
    });
  });

  describe("Half-size decision (execute_half)", () => {
    it("should halve score_squared size for execute_half", () => {
      // Normal: 0.8² × 0.2 × 1000 = $128
      // Half: $64
      const normalSize = calculatePositionSize(
        TEST_SCORE_SQUARED_AGENT,
        0.8,
        { remaining: 1000 },
        1,
        false
      );
      const halfSize = calculatePositionSize(
        TEST_SCORE_SQUARED_AGENT,
        0.8,
        { remaining: 1000 },
        1,
        true
      );
      expect(halfSize).toBe(64);
      expect(halfSize).toBe(normalSize / 2);
    });

    it("should halve score_linear size for execute_half", () => {
      // Normal: 200 × 0.7 = $140
      // Half: $70
      const normalSize = calculatePositionSize(
        TEST_SCORE_LINEAR_AGENT,
        0.7,
        { remaining: 1000 },
        1,
        false
      );
      const halfSize = calculatePositionSize(
        TEST_SCORE_LINEAR_AGENT,
        0.7,
        { remaining: 1000 },
        1,
        true
      );
      expect(halfSize).toBe(70);
      expect(halfSize).toBe(normalSize / 2);
    });

    it("should return 0 if half-size is below minimum", () => {
      // 0.55² × 0.2 × 1000 = $60.50, half = $30.25 < $50 min
      const size = calculatePositionSize(
        TEST_SCORE_SQUARED_AGENT,
        0.55,
        { remaining: 1000 },
        1,
        true
      );
      expect(size).toBe(0);
    });
  });

  describe("Edge cases", () => {
    it("should handle score of 0", () => {
      // 0² × anything = 0, below minimum
      const size = calculatePositionSize(TEST_SCORE_SQUARED_AGENT, 0, { remaining: 1000 });
      expect(size).toBe(0);
    });

    it("should handle negative budget remaining", () => {
      const size = calculatePositionSize(TEST_SCORE_SQUARED_AGENT, 1.0, { remaining: -100 });
      expect(size).toBe(0);
    });

    it("should round to 2 decimal places", () => {
      // 0.55² × 0.2 × 1000 = 0.3025 × 200 = 60.5
      const size = calculatePositionSize(TEST_SCORE_SQUARED_AGENT, 0.55, {
        remaining: 1000,
      });
      expect(size).toBe(60.5);
      // Verify it's exactly 2 decimal places
      expect(size.toString().split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
    });
  });

  describe("smart_budget mode", () => {
    it("should calculate per-trade size based on bucket", () => {
      // Small bucket: ~$5 per trade
      const smallSize = calculatePositionSize(
        TEST_SMART_BUDGET_AGENT,
        null,
        { remaining: 1000 },
        1,
        false,
        5000 // Small congressional position
      );
      expect(smallSize).toBeCloseTo(4.94, 1);

      // Medium bucket: ~$16 per trade
      const mediumSize = calculatePositionSize(
        TEST_SMART_BUDGET_AGENT,
        null,
        { remaining: 1000 },
        1,
        false,
        30000 // Medium congressional position
      );
      expect(mediumSize).toBeCloseTo(16.3, 1);

      // Large bucket: ~$49 per trade
      const largeSize = calculatePositionSize(
        TEST_SMART_BUDGET_AGENT,
        null,
        { remaining: 1000 },
        1,
        false,
        100000 // Large congressional position
      );
      expect(largeSize).toBeCloseTo(49.38, 1);
    });

    it("should scale with budget remaining constraint", () => {
      const size = calculatePositionSize(
        TEST_SMART_BUDGET_AGENT,
        null,
        { remaining: 3 }, // Only $3 left
        1,
        false,
        100000 // Would normally be ~$49
      );
      expect(size).toBe(3); // Capped at remaining budget
    });
  });
});

describe("calculateShares", () => {
  it("should calculate whole shares correctly", () => {
    // $200 / $50 per share = 4 shares
    const shares = calculateShares(200, 50);
    expect(shares).toBe(4);
  });

  it("should round down to whole shares", () => {
    // $200 / $60 per share = 3.33... → 3 shares
    const shares = calculateShares(200, 60);
    expect(shares).toBe(3);
  });

  it("should return 0 for 0 price", () => {
    const shares = calculateShares(200, 0);
    expect(shares).toBe(0);
  });

  it("should return 0 for negative price", () => {
    const shares = calculateShares(200, -10);
    expect(shares).toBe(0);
  });

  it("should handle fractional shares when enabled", () => {
    // $200 / $60 = 3.333...
    const shares = calculateShares(200, 60, true);
    expect(shares).toBeCloseTo(3.333, 2);
  });

  it("should round fractional shares to 3 decimal places", () => {
    const shares = calculateShares(100, 33, true);
    // 100/33 = 3.030303...
    expect(shares).toBe(3.03);
  });
});

describe("validatePositionSize", () => {
  it("should return valid for correct size", () => {
    const result = validatePositionSize(TEST_SCORE_SQUARED_AGENT, 100, { remaining: 500 });
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("should catch below minimum violation", () => {
    const result = validatePositionSize(TEST_SCORE_SQUARED_AGENT, 30, { remaining: 500 });
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("Below minimum: $30 < $50");
  });

  it("should catch above maximum violation", () => {
    const result = validatePositionSize(TEST_SCORE_SQUARED_AGENT, 300, { remaining: 500 });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("Above maximum"))).toBe(true);
  });

  it("should catch budget exceeded violation", () => {
    const result = validatePositionSize(TEST_SCORE_SQUARED_AGENT, 100, { remaining: 50 });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("Exceeds budget"))).toBe(
      true
    );
  });

  it("should catch multiple violations", () => {
    const result = validatePositionSize(TEST_SCORE_SQUARED_AGENT, 300, { remaining: 50 });
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThan(1);
  });
});

describe("Smart Budget Helper Functions", () => {
  describe("getBucketForSize", () => {
    it("should classify small positions correctly", () => {
      expect(getBucketForSize(DEFAULT_BUCKET_CONFIG, 1000)).toBe("small");
      expect(getBucketForSize(DEFAULT_BUCKET_CONFIG, 10000)).toBe("small");
      expect(getBucketForSize(DEFAULT_BUCKET_CONFIG, 15000)).toBe("small");
    });

    it("should classify medium positions correctly", () => {
      expect(getBucketForSize(DEFAULT_BUCKET_CONFIG, 15001)).toBe("medium");
      expect(getBucketForSize(DEFAULT_BUCKET_CONFIG, 30000)).toBe("medium");
      expect(getBucketForSize(DEFAULT_BUCKET_CONFIG, 50000)).toBe("medium");
    });

    it("should classify large positions correctly", () => {
      expect(getBucketForSize(DEFAULT_BUCKET_CONFIG, 50001)).toBe("large");
      expect(getBucketForSize(DEFAULT_BUCKET_CONFIG, 100000)).toBe("large");
      expect(getBucketForSize(DEFAULT_BUCKET_CONFIG, 1000000)).toBe("large");
    });

    it("should default to small for positions below minimum", () => {
      expect(getBucketForSize(DEFAULT_BUCKET_CONFIG, 500)).toBe("small");
      expect(getBucketForSize(DEFAULT_BUCKET_CONFIG, 0)).toBe("small");
    });
  });

  describe("getSmartBudgetBreakdown", () => {
    it("should calculate budget breakdown correctly", () => {
      const breakdown = getSmartBudgetBreakdown(1000, DEFAULT_BUCKET_CONFIG);

      // Total exposure: 70*10K + 25*33K + 5*100K = 700K + 825K + 500K = 2,025K
      // Small: 700K/2025K = 34.57%
      // Medium: 825K/2025K = 40.74%
      // Large: 500K/2025K = 24.69%

      expect(breakdown.small.budget).toBeCloseTo(345.68, 0);
      expect(breakdown.medium.budget).toBeCloseTo(407.41, 0);
      expect(breakdown.large.budget).toBeCloseTo(246.91, 0);

      // Per-trade amounts
      expect(breakdown.small.perTrade).toBeCloseTo(4.94, 1);
      expect(breakdown.medium.perTrade).toBeCloseTo(16.3, 1);
      expect(breakdown.large.perTrade).toBeCloseTo(49.38, 1);

      expect(breakdown.totalExposure).toBe(2025000);
    });
  });

  describe("calculateSmartBudgetSize", () => {
    it("should return fallback when no bucket config", () => {
      const size = calculateSmartBudgetSize(1000, undefined, 10000);
      expect(size).toBe(50); // 5% fallback
    });

    it("should calculate correct size per bucket", () => {
      // Small
      const smallSize = calculateSmartBudgetSize(1000, DEFAULT_BUCKET_CONFIG, 5000);
      expect(smallSize).toBeCloseTo(4.94, 1);

      // Medium
      const mediumSize = calculateSmartBudgetSize(1000, DEFAULT_BUCKET_CONFIG, 30000);
      expect(mediumSize).toBeCloseTo(16.3, 1);

      // Large
      const largeSize = calculateSmartBudgetSize(1000, DEFAULT_BUCKET_CONFIG, 100000);
      expect(largeSize).toBeCloseTo(49.38, 1);
    });
  });
});
