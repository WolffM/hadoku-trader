/**
 * Tests for the position sizing engine
 * Run with: npx vitest run sizing.test.ts
 */

import { describe, it, expect } from "vitest";
import type { AgentConfig } from "./types";
import { CHATGPT_CONFIG, CLAUDE_CONFIG, GEMINI_CONFIG } from "./configs";
import {
  calculatePositionSize,
  calculateShares,
  validatePositionSize,
} from "./sizing";

describe("Position Sizing Engine", () => {
  describe("score_squared mode (ChatGPT)", () => {
    const agent = CHATGPT_CONFIG;

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

  describe("score_linear mode (Claude)", () => {
    const agent = CLAUDE_CONFIG;

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

    it("should respect max_position_amount ($250 for Claude)", () => {
      // Even with score > 1.25 that would give > $250, should cap at $250
      // But Claude's execute_threshold is 0.55, so max realistic is around $200
      // Let's test with hypothetical high score
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

  describe("equal_split mode (Gemini)", () => {
    const agent = GEMINI_CONFIG;

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
    it("should respect max_position_amount for ChatGPT ($200)", () => {
      // Even with perfect score, capped at $200
      const size = calculatePositionSize(CHATGPT_CONFIG, 1.0, {
        remaining: 1000,
      });
      expect(size).toBeLessThanOrEqual(200);
    });

    it("should respect max_position_pct for ChatGPT (20%)", () => {
      // Create agent with higher base_multiplier so raw calculation exceeds pct cap
      // This isolates the max_position_pct constraint from other constraints
      const agent = {
        ...CHATGPT_CONFIG,
        sizing: {
          ...CHATGPT_CONFIG.sizing,
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
      const size = calculatePositionSize(CHATGPT_CONFIG, 1.0, {
        remaining: 75,
      });
      expect(size).toBe(75);
    });

    it("should return 0 if calculated size is below minimum ($50)", () => {
      // With very low score, size will be below $50
      // 0.4² × 0.2 × 1000 = 0.16 × 200 = $32 < $50
      const size = calculatePositionSize(CHATGPT_CONFIG, 0.4, {
        remaining: 1000,
      });
      expect(size).toBe(0);
    });

    it("should return 0 if budget remaining is below minimum", () => {
      const size = calculatePositionSize(CHATGPT_CONFIG, 1.0, { remaining: 30 });
      // Would calculate $200 but capped at $30 which is < $50 min
      expect(size).toBe(0);
    });
  });

  describe("Half-size decision (execute_half)", () => {
    it("should halve ChatGPT size for execute_half", () => {
      // Normal: 0.8² × 0.2 × 1000 = $128
      // Half: $64
      const normalSize = calculatePositionSize(
        CHATGPT_CONFIG,
        0.8,
        { remaining: 1000 },
        1,
        false
      );
      const halfSize = calculatePositionSize(
        CHATGPT_CONFIG,
        0.8,
        { remaining: 1000 },
        1,
        true
      );
      expect(halfSize).toBe(64);
      expect(halfSize).toBe(normalSize / 2);
    });

    it("should halve Claude size for execute_half", () => {
      // Normal: 200 × 0.7 = $140
      // Half: $70
      const normalSize = calculatePositionSize(
        CLAUDE_CONFIG,
        0.7,
        { remaining: 1000 },
        1,
        false
      );
      const halfSize = calculatePositionSize(
        CLAUDE_CONFIG,
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
        CHATGPT_CONFIG,
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
      const size = calculatePositionSize(CHATGPT_CONFIG, 0, { remaining: 1000 });
      expect(size).toBe(0);
    });

    it("should handle negative budget remaining", () => {
      const size = calculatePositionSize(CHATGPT_CONFIG, 1.0, { remaining: -100 });
      expect(size).toBe(0);
    });

    it("should round to 2 decimal places", () => {
      // 0.55² × 0.2 × 1000 = 0.3025 × 200 = 60.5
      const size = calculatePositionSize(CHATGPT_CONFIG, 0.55, {
        remaining: 1000,
      });
      expect(size).toBe(60.5);
      // Verify it's exactly 2 decimal places
      expect(size.toString().split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
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
    const result = validatePositionSize(CHATGPT_CONFIG, 100, { remaining: 500 });
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("should catch below minimum violation", () => {
    const result = validatePositionSize(CHATGPT_CONFIG, 30, { remaining: 500 });
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("Below minimum: $30 < $50");
  });

  it("should catch above maximum violation", () => {
    const result = validatePositionSize(CHATGPT_CONFIG, 300, { remaining: 500 });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("Above maximum"))).toBe(true);
  });

  it("should catch budget exceeded violation", () => {
    const result = validatePositionSize(CHATGPT_CONFIG, 100, { remaining: 50 });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("Exceeds budget"))).toBe(
      true
    );
  });

  it("should catch multiple violations", () => {
    const result = validatePositionSize(CHATGPT_CONFIG, 300, { remaining: 50 });
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThan(1);
  });
});
