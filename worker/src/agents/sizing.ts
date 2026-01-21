/**
 * Position Sizing Engine for Multi-Agent Trading System
 * Implements all 4 sizing modes per FINAL_ENGINE_SPEC.md
 */

import type { AgentConfig, SizingMode, SmartBudgetConfig, BucketStats } from "./types";
import { roundTo } from "./filters";

// =============================================================================
// Position Sizing
// =============================================================================

/**
 * Calculate the position size (dollar amount) for a trade.
 *
 * @param agent - Agent configuration with sizing rules
 * @param score - Signal score (required for score_squared and score_linear modes)
 * @param budget - Current budget with remaining amount
 * @param acceptedSignalsCount - Number of signals accepted this month (for equal_split mode)
 * @param isHalfSize - If true, halves the calculated size (for execute_half decisions)
 * @param congressionalPositionSize - Congressional disclosed position size (for smart_budget mode)
 * @returns Position size in dollars, or 0 if below minimum threshold
 */
export function calculatePositionSize(
  agent: AgentConfig,
  score: number | null,
  budget: { remaining: number },
  acceptedSignalsCount: number = 1,
  isHalfSize: boolean = false,
  congressionalPositionSize?: number
): number {
  const sizing = agent.sizing;
  let size: number;

  switch (sizing.mode) {
    case "score_squared":
      // ChatGPT: score² × base_multiplier × monthly_budget
      // Example: 0.8² × 0.2 × 1000 = 0.64 × 200 = $128
      if (score === null) {
        throw new Error("score_squared mode requires a score");
      }
      size =
        Math.pow(score, 2) *
        (sizing.base_multiplier ?? 0.2) *
        agent.monthly_budget;
      break;

    case "score_linear":
      // Claude: base_amount × score
      // Example: 200 × 0.8 = $160
      if (score === null) {
        throw new Error("score_linear mode requires a score");
      }
      size = (sizing.base_amount ?? 200) * score;
      break;

    case "equal_split":
      // Gemini: monthly_budget / acceptedSignalsCount
      // Example: 1000 / 5 = $200
      size = agent.monthly_budget / Math.max(acceptedSignalsCount, 1);
      break;

    case "smart_budget":
      // Bucket-based allocation using discrete math
      // Per-trade size based on congressional position size bucket
      size = calculateSmartBudgetSize(
        agent.monthly_budget,
        sizing.bucket_config,
        congressionalPositionSize ?? 0
      );
      break;

    default:
      throw new Error(`Unknown sizing mode: ${sizing.mode}`);
  }

  // Apply half-size multiplier for execute_half decisions
  if (isHalfSize) {
    size = size * 0.5;
  }

  // Apply constraints in order of priority
  // 1. Max position amount (absolute cap)
  size = Math.min(size, sizing.max_position_amount);

  // 2. Max position percentage (relative to monthly budget)
  size = Math.min(size, agent.monthly_budget * sizing.max_position_pct);

  // 3. Budget remaining (can't spend more than available)
  size = Math.min(size, budget.remaining);

  // Check minimum threshold - return 0 if below minimum
  if (size < sizing.min_position_amount) {
    return 0;
  }

  // Round to cents
  return roundTo(size, 2);
}

/**
 * Calculate shares from position size and price.
 * Rounds down to nearest whole share (or 0.001 for fractional).
 */
export function calculateShares(
  positionSize: number,
  pricePerShare: number,
  allowFractional: boolean = false
): number {
  if (pricePerShare <= 0) return 0;

  const rawShares = positionSize / pricePerShare;

  if (allowFractional) {
    // Round to 3 decimal places for fractional shares
    return roundTo(rawShares, 3);
  }

  // Round down to whole shares
  return Math.floor(rawShares);
}

/**
 * Validate that a position size meets agent constraints.
 * Returns validation result with any violations.
 */
export function validatePositionSize(
  agent: AgentConfig,
  positionSize: number,
  budget: { remaining: number }
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  const sizing = agent.sizing;

  if (positionSize < sizing.min_position_amount) {
    violations.push(
      `Below minimum: $${positionSize} < $${sizing.min_position_amount}`
    );
  }

  if (positionSize > sizing.max_position_amount) {
    violations.push(
      `Above maximum: $${positionSize} > $${sizing.max_position_amount}`
    );
  }

  const maxPctAmount = agent.monthly_budget * sizing.max_position_pct;
  if (positionSize > maxPctAmount) {
    violations.push(
      `Above max percentage: $${positionSize} > ${sizing.max_position_pct * 100}% of $${agent.monthly_budget}`
    );
  }

  if (positionSize > budget.remaining) {
    violations.push(
      `Exceeds budget: $${positionSize} > $${budget.remaining} remaining`
    );
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

// =============================================================================
// Smart Budget Sizing (Bucket-Based Allocation)
// =============================================================================

/**
 * Calculate per-trade size using bucket-based allocation.
 *
 * Discrete math approach:
 * 1. Total exposure per bucket = expected_count × avg_congressional_size
 * 2. Budget ratio = bucket_exposure / total_exposure
 * 3. Per-trade amount = (monthly_budget × ratio) / expected_count
 *
 * @param monthlyBudget - Total monthly budget
 * @param bucketConfig - Bucket configuration with historical stats
 * @param congressionalSize - Congressional disclosed position size
 * @returns Per-trade amount in dollars
 */
export function calculateSmartBudgetSize(
  monthlyBudget: number,
  bucketConfig: SmartBudgetConfig | undefined,
  congressionalSize: number
): number {
  if (!bucketConfig) {
    // Fallback: if no bucket config, use a simple percentage of budget
    return monthlyBudget * 0.05;
  }

  // Determine which bucket this signal falls into
  const bucket = getBucketForSize(bucketConfig, congressionalSize);

  // Calculate total exposure for each bucket
  const smallExposure =
    bucketConfig.small.expected_monthly_count *
    bucketConfig.small.avg_congressional_size;
  const mediumExposure =
    bucketConfig.medium.expected_monthly_count *
    bucketConfig.medium.avg_congressional_size;
  const largeExposure =
    bucketConfig.large.expected_monthly_count *
    bucketConfig.large.avg_congressional_size;

  const totalExposure = smallExposure + mediumExposure + largeExposure;

  if (totalExposure === 0) {
    return monthlyBudget * 0.05;
  }

  // Calculate this bucket's exposure and ratio
  let bucketExposure: number;
  let bucketCount: number;

  switch (bucket) {
    case "small":
      bucketExposure = smallExposure;
      bucketCount = bucketConfig.small.expected_monthly_count;
      break;
    case "medium":
      bucketExposure = mediumExposure;
      bucketCount = bucketConfig.medium.expected_monthly_count;
      break;
    case "large":
      bucketExposure = largeExposure;
      bucketCount = bucketConfig.large.expected_monthly_count;
      break;
  }

  // Budget ratio for this bucket
  const ratio = bucketExposure / totalExposure;

  // Budget allocated to this bucket
  const bucketBudget = monthlyBudget * ratio;

  // Per-trade amount for this bucket
  const perTrade = bucketBudget / Math.max(bucketCount, 1);

  return perTrade;
}

/**
 * Determine which bucket a congressional position size falls into.
 */
export function getBucketForSize(
  config: SmartBudgetConfig,
  congressionalSize: number
): "small" | "medium" | "large" {
  if (
    congressionalSize >= config.large.min_position_size &&
    congressionalSize <= config.large.max_position_size
  ) {
    return "large";
  }

  if (
    congressionalSize >= config.medium.min_position_size &&
    congressionalSize <= config.medium.max_position_size
  ) {
    return "medium";
  }

  return "small";
}

/**
 * Get per-trade amounts for all buckets (useful for debugging/logging).
 */
export function getSmartBudgetBreakdown(
  monthlyBudget: number,
  bucketConfig: SmartBudgetConfig
): {
  small: { budget: number; perTrade: number; expectedCount: number };
  medium: { budget: number; perTrade: number; expectedCount: number };
  large: { budget: number; perTrade: number; expectedCount: number };
  totalExposure: number;
} {
  const smallExposure =
    bucketConfig.small.expected_monthly_count *
    bucketConfig.small.avg_congressional_size;
  const mediumExposure =
    bucketConfig.medium.expected_monthly_count *
    bucketConfig.medium.avg_congressional_size;
  const largeExposure =
    bucketConfig.large.expected_monthly_count *
    bucketConfig.large.avg_congressional_size;

  const totalExposure = smallExposure + mediumExposure + largeExposure;

  const smallRatio = smallExposure / totalExposure;
  const mediumRatio = mediumExposure / totalExposure;
  const largeRatio = largeExposure / totalExposure;

  const smallBudget = monthlyBudget * smallRatio;
  const mediumBudget = monthlyBudget * mediumRatio;
  const largeBudget = monthlyBudget * largeRatio;

  return {
    small: {
      budget: roundTo(smallBudget, 2),
      perTrade: roundTo(
        smallBudget / Math.max(bucketConfig.small.expected_monthly_count, 1),
        2
      ),
      expectedCount: bucketConfig.small.expected_monthly_count,
    },
    medium: {
      budget: roundTo(mediumBudget, 2),
      perTrade: roundTo(
        mediumBudget / Math.max(bucketConfig.medium.expected_monthly_count, 1),
        2
      ),
      expectedCount: bucketConfig.medium.expected_monthly_count,
    },
    large: {
      budget: roundTo(largeBudget, 2),
      perTrade: roundTo(
        largeBudget / Math.max(bucketConfig.large.expected_monthly_count, 1),
        2
      ),
      expectedCount: bucketConfig.large.expected_monthly_count,
    },
    totalExposure,
  };
}
