/**
 * Shared test utilities for analysis test files.
 *
 * These utilities are used by:
 * - politician-analysis.test.ts
 * - simulation.test.ts
 * - scoring-retrospective.test.ts
 * - strategy-variations.test.ts
 */

import * as fs from 'fs'
import * as path from 'path'

// Re-export helpers from simulation.ts and filters.ts to avoid duplication
// Tests should use these instead of reimplementing
export { computePoliticianWinRates, generateMonths } from './simulation'

// Import daysBetween from filters.ts for local use, and re-export it
import { daysBetween } from './filters'
export { daysBetween }

// =============================================================================
// Data Loading
// =============================================================================

const DB_PATH = path.join(__dirname, '../../../trader-db-export.json')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedData: { signals: any[] } | null = null

/**
 * Load raw signals from the exported database file.
 * Results are cached to avoid repeated file reads across test files.
 *
 * @returns Array of signal objects (untyped - cast as needed in test files)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadSignalsFromExport(): any[] {
  if (!cachedData) {
    cachedData = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'))
  }
  return cachedData!.signals
}

/**
 * Load signals from a specific file (no caching).
 * Use this for loading different signal files like signals_45d.json.
 *
 * @param filename - Filename relative to repo root (e.g., "signals_45d.json")
 * @returns Array of signal objects
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadSignalsFromFile(filename: string): any[] {
  const filePath = path.join(__dirname, '../../../', filename)
  if (!fs.existsSync(filePath)) {
    throw new Error(`Signal file not found: ${filePath}`)
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  return data.signals
}

// daysBetween is re-exported from filters.ts above

/**
 * Annualize a return percentage based on hold period.
 */
export function annualizeReturn(returnPct: number, holdDays: number): number {
  if (holdDays <= 0) return 0
  const r = returnPct / 100
  const years = holdDays / 365
  if (years < 0.1) return returnPct
  const annualized = Math.pow(1 + r, 1 / years) - 1
  return annualized * 100
}

// =============================================================================
// Output Formatting
// =============================================================================

export function pad(str: string, len: number, right = false): string {
  if (right) return str.padEnd(len)
  return str.padStart(len)
}

export function formatPct(n: number): string {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(1)}%`
}

export function formatMoney(n: number): string {
  if (Math.abs(n) >= 1000000) return `$${(n / 1000000).toFixed(1)}M`
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

// =============================================================================
// Re-export shared types from types.ts
// =============================================================================

export type {
  RawSignal,
  TestPosition,
  TestClosedTrade,
  TestPoliticianStats,
  PoliticianFilter
} from './types'

import type {
  RawSignal,
  TestPosition,
  TestClosedTrade,
  TestPoliticianStats,
  PoliticianFilter
} from './types'

// =============================================================================
// Price Map Building
// =============================================================================

/**
 * Build a map of ticker -> latest price from signals.
 * Used for calculating unrealized gains on open positions.
 */
export function buildPriceMap(signals: RawSignal[]): Map<string, { price: number; date: string }> {
  const priceMap = new Map<string, { price: number; date: string }>()
  for (const signal of signals) {
    const ticker = signal.ticker
    const existing = priceMap.get(ticker)
    const price = signal.disclosure_price ?? signal.trade_price
    const date = signal.disclosure_date
    if (!existing || date > existing.date) {
      if (price > 0) {
        priceMap.set(ticker, { price, date })
      }
    }
  }
  return priceMap
}

// =============================================================================
// Politician Statistics
// =============================================================================

/**
 * Calculate performance statistics for a single politician.
 * Tracks both closed trades and open positions.
 */
export function calculatePoliticianStats(
  signals: RawSignal[],
  politicianName: string,
  priceMap: Map<string, { price: number; date: string }>
): TestPoliticianStats | null {
  const politicianSignals = signals.filter(s => s.politician_name === politicianName)
  if (politicianSignals.length === 0) return null

  const first = politicianSignals[0]

  // Group by ticker
  const tickerSignals = new Map<string, RawSignal[]>()
  for (const signal of politicianSignals) {
    if (!tickerSignals.has(signal.ticker)) {
      tickerSignals.set(signal.ticker, [])
    }
    tickerSignals.get(signal.ticker)!.push(signal)
  }

  const closedTrades: TestClosedTrade[] = []
  const openPositions: TestPosition[] = []

  for (const [ticker, tickerSigs] of tickerSignals) {
    const sorted = tickerSigs.sort((a, b) => a.trade_date.localeCompare(b.trade_date))
    const positionQueue: TestPosition[] = []

    for (const signal of sorted) {
      if (signal.action === 'buy') {
        const shares = signal.position_size_min / signal.trade_price
        positionQueue.push({
          ticker,
          shares,
          entryPrice: signal.trade_price,
          entryDate: signal.trade_date,
          cost: signal.position_size_min
        })
      } else if (signal.action === 'sell') {
        if (positionQueue.length > 0) {
          const position = positionQueue.shift()!
          const exitPrice = signal.trade_price
          const profit = (exitPrice - position.entryPrice) * position.shares
          const returnPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100
          const holdDays = daysBetween(position.entryDate, signal.trade_date)

          closedTrades.push({
            ticker,
            shares: position.shares,
            entryPrice: position.entryPrice,
            exitPrice,
            entryDate: position.entryDate,
            exitDate: signal.trade_date,
            returnPct,
            holdDays: Math.max(0, holdDays),
            profit
          })
        }
      }
    }

    for (const position of positionQueue) {
      const latestPrice = priceMap.get(position.ticker)
      if (latestPrice) {
        position.currentPrice = latestPrice.price
        position.currentValue = position.shares * latestPrice.price
        position.unrealizedPnL = position.currentValue - position.cost
      }
    }
    openPositions.push(...positionQueue)
  }

  if (closedTrades.length === 0 && openPositions.length === 0) {
    return null
  }

  const totalCostOfClosed = closedTrades.reduce((sum, t) => sum + t.shares * t.entryPrice, 0)
  const realizedPnL = closedTrades.reduce((sum, t) => sum + t.profit, 0)

  const openWithPrices = openPositions.filter(p => p.currentPrice !== undefined)
  const unrealizedCost = openWithPrices.reduce((sum, p) => sum + p.cost, 0)
  const unrealizedPnL = openWithPrices.reduce((sum, p) => sum + (p.unrealizedPnL ?? 0), 0)

  const totalCostWithPrices = totalCostOfClosed + unrealizedCost
  const totalPnL = realizedPnL + unrealizedPnL
  const totalReturnPct = totalCostWithPrices > 0 ? (totalPnL / totalCostWithPrices) * 100 : 0

  const avgHoldDays =
    closedTrades.length > 0
      ? closedTrades.reduce((sum, t) => sum + t.holdDays, 0) / closedTrades.length
      : 0

  const buySignals = politicianSignals.filter(s => s.action === 'buy')
  const annualizedReturnPct =
    avgHoldDays > 0 ? annualizeReturn(totalReturnPct, avgHoldDays) : totalReturnPct

  return {
    name: politicianName,
    party: first.politician_party,
    trades: buySignals.length,
    closedTrades: closedTrades.length,
    totalReturnPct,
    annualizedReturnPct,
    avgHoldDays
  }
}

// =============================================================================
// Politician Filters
// =============================================================================

/**
 * Build standard politician filters for strategy testing.
 * Returns filters for: Top 5, Ann>=50%, Top 10, Ann>=40%, Top 15
 */
export function buildPoliticianFilters(signals: RawSignal[]): PoliticianFilter[] {
  const priceMap = buildPriceMap(signals)
  const politicianNames = [...new Set(signals.map(s => s.politician_name))]

  // Calculate stats for all politicians
  const allStats: TestPoliticianStats[] = []
  for (const name of politicianNames) {
    const stats = calculatePoliticianStats(signals, name, priceMap)
    if (stats && (stats.closedTrades > 0 || stats.trades > 0)) {
      allStats.push(stats)
    }
  }

  // Get qualified politicians (min 15 trades) sorted by annualized return
  const MIN_TRADES = 15
  const qualified = [...allStats]
    .filter(p => p.trades >= MIN_TRADES)
    .sort((a, b) => b.annualizedReturnPct - a.annualizedReturnPct)

  // Calculate date range for signals/month
  const buySignals = signals.filter(s => s.action === 'buy' && s.trade_price > 0)
  const dates = buySignals.map(s => new Date(s.disclosure_date).getTime())
  const minDate = new Date(Math.min(...dates))
  const maxDate = new Date(Math.max(...dates))
  const totalMonths =
    (maxDate.getFullYear() - minDate.getFullYear()) * 12 +
    (maxDate.getMonth() - minDate.getMonth()) +
    1

  // Helper to count signals per month for a filter
  const calcSignalsPerMonth = (politicianSet: Set<string>): number => {
    const filteredSignals = buySignals.filter(s => politicianSet.has(s.politician_name))
    return filteredSignals.length / totalMonths
  }

  // Build the 5 filters
  const filters: PoliticianFilter[] = []

  // 1. Top 5 (min 15 trades)
  const top5 = new Set(qualified.slice(0, 5).map(p => p.name))
  filters.push({ name: 'Top 5', politicians: top5, signalsPerMonth: calcSignalsPerMonth(top5) })

  // 2. Ann% >= 50%
  const ann50 = new Set(allStats.filter(p => p.annualizedReturnPct >= 50).map(p => p.name))
  filters.push({
    name: 'Ann>=50%',
    politicians: ann50,
    signalsPerMonth: calcSignalsPerMonth(ann50)
  })

  // 3. Top 10 (min 15 trades)
  const top10 = new Set(qualified.slice(0, 10).map(p => p.name))
  filters.push({ name: 'Top 10', politicians: top10, signalsPerMonth: calcSignalsPerMonth(top10) })

  // 4. Ann% >= 40%
  const ann40 = new Set(allStats.filter(p => p.annualizedReturnPct >= 40).map(p => p.name))
  filters.push({
    name: 'Ann>=40%',
    politicians: ann40,
    signalsPerMonth: calcSignalsPerMonth(ann40)
  })

  // 5. Top 15 (min 15 trades)
  const top15 = new Set(qualified.slice(0, 15).map(p => p.name))
  filters.push({ name: 'Top 15', politicians: top15, signalsPerMonth: calcSignalsPerMonth(top15) })

  return filters
}
