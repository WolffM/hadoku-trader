/**
 * Portfolio Simulation Engine
 *
 * Simulates trading strategies using production engine logic.
 * Uses bucket-based position sizing based on historical signal distribution.
 */

import type { AgentConfig, SmartBudgetConfig } from './types'
import { calculateScoreSync } from './scoring'
import { enrichSignal, type RawSignalRow } from './filters'

// =============================================================================
// Types
// =============================================================================

export interface SimSignal extends RawSignalRow {
  disclosure_price: number | null
}

export interface SimPosition {
  ticker: string
  shares: number
  cost: number
  entryPrice: number
  entryDate: string
}

export interface ClosedTrade {
  ticker: string
  profit: number
  returnPct: number
  entryDate: string
  exitDate: string
}

export interface MonthlySnapshot {
  month: string
  buys: number
  sells: number
  skips: number
  cash: number
  positionCount: number
  deployed: number
  realizedPnL: number
  portfolioValue: number
  totalDeposits: number
  growthPct: number
}

export interface SimulationResult {
  startDate: string
  endDate: string
  months: number
  totalDeposits: number
  finalCash: number
  openPositions: SimPosition[]
  closedTrades: ClosedTrade[]
  realizedPnL: number
  monthlySnapshots: MonthlySnapshot[]
}

// =============================================================================
// Bucket-Based Sizing
// =============================================================================

interface BucketStats {
  count: number
  avgSize: number
  totalExposure: number
}

interface HistoricalBucketStats {
  small: BucketStats
  medium: BucketStats
  large: BucketStats
  totalMonths: number
  avgSignalsPerMonth: number
}

// Default bucket thresholds (congressional position size)
const DEFAULT_BUCKET_CONFIG: SmartBudgetConfig = {
  small: {
    min_position_size: 0,
    max_position_size: 15000,
    expected_monthly_count: 30,
    avg_congressional_size: 5000
  },
  medium: {
    min_position_size: 15001,
    max_position_size: 50000,
    expected_monthly_count: 15,
    avg_congressional_size: 30000
  },
  large: {
    min_position_size: 50001,
    max_position_size: Infinity,
    expected_monthly_count: 5,
    avg_congressional_size: 100000
  }
}

/**
 * Calculate historical bucket stats from all buy signals.
 * This tells us:
 * - How many signals per month in each bucket
 * - Average congressional position size per bucket
 * - Total exposure per bucket (for ratio calculation)
 */
function calculateHistoricalBucketStats(
  signals: SimSignal[],
  bucketConfig: SmartBudgetConfig = DEFAULT_BUCKET_CONFIG
): HistoricalBucketStats {
  // Only consider buy signals with valid prices
  const buySignals = signals.filter(
    s => s.action === 'buy' && s.disclosure_price && s.disclosure_price > 0
  )

  // Get date range
  const dates = buySignals.map(s => s.disclosure_date)
  if (dates.length === 0) {
    return {
      small: { count: 1, avgSize: 5000, totalExposure: 5000 },
      medium: { count: 1, avgSize: 30000, totalExposure: 30000 },
      large: { count: 1, avgSize: 100000, totalExposure: 100000 },
      totalMonths: 1,
      avgSignalsPerMonth: 1
    }
  }

  const minDate = new Date(Math.min(...dates.map(d => new Date(d).getTime())))
  const maxDate = new Date(Math.max(...dates.map(d => new Date(d).getTime())))
  const totalMonths = Math.max(
    1,
    (maxDate.getFullYear() - minDate.getFullYear()) * 12 +
      (maxDate.getMonth() - minDate.getMonth()) +
      1
  )

  // Categorize signals by bucket
  const buckets = {
    small: { count: 0, totalSize: 0 },
    medium: { count: 0, totalSize: 0 },
    large: { count: 0, totalSize: 0 }
  }

  for (const signal of buySignals) {
    const size = signal.position_size_min || 1000

    if (size >= bucketConfig.large.min_position_size) {
      buckets.large.count++
      buckets.large.totalSize += size
    } else if (size >= bucketConfig.medium.min_position_size) {
      buckets.medium.count++
      buckets.medium.totalSize += size
    } else {
      buckets.small.count++
      buckets.small.totalSize += size
    }
  }

  // Calculate per-month averages
  const smallMonthly = buckets.small.count / totalMonths
  const mediumMonthly = buckets.medium.count / totalMonths
  const largeMonthly = buckets.large.count / totalMonths

  const smallAvgSize =
    buckets.small.count > 0 ? buckets.small.totalSize / buckets.small.count : 5000
  const mediumAvgSize =
    buckets.medium.count > 0 ? buckets.medium.totalSize / buckets.medium.count : 30000
  const largeAvgSize =
    buckets.large.count > 0 ? buckets.large.totalSize / buckets.large.count : 100000

  // Calculate exposure: count × avgSize
  // This represents the total "weight" of each bucket for budget allocation
  const smallExposure = smallMonthly * smallAvgSize
  const mediumExposure = mediumMonthly * mediumAvgSize
  const largeExposure = largeMonthly * largeAvgSize

  return {
    small: { count: smallMonthly, avgSize: smallAvgSize, totalExposure: smallExposure },
    medium: { count: mediumMonthly, avgSize: mediumAvgSize, totalExposure: mediumExposure },
    large: { count: largeMonthly, avgSize: largeAvgSize, totalExposure: largeExposure },
    totalMonths,
    avgSignalsPerMonth: buySignals.length / totalMonths
  }
}

/**
 * Calculate per-trade size for each bucket given a budget.
 *
 * Algorithm:
 * 1. Calculate total exposure: sum of all bucket exposures
 * 2. For each bucket: budget_ratio = bucket_exposure / total_exposure
 * 3. Bucket budget = budget × budget_ratio
 * 4. Per-trade size = bucket_budget / expected_monthly_count
 */
function calculateBucketSizes(
  availableBudget: number,
  stats: HistoricalBucketStats
): { small: number; medium: number; large: number } {
  const totalExposure =
    stats.small.totalExposure + stats.medium.totalExposure + stats.large.totalExposure

  if (totalExposure === 0) {
    // Fallback: equal split
    const perTrade = availableBudget / Math.max(stats.avgSignalsPerMonth, 1)
    return { small: perTrade, medium: perTrade, large: perTrade }
  }

  // Calculate budget allocation for each bucket
  const smallBudget = (stats.small.totalExposure / totalExposure) * availableBudget
  const mediumBudget = (stats.medium.totalExposure / totalExposure) * availableBudget
  const largeBudget = (stats.large.totalExposure / totalExposure) * availableBudget

  // Per-trade size = bucket_budget / expected_count
  const smallPerTrade = stats.small.count > 0 ? smallBudget / stats.small.count : 0
  const mediumPerTrade = stats.medium.count > 0 ? mediumBudget / stats.medium.count : 0
  const largePerTrade = stats.large.count > 0 ? largeBudget / stats.large.count : 0

  return {
    small: Math.max(smallPerTrade, 0),
    medium: Math.max(mediumPerTrade, 0),
    large: Math.max(largePerTrade, 0)
  }
}

/**
 * Determine which bucket a signal falls into based on congressional position size.
 */
function getBucket(
  congressionalSize: number,
  bucketConfig: SmartBudgetConfig = DEFAULT_BUCKET_CONFIG
): 'small' | 'medium' | 'large' {
  if (congressionalSize >= bucketConfig.large.min_position_size) {
    return 'large'
  }
  if (congressionalSize >= bucketConfig.medium.min_position_size) {
    return 'medium'
  }
  return 'small'
}

// =============================================================================
// Helpers
// =============================================================================

function computePoliticianWinRates(signals: SimSignal[]): Map<string, number> {
  const stats = new Map<string, { wins: number; total: number }>()

  for (const signal of signals) {
    if (signal.action !== 'buy' || !signal.disclosure_price || signal.disclosure_price <= 0)
      continue

    const existing = stats.get(signal.politician_name) || { wins: 0, total: 0 }
    existing.total++
    if (signal.disclosure_price > (signal.trade_price ?? 0)) {
      existing.wins++
    }
    stats.set(signal.politician_name, existing)
  }

  const winRates = new Map<string, number>()
  for (const [name, { wins, total }] of stats) {
    winRates.set(name, total > 0 ? wins / total : 0.5)
  }
  return winRates
}

function generateMonths(startDate: string, endDate: string): string[] {
  const months: string[] = []
  let current = new Date(startDate.substring(0, 7) + '-01')
  const end = new Date(endDate.substring(0, 7) + '-01')
  while (current <= end) {
    months.push(current.toISOString().substring(0, 7))
    current.setMonth(current.getMonth() + 1)
  }
  return months
}

// =============================================================================
// Simulation Engine
// =============================================================================

/**
 * Pre-filter signals through ALL filters (age, price move, scoring) to get
 * the subset that would actually execute. This is used to calculate accurate
 * historical bucket stats.
 */
export function preFilterSignals(
  signals: SimSignal[],
  config: AgentConfig,
  politicianWinRates: Map<string, number>
): SimSignal[] {
  return signals.filter(s => {
    if (s.action !== 'buy') return false
    if (!s.disclosure_price || s.disclosure_price <= 0) return false

    const signal = enrichSignal(s, s.disclosure_price, s.disclosure_date)

    // Apply hard filters
    if (signal.days_since_trade > config.max_signal_age_days) return false
    if (Math.abs(signal.price_change_pct) > config.max_price_move_pct) return false

    // Apply scoring filter
    if (config.scoring) {
      const winRate = politicianWinRates.get(signal.politician_name)
      const result = calculateScoreSync(config.scoring, signal, winRate)
      if (result.score < config.execute_threshold) return false
    }

    return true
  })
}

export function runSimulation(
  config: AgentConfig,
  signals: SimSignal[],
  politicianFilter?: Set<string>
): SimulationResult {
  // Filter signals with valid prices
  let validSignals = signals.filter(s => s.disclosure_price && s.disclosure_price > 0)

  // Apply politician filter if provided
  if (politicianFilter) {
    validSignals = validSignals.filter(s => politicianFilter.has(s.politician_name))
  }

  // Sort chronologically
  validSignals.sort((a, b) => a.disclosure_date.localeCompare(b.disclosure_date))

  if (validSignals.length === 0) {
    return {
      startDate: '',
      endDate: '',
      months: 0,
      totalDeposits: 0,
      finalCash: 0,
      openPositions: [],
      closedTrades: [],
      realizedPnL: 0,
      monthlySnapshots: []
    }
  }

  // Compute politician win rates from historical data (needed for scoring)
  const politicianWinRates = computePoliticianWinRates(signals)

  // Pre-filter signals through ALL filters to get the subset that would execute
  // This gives us accurate historical stats for position sizing
  const filteredBuySignals = preFilterSignals(validSignals, config, politicianWinRates)

  // Calculate historical bucket stats from the FILTERED signals (not raw signals)
  const bucketStats = calculateHistoricalBucketStats(
    filteredBuySignals.map(s => ({ ...s, action: 'buy' as const }))
  )

  // Get date range
  const startDate = validSignals[0].disclosure_date
  const endDate = validSignals[validSignals.length - 1].disclosure_date
  const months = generateMonths(startDate, endDate)

  // Simulation state
  let cash = 0
  let totalDeposits = 0
  let realizedPnL = 0
  const positions: SimPosition[] = []
  const closedTrades: ClosedTrade[] = []
  const monthlySnapshots: MonthlySnapshot[] = []

  for (const month of months) {
    // Deposit at start of month
    cash += config.monthly_budget
    totalDeposits += config.monthly_budget

    // Recalculate bucket sizes based on current cash
    const bucketSizes = calculateBucketSizes(cash, bucketStats)

    // Monthly counters
    let monthBuys = 0
    let monthSells = 0
    let monthSkips = 0

    // Get signals for this month
    const monthSignals = validSignals.filter(s => s.disclosure_date.startsWith(month))

    // Process signals in chronological order (no look-ahead)
    for (const simSignal of monthSignals) {
      const signal = enrichSignal(simSignal, simSignal.disclosure_price!, simSignal.disclosure_date)

      // SELL SIGNAL: Close position if we have one
      if (signal.action === 'sell') {
        const posIdx = positions.findIndex(p => p.ticker === signal.ticker)
        if (posIdx >= 0) {
          const pos = positions[posIdx]
          const proceeds = pos.shares * signal.current_price
          const profit = proceeds - pos.cost
          const returnPct = (profit / pos.cost) * 100

          cash += proceeds
          realizedPnL += profit
          closedTrades.push({
            ticker: signal.ticker,
            profit,
            returnPct,
            entryDate: pos.entryDate,
            exitDate: signal.disclosure_date
          })
          positions.splice(posIdx, 1)
          monthSells++
        }
        continue
      }

      // BUY SIGNAL: Apply filters
      if (signal.days_since_trade > config.max_signal_age_days) {
        monthSkips++
        continue
      }
      if (Math.abs(signal.price_change_pct) > config.max_price_move_pct) {
        monthSkips++
        continue
      }

      // Calculate score
      let score = 1.0
      if (config.scoring) {
        const winRate = politicianWinRates.get(signal.politician_name)
        const result = calculateScoreSync(config.scoring, signal, winRate)
        score = result.score
      }

      if (score < config.execute_threshold) {
        monthSkips++
        continue
      }

      // Determine bucket and get per-trade size from historical stats
      const congressionalSize = simSignal.position_size_min || 1000
      const bucket = getBucket(congressionalSize)
      let positionSize = bucketSizes[bucket]

      // Apply day-of-month ramp: positions get larger as month progresses
      // Day 1: 1.0x, Day 15: ~1.5x, Day 31: 2.0x
      // This naturally deploys more cash if early month was slow
      const dayOfMonth = parseInt(simSignal.disclosure_date.substring(8, 10), 10)
      const monthRampMultiplier = 1 + (dayOfMonth - 1) / 30
      positionSize = positionSize * monthRampMultiplier

      // Apply constraints
      positionSize = Math.min(positionSize, cash)
      positionSize = Math.min(positionSize, cash * (config.sizing.max_position_pct ?? 1.0))

      // Minimum $10 to avoid dust trades
      if (positionSize < 10) {
        monthSkips++
        continue
      }

      // Use floor to avoid rounding up beyond available cash
      positionSize = Math.floor(positionSize * 100) / 100

      if (positionSize > cash) {
        monthSkips++
        continue
      }

      cash -= positionSize
      positions.push({
        ticker: signal.ticker,
        shares: positionSize / signal.current_price,
        cost: positionSize,
        entryPrice: signal.current_price,
        entryDate: signal.disclosure_date
      })
      monthBuys++
    }

    // Record month-end state
    const deployed = positions.reduce((sum, p) => sum + p.cost, 0)
    const portfolioValue = cash + deployed
    const growthPct = ((portfolioValue - totalDeposits) / totalDeposits) * 100

    monthlySnapshots.push({
      month,
      buys: monthBuys,
      sells: monthSells,
      skips: monthSkips,
      cash,
      positionCount: positions.length,
      deployed,
      realizedPnL,
      portfolioValue,
      totalDeposits,
      growthPct
    })
  }

  return {
    startDate,
    endDate,
    months: months.length,
    totalDeposits,
    finalCash: cash,
    openPositions: positions,
    closedTrades,
    realizedPnL,
    monthlySnapshots
  }
}

// Export helpers for use in tests
export {
  calculateHistoricalBucketStats,
  calculateBucketSizes,
  getBucket,
  computePoliticianWinRates,
  generateMonths
}
export type { HistoricalBucketStats }
