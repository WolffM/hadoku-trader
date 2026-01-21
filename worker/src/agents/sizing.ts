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
 * @param availableCapital - Optional: use this as the budget basis instead of monthly_budget.
 *                           For portfolio simulation with compounding returns, pass the total
 *                           available cash so position sizes scale with portfolio growth.
 * @returns Position size in dollars, or 0 if below minimum threshold
 */
export function calculatePositionSize(
  agent: AgentConfig,
  score: number | null,
  budget: { remaining: number },
  acceptedSignalsCount: number = 1,
  isHalfSize: boolean = false,
  congressionalPositionSize?: number,
  availableCapital?: number
): number {
  const sizing = agent.sizing;
  let size: number;

  // Use availableCapital for compounding, otherwise use fixed monthly_budget
  const budgetBasis = availableCapital ?? agent.monthly_budget;

  switch (sizing.mode) {
    case "score_squared":
      // ChatGPT: score² × base_multiplier × budget_basis
      // Example: 0.8² × 0.2 × 1000 = 0.64 × 200 = $128
      if (score === null) {
        throw new Error("score_squared mode requires a score");
      }
      size =
        Math.pow(score, 2) *
        (sizing.base_multiplier ?? 0.2) *
        budgetBasis;
      break;

    case "score_linear":
      // Claude: (base_amount × budget_ratio) × score
      // With compounding, base_amount scales with portfolio size
      // If availableCapital is 10x monthly_budget, positions are 10x larger
      if (score === null) {
        throw new Error("score_linear mode requires a score");
      }
      const budgetRatio = availableCapital
        ? availableCapital / agent.monthly_budget
        : 1;
      size = (sizing.base_amount ?? 200) * budgetRatio * score;
      break;

    case "equal_split":
      // Gemini: budget_basis / acceptedSignalsCount
      // Example: 1000 / 5 = $200
      size = budgetBasis / Math.max(acceptedSignalsCount, 1);
      break;

    case "smart_budget":
      // Bucket-based allocation using discrete math
      // Per-trade size based on congressional position size bucket
      size = calculateSmartBudgetSize(
        budgetBasis,
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
  // 1. Max position amount (absolute cap) - scales with budget ratio for compounding
  const maxAmount = availableCapital
    ? sizing.max_position_amount * (availableCapital / agent.monthly_budget)
    : sizing.max_position_amount;
  size = Math.min(size, maxAmount);

  // 2. Max position percentage (relative to budget basis)
  size = Math.min(size, budgetBasis * sizing.max_position_pct);

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
 * Monthly bucket statistics calculated from actual signal data.
 * These should be recalculated for each politician filter.
 */
export interface MonthlyBucketStats {
  small: { count: number; avgSize: number };
  medium: { count: number; avgSize: number };
  large: { count: number; avgSize: number };
  totalCount: number;
}

/**
 * Calculate per-trade size using dynamic bucket-based allocation.
 *
 * Algorithm:
 * 1. Calculate weighted exposure per bucket: avgSize × count × (count/total)
 * 2. Calculate budget ratio: bucket_exposure / total_exposure
 * 3. Allocate budget to each bucket: ratio × availableCash
 * 4. Per-trade size: bucket_budget / expected_count
 *
 * This ensures position sizes are calibrated to the ACTUAL signal distribution
 * for the filtered politician set, deploying capital efficiently.
 *
 * @param availableCash - Current available cash
 * @param bucketConfig - Bucket configuration with size thresholds
 * @param congressionalSize - Congressional disclosed position size
 * @param monthlyStats - Optional: actual monthly stats for dynamic sizing
 * @returns Per-trade amount in dollars
 */
export function calculateSmartBudgetSize(
  availableCash: number,
  bucketConfig: SmartBudgetConfig | undefined,
  congressionalSize: number,
  monthlyStats?: MonthlyBucketStats
): number {
  if (!bucketConfig) {
    // Fallback: 5% of available cash
    return availableCash * 0.05;
  }

  // Determine which bucket this signal falls into
  const bucket = getBucketForSize(bucketConfig, congressionalSize);

  // Use provided monthly stats or fall back to config defaults
  const stats = monthlyStats ?? {
    small: {
      count: bucketConfig.small.expected_monthly_count,
      avgSize: bucketConfig.small.avg_congressional_size,
    },
    medium: {
      count: bucketConfig.medium.expected_monthly_count,
      avgSize: bucketConfig.medium.avg_congressional_size,
    },
    large: {
      count: bucketConfig.large.expected_monthly_count,
      avgSize: bucketConfig.large.avg_congressional_size,
    },
    totalCount:
      bucketConfig.small.expected_monthly_count +
      bucketConfig.medium.expected_monthly_count +
      bucketConfig.large.expected_monthly_count,
  };

  // Calculate raw exposure per bucket: avgSize × count
  // This ensures larger congressional positions get larger trade sizes
  const smallExposure = stats.small.avgSize * stats.small.count;
  const mediumExposure = stats.medium.avgSize * stats.medium.count;
  const largeExposure = stats.large.avgSize * stats.large.count;
  const totalExposure = smallExposure + mediumExposure + largeExposure;

  if (totalExposure === 0) {
    return availableCash * 0.05;
  }

  // Calculate budget allocation for each bucket
  const smallBudget = (smallExposure / totalExposure) * availableCash;
  const mediumBudget = (mediumExposure / totalExposure) * availableCash;
  const largeBudget = (largeExposure / totalExposure) * availableCash;

  // Per-trade size = bucket_budget / expected_count
  switch (bucket) {
    case "small":
      return stats.small.count > 0 ? smallBudget / stats.small.count : 0;
    case "medium":
      return stats.medium.count > 0 ? mediumBudget / stats.medium.count : 0;
    case "large":
      return stats.large.count > 0 ? largeBudget / stats.large.count : 0;
  }
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
 * Signal data needed to calculate bucket stats.
 * Minimal interface - only needs position size and disclosure date.
 */
export interface SignalForBucketStats {
  position_size_min: number;
  disclosure_date: string;
}

/**
 * Calculate bucket stats from actual signal data for a given month.
 * This ensures position sizing is calibrated to the REAL signal distribution.
 *
 * @param signals - All buy signals for the filtered politician set
 * @param month - Month to calculate stats for (YYYY-MM format)
 * @param bucketConfig - Bucket thresholds from config
 * @returns MonthlyBucketStats with actual counts and avg sizes
 */
export function calculateMonthlyBucketStats(
  signals: SignalForBucketStats[],
  month: string,
  bucketConfig: SmartBudgetConfig
): MonthlyBucketStats {
  // Filter signals to this month (by disclosure_date - when we see them)
  const monthSignals = signals.filter(s => s.disclosure_date.startsWith(month));

  // Group by bucket
  const buckets = {
    small: { count: 0, totalSize: 0 },
    medium: { count: 0, totalSize: 0 },
    large: { count: 0, totalSize: 0 },
  };

  for (const signal of monthSignals) {
    const size = signal.position_size_min || 1000;
    const bucket = getBucketForSize(bucketConfig, size);
    buckets[bucket].count++;
    buckets[bucket].totalSize += size;
  }

  const totalCount = buckets.small.count + buckets.medium.count + buckets.large.count;

  return {
    small: {
      count: buckets.small.count || 1, // Avoid division by zero
      avgSize: buckets.small.count > 0
        ? buckets.small.totalSize / buckets.small.count
        : bucketConfig.small.avg_congressional_size,
    },
    medium: {
      count: buckets.medium.count || 1,
      avgSize: buckets.medium.count > 0
        ? buckets.medium.totalSize / buckets.medium.count
        : bucketConfig.medium.avg_congressional_size,
    },
    large: {
      count: buckets.large.count || 1,
      avgSize: buckets.large.count > 0
        ? buckets.large.totalSize / buckets.large.count
        : bucketConfig.large.avg_congressional_size,
    },
    totalCount: totalCount || 3, // Minimum to avoid division issues
  };
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
