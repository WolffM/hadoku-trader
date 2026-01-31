/**
 * Scoring Engine for Multi-Agent Trading System
 * Implements all 7 scoring components per FINAL_ENGINE_SPEC.md
 */

import type { TraderEnv } from '../types'
import type {
  ScoringConfig,
  TimeDecayConfig,
  PriceMovementConfig,
  PositionSizeConfig,
  PoliticianSkillConfig,
  SourceQualityConfig,
  FilingSpeedConfig,
  CrossConfirmationConfig,
  EnrichedSignal,
  ScoreResult
} from './types'
import { lerp, clamp } from './filters'
import { getPoliticianStats } from './loader'

// =============================================================================
// Shared Weighting Helper
// =============================================================================

interface ComponentScore {
  name: string
  score: number
  weight: number
}

/**
 * Calculate weighted average from component scores.
 * Shared logic used by both async and sync scoring functions.
 */
function calculateWeightedScore(components: ComponentScore[]): ScoreResult {
  const breakdown: Record<string, number> = {}
  let totalWeight = 0
  let weightedSum = 0

  for (const { name, score, weight } of components) {
    breakdown[name] = score
    weightedSum += score * weight
    totalWeight += weight
  }

  const finalScore = totalWeight > 0 ? weightedSum / totalWeight : 0

  return {
    score: clamp(finalScore, 0, 1),
    breakdown
  }
}

// =============================================================================
// Main Scoring Function
// =============================================================================

/**
 * Calculate the full score for a signal using all applicable components.
 * This is the main entry point that replaces the Phase 1 placeholder.
 */
export async function calculateScore(
  env: TraderEnv,
  config: ScoringConfig,
  signal: EnrichedSignal
): Promise<ScoreResult> {
  const components = config.components
  const scores: ComponentScore[] = []

  // 1. Time Decay
  if (components.time_decay) {
    scores.push({
      name: 'time_decay',
      score: scoreTimeDecay(components.time_decay, signal),
      weight: components.time_decay.weight
    })
  }

  // 2. Price Movement
  if (components.price_movement) {
    scores.push({
      name: 'price_movement',
      score: scorePriceMovement(components.price_movement, signal),
      weight: components.price_movement.weight
    })
  }

  // 3. Position Size
  if (components.position_size) {
    scores.push({
      name: 'position_size',
      score: scorePositionSize(components.position_size, signal),
      weight: components.position_size.weight
    })
  }

  // 4. Politician Skill (async - DB lookup)
  if (components.politician_skill) {
    scores.push({
      name: 'politician_skill',
      score: await scorePoliticianSkill(env, components.politician_skill, signal),
      weight: components.politician_skill.weight
    })
  }

  // 5. Source Quality (async - DB lookup for confirmations)
  if (components.source_quality) {
    scores.push({
      name: 'source_quality',
      score: await scoreSourceQuality(env, components.source_quality, signal),
      weight: components.source_quality.weight
    })
  }

  // 6. Filing Speed (Claude only)
  if (components.filing_speed) {
    scores.push({
      name: 'filing_speed',
      score: scoreFilingSpeed(components.filing_speed, signal),
      weight: components.filing_speed.weight
    })
  }

  // 7. Cross Confirmation (Claude only, async)
  if (components.cross_confirmation) {
    scores.push({
      name: 'cross_confirmation',
      score: await scoreCrossConfirmation(env, components.cross_confirmation, signal),
      weight: components.cross_confirmation.weight
    })
  }

  return calculateWeightedScore(scores)
}

/**
 * Sync version of calculateScore for simulation/backtesting.
 * Accepts pre-computed data instead of doing database lookups.
 */
export function calculateScoreSync(
  config: ScoringConfig,
  signal: EnrichedSignal,
  politicianWinRate?: number,
  confirmationCount?: number
): ScoreResult {
  const components = config.components
  const scores: ComponentScore[] = []

  // 1. Time Decay
  if (components.time_decay) {
    scores.push({
      name: 'time_decay',
      score: scoreTimeDecay(components.time_decay, signal),
      weight: components.time_decay.weight
    })
  }

  // 2. Price Movement
  if (components.price_movement) {
    scores.push({
      name: 'price_movement',
      score: scorePriceMovement(components.price_movement, signal),
      weight: components.price_movement.weight
    })
  }

  // 3. Position Size
  if (components.position_size) {
    scores.push({
      name: 'position_size',
      score: scorePositionSize(components.position_size, signal),
      weight: components.position_size.weight
    })
  }

  // 4. Politician Skill (uses pre-computed win rate)
  if (components.politician_skill) {
    scores.push({
      name: 'politician_skill',
      score:
        politicianWinRate !== undefined
          ? clamp(politicianWinRate, 0.4, 0.7)
          : components.politician_skill.default_score,
      weight: components.politician_skill.weight
    })
  }

  // 5. Source Quality (uses pre-computed confirmation count)
  if (components.source_quality) {
    let score =
      components.source_quality.scores[signal.source] ??
      components.source_quality.scores.default ??
      0.8
    if (confirmationCount && confirmationCount > 1) {
      const bonus = (confirmationCount - 1) * components.source_quality.confirmation_bonus
      score += Math.min(bonus, components.source_quality.max_confirmation_bonus)
    }
    scores.push({
      name: 'source_quality',
      score,
      weight: components.source_quality.weight
    })
  }

  // 6. Filing Speed
  if (components.filing_speed) {
    scores.push({
      name: 'filing_speed',
      score: scoreFilingSpeed(components.filing_speed, signal),
      weight: components.filing_speed.weight
    })
  }

  // 7. Cross Confirmation (uses pre-computed confirmation count)
  if (components.cross_confirmation) {
    const count = confirmationCount ?? 0
    let score = 0.5
    if (count >= 3) score = 1.0
    else if (count === 2) score = 0.75
    scores.push({
      name: 'cross_confirmation',
      score,
      weight: components.cross_confirmation.weight
    })
  }

  return calculateWeightedScore(scores)
}

// =============================================================================
// Component Scoring Functions
// =============================================================================

/**
 * Time Decay: Exponential decay based on days since trade.
 * Optionally uses filing date decay and takes minimum of both.
 */
export function scoreTimeDecay(config: TimeDecayConfig, signal: EnrichedSignal): number {
  // Primary decay based on trade date
  let decay = Math.pow(0.5, signal.days_since_trade / config.half_life_days)

  // Optional filing date decay (Claude uses this)
  if (config.use_filing_date && config.filing_half_life_days) {
    const filingDecay = Math.pow(0.5, signal.days_since_filing / config.filing_half_life_days)
    // Take the worse (lower) of the two decay values
    decay = Math.min(decay, filingDecay)
  }

  return decay
}

/**
 * Price Movement: 4-threshold interpolation with dip bonus for buys.
 */
export function scorePriceMovement(config: PriceMovementConfig, signal: EnrichedSignal): number {
  const thresholds = config.thresholds
  // price_change_pct is already in percentage form (5 = 5%)
  const pct = Math.abs(signal.price_change_pct)

  let score: number

  if (pct <= 0) {
    score = thresholds.pct_0
  } else if (pct <= 5) {
    score = lerp(thresholds.pct_0, thresholds.pct_5, pct / 5)
  } else if (pct <= 15) {
    score = lerp(thresholds.pct_5, thresholds.pct_15, (pct - 5) / 10)
  } else if (pct <= 25) {
    score = lerp(thresholds.pct_15, thresholds.pct_25, (pct - 15) / 10)
  } else {
    score = 0 // Beyond 25% movement
  }

  // Dip bonus: If this is a buy signal and price has dropped, apply 1.2x bonus
  if (signal.action === 'buy' && signal.price_change_pct < 0) {
    score = Math.min(score * 1.2, 1.2)
  }

  return score
}

/**
 * Position Size: Threshold-based mapping of disclosed position size.
 */
export function scorePositionSize(config: PositionSizeConfig, signal: EnrichedSignal): number {
  const size = signal.position_size_min

  // Find the highest threshold that the position size exceeds
  let idx = 0
  for (let i = 0; i < config.thresholds.length; i++) {
    if (size >= config.thresholds[i]) {
      idx = i + 1
    }
  }

  // Return the corresponding score (scores array has one more element than thresholds)
  return config.scores[idx] ?? config.scores[config.scores.length - 1] ?? 0.5
}

/**
 * Politician Skill: Win rate lookup from politician_stats table.
 */
async function scorePoliticianSkill(
  env: TraderEnv,
  config: PoliticianSkillConfig,
  signal: EnrichedSignal
): Promise<number> {
  const stats = await getPoliticianStats(env, signal.politician_name)

  // If no stats or insufficient trades, return default
  if (!stats || stats.total_trades < config.min_trades_for_data) {
    return config.default_score
  }

  // Use win_rate if available, clamped to [0.4, 0.7] range
  const winRate = stats.win_rate ?? config.default_score
  return clamp(winRate, 0.4, 0.7)
}

/**
 * Source Quality: Source-based score plus confirmation bonus.
 */
async function scoreSourceQuality(
  env: TraderEnv,
  config: SourceQualityConfig,
  signal: EnrichedSignal
): Promise<number> {
  // Get base score for the source
  let score = config.scores[signal.source] ?? config.scores.default ?? 0.8

  // Get confirmation count (how many sources reported this same signal)
  const confirmations = await getSignalConfirmationCount(
    env,
    signal.ticker,
    signal.action,
    signal.trade_date
  )

  // Add confirmation bonus if multiple sources
  if (confirmations > 1) {
    const bonus = (confirmations - 1) * config.confirmation_bonus
    score += Math.min(bonus, config.max_confirmation_bonus)
  }

  return score
}

/**
 * Filing Speed: Fast bonus or slow penalty based on days since filing.
 * Used by Claude only.
 */
function scoreFilingSpeed(config: FilingSpeedConfig, signal: EnrichedSignal): number {
  // Fast filing: bonus for <= 7 days
  if (signal.days_since_filing <= 7) {
    return 1.0 + config.fast_bonus
  }

  // Slow filing: penalty for >= 30 days
  if (signal.days_since_filing >= 30) {
    return 1.0 + config.slow_penalty // slow_penalty is negative
  }

  // Normal filing speed
  return 1.0
}

/**
 * Cross Confirmation: Bonus per additional source confirming signal.
 * Used by Claude only.
 */
async function scoreCrossConfirmation(
  env: TraderEnv,
  config: CrossConfirmationConfig,
  signal: EnrichedSignal
): Promise<number> {
  const confirmations = await getSignalConfirmationCount(
    env,
    signal.ticker,
    signal.action,
    signal.trade_date
  )

  // Calculate bonus: (confirmations - 1) * bonus_per_source, capped at max_bonus
  if (confirmations > 1) {
    const bonus = (confirmations - 1) * config.bonus_per_source
    return 1.0 + Math.min(bonus, config.max_bonus)
  }

  return 1.0
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Count how many sources have reported the same signal.
 * A "same signal" is defined as: same ticker, same action, same trade date.
 */
export async function getSignalConfirmationCount(
  env: TraderEnv,
  ticker: string,
  action: string,
  tradeDate: string
): Promise<number> {
  const result = await env.TRADER_DB.prepare(
    `
    SELECT COUNT(DISTINCT source) as count
    FROM signals
    WHERE ticker = ?
      AND action = ?
      AND trade_date = ?
  `
  )
    .bind(ticker, action, tradeDate)
    .first()

  return (result?.count as number) ?? 1
}
