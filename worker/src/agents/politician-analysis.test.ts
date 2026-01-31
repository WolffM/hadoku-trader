/**
 * Politician Performance Analysis
 * Calculates returns for individual politicians and collective strategies
 *
 * Run with: cd worker && pnpm test politician-analysis
 */

import { describe, it, expect } from 'vitest'
import {
  loadSignalsFromExport,
  daysBetween,
  annualizeReturn,
  pad,
  formatPct,
  formatMoney,
  buildPriceMap,
  type RawSignal,
  type TestPosition,
  type TestClosedTrade
} from './test-utils'

// =============================================================================
// Types (use shared types from test-utils)
// =============================================================================

// Use RawSignal from test-utils as Signal
type Signal = RawSignal

// Use TestPosition from test-utils, extended with unrealizedPct
interface Position extends TestPosition {
  unrealizedPct?: number
}

// Use TestClosedTrade from test-utils as ClosedTrade
type ClosedTrade = TestClosedTrade

interface PoliticianStats {
  name: string
  party: 'D' | 'R'
  chamber: 'house' | 'senate'
  trades: number
  closedTrades: number
  openPositions: number
  uniqueTickers: number
  totalInvested: number
  avgPositionSize: number
  avgCongressionalSize: number
  // Realized (closed trades)
  realizedPnL: number
  realizedReturnPct: number
  // Unrealized (open positions)
  unrealizedPnL: number
  unrealizedCost: number
  // Combined
  totalPnL: number
  totalReturnPct: number
  annualizedReturnPct: number
  avgHoldDays: number
  winRate: number
}

interface StrategyStats {
  name: string
  politicians: number
  trades: number
  closedTrades: number
  openPositions: number
  uniqueTickers: number
  totalInvested: number
  avgPositionSize: number
  avgCongressionalSize: number
  // Realized
  realizedPnL: number
  // Unrealized
  unrealizedPnL: number
  unrealizedCost: number
  // Combined
  totalPnL: number
  totalReturnPct: number
  annualizedReturnPct: number
  avgHoldDays: number
  winRate: number
}

interface SPYBenchmark {
  startDate: string
  endDate: string
  startPrice: number
  endPrice: number
  returnPct: number
  holdDays: number
}

// =============================================================================
// Load Data
// =============================================================================

function loadSignals(): Signal[] {
  return loadSignalsFromExport().filter(
    (s: Signal) =>
      s.ticker &&
      s.trade_date &&
      s.trade_price > 0 &&
      s.action &&
      s.politician_name &&
      s.politician_party &&
      s.politician_chamber
  )
}

// buildPriceMap imported from test-utils.ts

/**
 * Calculate SPY benchmark return over the period of congressional trading.
 * Uses SPY signals if available, otherwise uses hardcoded historical prices.
 */
function calculateSPYBenchmark(signals: Signal[]): SPYBenchmark {
  // Try to find SPY prices from signals
  const spySignals = signals.filter(s => s.ticker === 'SPY' && s.trade_price > 0)
  const spySorted = spySignals.sort((a, b) => a.trade_date.localeCompare(b.trade_date))

  let startDate: string
  let endDate: string
  let startPrice: number
  let endPrice: number

  if (spySorted.length >= 2) {
    // Use actual SPY signals - use their dates for accurate comparison
    startDate = spySorted[0].trade_date
    endDate = spySorted[spySorted.length - 1].trade_date
    startPrice = spySorted[0].trade_price
    endPrice = spySorted[spySorted.length - 1].trade_price
  } else {
    // Fallback: use overall data range with hardcoded SPY prices
    const tradeDates = signals
      .filter(s => s.trade_date && s.trade_price > 0)
      .map(s => s.trade_date)
      .sort()

    startDate = tradeDates[0]
    endDate = tradeDates[tradeDates.length - 1]

    // Hardcoded SPY prices for common date ranges (approximate)
    // 2021-01-01: ~$374, 2022-01-01: ~$474, 2023-01-01: ~$384, 2024-01-01: ~$473, 2025-01-01: ~$585
    const spyPrices: Record<string, number> = {
      '2021': 374,
      '2022': 474,
      '2023': 384,
      '2024': 473,
      '2025': 585,
      '2026': 600 // Approximate
    }
    const startYear = startDate.substring(0, 4)
    const endYear = endDate.substring(0, 4)
    startPrice = spyPrices[startYear] ?? 400
    endPrice = spyPrices[endYear] ?? 585
  }

  const returnPct = ((endPrice - startPrice) / startPrice) * 100
  const holdDays = daysBetween(startDate, endDate)

  return {
    startDate,
    endDate,
    startPrice,
    endPrice,
    returnPct,
    holdDays
  }
}

// =============================================================================
// Calculate Politician Returns
// =============================================================================

function calculatePoliticianStats(
  signals: Signal[],
  politicianName: string,
  priceMap: Map<string, { price: number; date: string }>
): PoliticianStats | null {
  const politicianSignals = signals.filter(s => s.politician_name === politicianName)
  if (politicianSignals.length === 0) return null

  const first = politicianSignals[0]

  // Group by ticker
  const tickerSignals = new Map<string, Signal[]>()
  for (const signal of politicianSignals) {
    if (!tickerSignals.has(signal.ticker)) {
      tickerSignals.set(signal.ticker, [])
    }
    tickerSignals.get(signal.ticker)!.push(signal)
  }

  const closedTrades: ClosedTrade[] = []
  const openPositions: Position[] = []
  let totalInvested = 0

  // Process each ticker
  for (const [ticker, tickerSigs] of tickerSignals) {
    // Sort by trade_date
    const sorted = tickerSigs.sort((a, b) => a.trade_date.localeCompare(b.trade_date))

    // Queue of open positions (FIFO)
    const positionQueue: Position[] = []

    for (const signal of sorted) {
      if (signal.action === 'buy') {
        // Estimate shares from position size
        const shares = signal.position_size_min / signal.trade_price
        const position: Position = {
          ticker,
          shares,
          entryPrice: signal.trade_price,
          entryDate: signal.trade_date,
          cost: signal.position_size_min
        }
        positionQueue.push(position)
        totalInvested += signal.position_size_min
      } else if (signal.action === 'sell') {
        // Try to match with open position (FIFO)
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
        // Ignore sells without matching buy (can't short)
      }
    }

    // Calculate unrealized P&L for remaining open positions
    for (const position of positionQueue) {
      const latestPrice = priceMap.get(position.ticker)
      if (latestPrice) {
        position.currentPrice = latestPrice.price
        position.currentValue = position.shares * latestPrice.price
        position.unrealizedPnL = position.currentValue - position.cost
        position.unrealizedPct =
          ((latestPrice.price - position.entryPrice) / position.entryPrice) * 100
      }
    }

    openPositions.push(...positionQueue)
  }

  if (closedTrades.length === 0 && openPositions.length === 0) {
    return null
  }

  // Realized P&L (closed trades only)
  const totalCostOfClosed = closedTrades.reduce((sum, t) => sum + t.shares * t.entryPrice, 0)
  const realizedPnL = closedTrades.reduce((sum, t) => sum + t.profit, 0)
  const realizedReturnPct = totalCostOfClosed > 0 ? (realizedPnL / totalCostOfClosed) * 100 : 0

  // Unrealized P&L (open positions with current prices)
  const openWithPrices = openPositions.filter(p => p.currentPrice !== undefined)
  const unrealizedCost = openWithPrices.reduce((sum, p) => sum + p.cost, 0)
  const unrealizedPnL = openWithPrices.reduce((sum, p) => sum + (p.unrealizedPnL ?? 0), 0)

  // Combined (realized + unrealized)
  const totalCostWithPrices = totalCostOfClosed + unrealizedCost
  const totalPnL = realizedPnL + unrealizedPnL
  const totalReturnPct = totalCostWithPrices > 0 ? (totalPnL / totalCostWithPrices) * 100 : 0

  // Average hold days (closed trades only - we don't know hold time for open)
  const avgHoldDays =
    closedTrades.length > 0
      ? closedTrades.reduce((sum, t) => sum + t.holdDays, 0) / closedTrades.length
      : 0

  // Win rate (closed trades only)
  const wins = closedTrades.filter(t => t.returnPct > 0).length
  const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0

  // Calculate additional metrics
  const buySignals = politicianSignals.filter(s => s.action === 'buy')
  const uniqueTickers = new Set(buySignals.map(s => s.ticker)).size
  const avgPositionSize = buySignals.length > 0 ? totalInvested / buySignals.length : 0
  const totalCongressionalSize = buySignals.reduce((sum, s) => sum + s.position_size_min, 0)
  const avgCongressionalSize =
    buySignals.length > 0 ? totalCongressionalSize / buySignals.length : 0

  // Annualized return (use avg hold days for the calculation)
  const annualizedReturnPct =
    avgHoldDays > 0 ? annualizeReturn(totalReturnPct, avgHoldDays) : totalReturnPct

  return {
    name: politicianName,
    party: first.politician_party,
    chamber: first.politician_chamber,
    trades: buySignals.length,
    closedTrades: closedTrades.length,
    openPositions: openPositions.length,
    uniqueTickers,
    totalInvested,
    avgPositionSize,
    avgCongressionalSize,
    realizedPnL,
    realizedReturnPct,
    unrealizedPnL,
    unrealizedCost,
    totalPnL,
    totalReturnPct,
    annualizedReturnPct,
    avgHoldDays,
    winRate
  }
}

// =============================================================================
// Calculate Strategy Stats
// =============================================================================

function calculateStrategyStats(
  politicianStats: PoliticianStats[],
  filter: (p: PoliticianStats) => boolean,
  name: string
): StrategyStats {
  const filtered = politicianStats.filter(filter)

  const totalInvested = filtered.reduce((sum, p) => sum + p.totalInvested, 0)
  const totalClosed = filtered.reduce((sum, p) => sum + p.closedTrades, 0)
  const totalOpen = filtered.reduce((sum, p) => sum + p.openPositions, 0)
  const totalTrades = filtered.reduce((sum, p) => sum + p.trades, 0)

  // Realized and unrealized P&L
  const realizedPnL = filtered.reduce((sum, p) => sum + p.realizedPnL, 0)
  const unrealizedPnL = filtered.reduce((sum, p) => sum + p.unrealizedPnL, 0)
  const unrealizedCost = filtered.reduce((sum, p) => sum + p.unrealizedCost, 0)

  // Total P&L and return
  const totalPnL = realizedPnL + unrealizedPnL
  const totalCostWithPrices = filtered.reduce((sum, p) => {
    const closedCost = p.realizedReturnPct !== 0 ? (p.realizedPnL / p.realizedReturnPct) * 100 : 0
    return sum + closedCost + p.unrealizedCost
  }, 0)
  // Simpler approach: use actual realized and unrealized costs
  const actualTotalCost = filtered.reduce((sum, p) => {
    // Cost basis for closed trades
    const closedCost =
      p.closedTrades > 0 && p.realizedReturnPct !== 0
        ? (p.realizedPnL * 100) / p.realizedReturnPct
        : 0
    return sum + closedCost + p.unrealizedCost
  }, 0)
  const totalReturnPct = actualTotalCost > 0 ? (totalPnL / actualTotalCost) * 100 : 0

  // Weighted average hold days
  const totalHoldDaysWeighted = filtered.reduce((sum, p) => sum + p.avgHoldDays * p.closedTrades, 0)
  const avgHoldDays = totalClosed > 0 ? totalHoldDaysWeighted / totalClosed : 0

  // Weighted win rate
  const totalWins = filtered.reduce(
    (sum, p) => sum + Math.round((p.winRate / 100) * p.closedTrades),
    0
  )
  const winRate = totalClosed > 0 ? (totalWins / totalClosed) * 100 : 0

  // Additional metrics
  const uniqueTickers = filtered.reduce((sum, p) => sum + p.uniqueTickers, 0)
  const avgPositionSize = totalTrades > 0 ? totalInvested / totalTrades : 0
  const totalCongressionalSize = filtered.reduce(
    (sum, p) => sum + p.avgCongressionalSize * p.trades,
    0
  )
  const avgCongressionalSize = totalTrades > 0 ? totalCongressionalSize / totalTrades : 0

  // Annualized return
  const annualizedReturnPct =
    avgHoldDays > 0 ? annualizeReturn(totalReturnPct, avgHoldDays) : totalReturnPct

  return {
    name,
    politicians: filtered.length,
    trades: totalTrades,
    closedTrades: totalClosed,
    openPositions: totalOpen,
    uniqueTickers,
    totalInvested,
    avgPositionSize,
    avgCongressionalSize,
    realizedPnL,
    unrealizedPnL,
    unrealizedCost,
    totalPnL,
    totalReturnPct,
    annualizedReturnPct,
    avgHoldDays,
    winRate
  }
}

// =============================================================================
// Table Formatting - imported from test-utils.ts

// =============================================================================
// Tests
// =============================================================================

describe('Politician Performance Analysis', () => {
  it('should calculate politician and strategy returns (realized + unrealized)', () => {
    const signals = loadSignals()
    console.log(`\nLoaded ${signals.length} signals`)

    // Build price map for unrealized gains
    const priceMap = buildPriceMap(signals)
    console.log(`Price data for ${priceMap.size} tickers`)

    // Get unique politicians
    const politicianNames = [...new Set(signals.map(s => s.politician_name))]
    console.log(`Found ${politicianNames.length} unique politicians\n`)

    // Calculate stats for each politician (include those with open positions)
    const politicianStats: PoliticianStats[] = []
    for (const name of politicianNames) {
      const stats = calculatePoliticianStats(signals, name, priceMap)
      if (stats && (stats.closedTrades > 0 || stats.openPositions > 0)) {
        politicianStats.push(stats)
      }
    }

    console.log(`Politicians with positions: ${politicianStats.length}`)
    const withClosed = politicianStats.filter(p => p.closedTrades > 0).length
    const withOpen = politicianStats.filter(p => p.openPositions > 0).length
    console.log(`  - With closed trades: ${withClosed}`)
    console.log(`  - With open positions: ${withOpen}\n`)

    // Sort by TOTAL P&L (realized + unrealized) - absolute dollars
    const sortedByPnL = [...politicianStats].sort((a, b) => b.totalPnL - a.totalPnL)
    const top10 = sortedByPnL.slice(0, 10)

    // Calculate collective strategies
    const strategies: StrategyStats[] = [
      calculateStrategyStats(politicianStats, () => true, 'All Politicians'),
      calculateStrategyStats(politicianStats, p => p.party === 'D', 'All Democrats'),
      calculateStrategyStats(politicianStats, p => p.party === 'R', 'All Republicans'),
      calculateStrategyStats(politicianStats, p => p.chamber === 'house', 'All House'),
      calculateStrategyStats(politicianStats, p => p.chamber === 'senate', 'All Senate'),
      calculateStrategyStats(
        politicianStats,
        p => p.party === 'D' && p.chamber === 'house',
        'D House'
      ),
      calculateStrategyStats(
        politicianStats,
        p => p.party === 'D' && p.chamber === 'senate',
        'D Senate'
      ),
      calculateStrategyStats(
        politicianStats,
        p => p.party === 'R' && p.chamber === 'house',
        'R House'
      ),
      calculateStrategyStats(
        politicianStats,
        p => p.party === 'R' && p.chamber === 'senate',
        'R Senate'
      )
    ]

    // Calculate SPY benchmark
    const spyBenchmark = calculateSPYBenchmark(signals)

    // =========================================================================
    // MAIN OUTPUT: 18-Row Strategy Summary Table (Top 10 Winners + 8 Collectives)
    // =========================================================================

    // Helper for avg hold display (only show for closed trades)
    const formatHold = (days: number, closed: number) => (closed > 0 ? `${days.toFixed(0)}d` : '-')

    console.log('\n' + '═'.repeat(140))
    console.log(
      'STRATEGY SUMMARY: TOP 10 INDIVIDUAL WINNERS + 8 COLLECTIVE STRATEGIES (sorted by Total P&L)'
    )
    console.log('═'.repeat(140))

    // Header row
    const header = [
      pad('#', 3),
      pad('Type', 5, true),
      pad('Strategy/Politician', 24, true),
      pad('Party', 5, true),
      pad('Trades', 6),
      pad('Closed', 6),
      pad('Open', 5),
      pad('Tickers', 7),
      pad('AvgHold', 7),
      pad('TotalP&L', 10),
      pad('Return', 9),
      pad('Ann%', 8),
      pad('Win%', 5)
    ].join(' | ')
    console.log(header)
    console.log('-'.repeat(140))

    // Top 10 individual politicians
    for (let i = 0; i < top10.length; i++) {
      const p = top10[i]
      const row = [
        pad(String(i + 1), 3),
        pad('Indiv', 5, true),
        pad(p.name.slice(0, 24), 24, true),
        pad(p.party, 5, true),
        pad(String(p.trades), 6),
        pad(String(p.closedTrades), 6),
        pad(String(p.openPositions), 5),
        pad(String(p.uniqueTickers), 7),
        pad(formatHold(p.avgHoldDays, p.closedTrades), 7),
        pad(formatMoney(p.totalPnL), 10),
        pad(formatPct(p.totalReturnPct), 9),
        pad(formatPct(p.annualizedReturnPct), 8),
        pad(`${p.winRate.toFixed(0)}%`, 5)
      ].join(' | ')
      console.log(row)
    }

    console.log('-'.repeat(140))

    // 8 collective strategies (skip "All Politicians" as it's redundant)
    const collectiveStrategies = strategies.slice(1) // Skip "All Politicians"
    for (let i = 0; i < collectiveStrategies.length; i++) {
      const s = collectiveStrategies[i]
      const row = [
        pad(String(11 + i), 3),
        pad('Coll', 5, true),
        pad(s.name.slice(0, 24), 24, true),
        pad('-', 5, true),
        pad(String(s.trades), 6),
        pad(String(s.closedTrades), 6),
        pad(String(s.openPositions), 5),
        pad(String(s.uniqueTickers), 7),
        pad(formatHold(s.avgHoldDays, s.closedTrades), 7),
        pad(formatMoney(s.totalPnL), 10),
        pad(formatPct(s.totalReturnPct), 9),
        pad(formatPct(s.annualizedReturnPct), 8),
        pad(`${s.winRate.toFixed(0)}%`, 5)
      ].join(' | ')
      console.log(row)
    }

    console.log('-'.repeat(140))

    // SPY Benchmark row
    const spyAnnualized = annualizeReturn(spyBenchmark.returnPct, spyBenchmark.holdDays)
    const spyRow = [
      pad('19', 3),
      pad('Bench', 5, true),
      pad('SPY (Buy & Hold)', 24, true),
      pad('-', 5, true),
      pad('1', 6),
      pad('-', 6),
      pad('1', 5),
      pad('1', 7),
      pad(`${spyBenchmark.holdDays}d`, 7),
      pad('-', 10),
      pad(formatPct(spyBenchmark.returnPct), 9),
      pad(formatPct(spyAnnualized), 8),
      pad('-', 5)
    ].join(' | ')
    console.log(spyRow)

    console.log('═'.repeat(140))

    // Show SPY details
    console.log(
      `\nSPY BENCHMARK: $${spyBenchmark.startPrice.toFixed(2)} → $${spyBenchmark.endPrice.toFixed(2)} (${spyBenchmark.startDate} to ${spyBenchmark.endDate})`
    )

    // =========================================================================
    // Column Legend
    // =========================================================================
    console.log('\nCOLUMN LEGEND:')
    console.log('  Type     = Indiv (individual politician) or Coll (collective strategy)')
    console.log('  Trades   = Total buy signals processed')
    console.log('  Closed   = Positions that have been sold (matched buy→sell)')
    console.log('  Open     = Positions still held (no matching sell)')
    console.log('  Tickers  = Unique stocks traded')
    console.log('  AvgHold  = Average hold time for closed positions')
    console.log('  TotalP&L = Realized + Unrealized P&L')
    console.log('  Return   = Raw return % = TotalP&L / Cost basis')
    console.log('  Ann%     = Annualized return = (1 + return)^(365/holdDays) - 1')
    console.log('  Win%     = % of closed trades with positive return')

    // =========================================================================
    // Key Insights
    // =========================================================================
    console.log('\n' + '═'.repeat(80))
    console.log('KEY INSIGHTS')
    console.log('═'.repeat(80))

    // Party comparison (annualized)
    const dems = strategies.find(s => s.name === 'All Democrats')!
    const reps = strategies.find(s => s.name === 'All Republicans')!
    console.log(
      `\nParty (Annualized): Democrats ${formatPct(dems.annualizedReturnPct)} vs Republicans ${formatPct(reps.annualizedReturnPct)}`
    )
    console.log(
      `  Winner: ${dems.annualizedReturnPct > reps.annualizedReturnPct ? 'Democrats' : 'Republicans'} by ${Math.abs(dems.annualizedReturnPct - reps.annualizedReturnPct).toFixed(1)}pp`
    )

    // Chamber comparison (annualized)
    const house = strategies.find(s => s.name === 'All House')!
    const senate = strategies.find(s => s.name === 'All Senate')!
    console.log(
      `\nChamber (Annualized): House ${formatPct(house.annualizedReturnPct)} vs Senate ${formatPct(senate.annualizedReturnPct)}`
    )
    console.log(
      `  Winner: ${house.annualizedReturnPct > senate.annualizedReturnPct ? 'House' : 'Senate'} by ${Math.abs(house.annualizedReturnPct - senate.annualizedReturnPct).toFixed(1)}pp`
    )

    // Top performer
    console.log(
      `\nTop Individual: ${top10[0].name} at ${formatPct(top10[0].annualizedReturnPct)} annualized`
    )
    console.log(
      `  ${top10[0].trades} trades, ${top10[0].uniqueTickers} tickers, ${formatMoney(top10[0].totalPnL)} total P&L`
    )

    // SPY comparison (annualized - fair comparison)
    const allPols = strategies.find(s => s.name === 'All Politicians')!
    const vsSPYAnn = allPols.annualizedReturnPct - spyAnnualized
    console.log(`\nSPY Benchmark (Annualized): ${formatPct(spyAnnualized)} per year`)
    console.log(
      `  Congress ${vsSPYAnn >= 0 ? 'BEATS' : 'TRAILS'} SPY by ${Math.abs(vsSPYAnn).toFixed(1)}pp annualized`
    )

    // Count how many strategies beat SPY (annualized)
    const beatSPY = [dems, reps, house, senate].filter(
      s => s.annualizedReturnPct > spyAnnualized
    ).length
    console.log(`  ${beatSPY}/4 collective strategies beat SPY (annualized)`)

    // Assertions
    expect(politicianStats.length).toBeGreaterThan(0)
    expect(top10.length).toBeLessThanOrEqual(10)
  })

  // ===========================================================================
  // BUY-ONLY STRATEGY: What if we only bought and never sold?
  // ===========================================================================
  it('should calculate buy-only portfolio growth (hold forever)', () => {
    const signals = loadSignals()
    const priceMap = buildPriceMap(signals)

    console.log('\n' + '═'.repeat(120))
    console.log('BUY-ONLY STRATEGY: Portfolio Growth if We Only Bought (No Sells)')
    console.log('═'.repeat(120))

    // Only look at buy signals
    const buySignals = signals.filter(s => s.action === 'buy' && s.trade_price > 0)
    console.log(`\nTotal buy signals: ${buySignals.length}`)

    // Group by politician
    const politicianBuys = new Map<string, Signal[]>()
    for (const signal of buySignals) {
      if (!politicianBuys.has(signal.politician_name)) {
        politicianBuys.set(signal.politician_name, [])
      }
      politicianBuys.get(signal.politician_name)!.push(signal)
    }

    interface BuyOnlyStats {
      name: string
      party: 'D' | 'R'
      chamber: 'house' | 'senate'
      buys: number
      totalCost: number
      currentValue: number
      unrealizedPnL: number
      returnPct: number
      avgHoldDays: number
      annualizedReturnPct: number
      tickersWithPrice: number
      tickersWithoutPrice: number
    }

    const stats: BuyOnlyStats[] = []
    const today = new Date().toISOString().slice(0, 10)

    for (const [name, buys] of politicianBuys) {
      let totalCost = 0
      let currentValue = 0
      let holdDaysSum = 0
      let priceCount = 0
      let noPriceCount = 0

      for (const buy of buys) {
        const cost = buy.position_size_min
        totalCost += cost

        const latestPrice = priceMap.get(buy.ticker)
        if (latestPrice) {
          const shares = cost / buy.trade_price
          currentValue += shares * latestPrice.price
          holdDaysSum += daysBetween(buy.trade_date, latestPrice.date)
          priceCount++
        } else {
          // No current price - assume held at cost (conservative)
          currentValue += cost
          noPriceCount++
        }
      }

      const unrealizedPnL = currentValue - totalCost
      const returnPct = totalCost > 0 ? (unrealizedPnL / totalCost) * 100 : 0
      const avgHoldDays = priceCount > 0 ? holdDaysSum / priceCount : 0
      const annualizedReturnPct =
        avgHoldDays > 0 ? annualizeReturn(returnPct, avgHoldDays) : returnPct

      const first = buys[0]
      stats.push({
        name,
        party: first.politician_party,
        chamber: first.politician_chamber,
        buys: buys.length,
        totalCost,
        currentValue,
        unrealizedPnL,
        returnPct,
        avgHoldDays,
        annualizedReturnPct,
        tickersWithPrice: priceCount,
        tickersWithoutPrice: noPriceCount
      })
    }

    // Sort by return % (only politicians with >= 15 buys)
    const MIN_TRADES = 15
    const sorted = [...stats]
      .filter(s => s.buys >= MIN_TRADES)
      .sort((a, b) => b.returnPct - a.returnPct)

    // Calculate aggregate stats (uses all politicians)
    const totalCost = stats.reduce((sum, s) => sum + s.totalCost, 0)
    const totalValue = stats.reduce((sum, s) => sum + s.currentValue, 0)
    const totalPnL = totalValue - totalCost
    const totalReturnPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0

    // Calculate weighted average hold days
    const weightedHoldDays = stats.reduce((sum, s) => sum + s.avgHoldDays * s.tickersWithPrice, 0)
    const totalWithPrice = stats.reduce((sum, s) => sum + s.tickersWithPrice, 0)
    const avgHoldDays = totalWithPrice > 0 ? weightedHoldDays / totalWithPrice : 0
    const totalAnnualized =
      avgHoldDays > 0 ? annualizeReturn(totalReturnPct, avgHoldDays) : totalReturnPct

    console.log(`\nAGGREGATE (Buy-Only, All Politicians):`)
    console.log(`  Total Cost:     ${formatMoney(totalCost)}`)
    console.log(`  Current Value:  ${formatMoney(totalValue)}`)
    console.log(`  Unrealized P&L: ${formatMoney(totalPnL)}`)
    console.log(`  Return:         ${formatPct(totalReturnPct)}`)
    console.log(`  Avg Hold Days:  ${avgHoldDays.toFixed(0)}`)
    console.log(`  Annualized:     ${formatPct(totalAnnualized)}`)

    // Print top 15 by return (filtered to >= 15 buys)
    console.log('\n' + '-'.repeat(120))
    console.log(`TOP 15 BY RETURN % (Buy-Only, min ${MIN_TRADES} trades)`)
    console.log('-'.repeat(120))
    console.log(
      pad('#', 3) +
        ' | ' +
        pad('Politician', 24, true) +
        ' | ' +
        pad('Party', 5, true) +
        ' | ' +
        pad('Buys', 5) +
        ' | ' +
        pad('Cost', 10) +
        ' | ' +
        pad('Value', 10) +
        ' | ' +
        pad('P&L', 10) +
        ' | ' +
        pad('Return', 9) +
        ' | ' +
        pad('AvgHold', 7) +
        ' | ' +
        pad('Ann%', 8)
    )
    console.log('-'.repeat(120))

    for (let i = 0; i < Math.min(15, sorted.length); i++) {
      const s = sorted[i]
      console.log(
        pad(String(i + 1), 3) +
          ' | ' +
          pad(s.name.slice(0, 24), 24, true) +
          ' | ' +
          pad(s.party, 5, true) +
          ' | ' +
          pad(String(s.buys), 5) +
          ' | ' +
          pad(formatMoney(s.totalCost), 10) +
          ' | ' +
          pad(formatMoney(s.currentValue), 10) +
          ' | ' +
          pad(formatMoney(s.unrealizedPnL), 10) +
          ' | ' +
          pad(formatPct(s.returnPct), 9) +
          ' | ' +
          pad(s.avgHoldDays > 0 ? `${s.avgHoldDays.toFixed(0)}d` : '-', 7) +
          ' | ' +
          pad(formatPct(s.annualizedReturnPct), 8)
      )
    }

    // Collective strategies
    console.log('\n' + '-'.repeat(120))
    console.log('COLLECTIVE STRATEGIES (Buy-Only)')
    console.log('-'.repeat(120))

    const calcCollective = (filter: (s: BuyOnlyStats) => boolean, name: string) => {
      const filtered = stats.filter(filter)
      const cost = filtered.reduce((sum, s) => sum + s.totalCost, 0)
      const value = filtered.reduce((sum, s) => sum + s.currentValue, 0)
      const pnl = value - cost
      const ret = cost > 0 ? (pnl / cost) * 100 : 0
      const wHold = filtered.reduce((sum, s) => sum + s.avgHoldDays * s.tickersWithPrice, 0)
      const tWithPrice = filtered.reduce((sum, s) => sum + s.tickersWithPrice, 0)
      const avgHold = tWithPrice > 0 ? wHold / tWithPrice : 0
      const ann = avgHold > 0 ? annualizeReturn(ret, avgHold) : ret
      return { name, cost, value, pnl, ret, avgHold, ann, count: filtered.length }
    }

    const collectives = [
      calcCollective(() => true, 'All Politicians'),
      calcCollective(s => s.party === 'D', 'All Democrats'),
      calcCollective(s => s.party === 'R', 'All Republicans'),
      calcCollective(s => s.chamber === 'house', 'All House'),
      calcCollective(s => s.chamber === 'senate', 'All Senate')
    ]

    console.log(
      pad('Strategy', 20, true) +
        ' | ' +
        pad('Cost', 12) +
        ' | ' +
        pad('Value', 12) +
        ' | ' +
        pad('P&L', 12) +
        ' | ' +
        pad('Return', 9) +
        ' | ' +
        pad('Ann%', 8)
    )
    console.log('-'.repeat(90))

    for (const c of collectives) {
      console.log(
        pad(c.name, 20, true) +
          ' | ' +
          pad(formatMoney(c.cost), 12) +
          ' | ' +
          pad(formatMoney(c.value), 12) +
          ' | ' +
          pad(formatMoney(c.pnl), 12) +
          ' | ' +
          pad(formatPct(c.ret), 9) +
          ' | ' +
          pad(formatPct(c.ann), 8)
      )
    }

    // SPY comparison
    const spyBenchmark = calculateSPYBenchmark(signals)
    const spyAnnualized = annualizeReturn(spyBenchmark.returnPct, spyBenchmark.holdDays)
    console.log('-'.repeat(90))
    console.log(
      pad('SPY (Buy & Hold)', 20, true) +
        ' | ' +
        pad('-', 12) +
        ' | ' +
        pad('-', 12) +
        ' | ' +
        pad('-', 12) +
        ' | ' +
        pad(formatPct(spyBenchmark.returnPct), 9) +
        ' | ' +
        pad(formatPct(spyAnnualized), 8)
    )

    console.log('\n' + '═'.repeat(120))
    console.log('KEY INSIGHT: This shows what your portfolio would look like if you')
    console.log('simply copied every congressional BUY and held forever (no sells).')
    console.log('═'.repeat(120))

    expect(stats.length).toBeGreaterThan(0)
  })

  // ===========================================================================
  // BUY + SELL AFTER 1 YEAR: What if we sold exactly 1 year after buying?
  // ===========================================================================
  it('should calculate returns with automatic 1-year exit', () => {
    const signals = loadSignals()
    const priceMap = buildPriceMap(signals)

    console.log('\n' + '═'.repeat(140))
    console.log('1-YEAR EXIT STRATEGY: Buy When Congress Buys, Sell Exactly 1 Year Later')
    console.log('═'.repeat(140))

    // Build historical price map from all signals (for 1-year exit pricing)
    // Group prices by ticker and date
    const historicalPrices = new Map<string, Map<string, number>>()
    for (const signal of signals) {
      if (!historicalPrices.has(signal.ticker)) {
        historicalPrices.set(signal.ticker, new Map())
      }
      if (signal.trade_price > 0) {
        historicalPrices.get(signal.ticker)!.set(signal.trade_date, signal.trade_price)
      }
      if (signal.disclosure_price && signal.disclosure_price > 0) {
        historicalPrices.get(signal.ticker)!.set(signal.disclosure_date, signal.disclosure_price)
      }
    }

    // Function to get price on or near a date
    const getPriceNearDate = (ticker: string, targetDate: string): number | null => {
      const tickerPrices = historicalPrices.get(ticker)
      if (!tickerPrices) return null

      // Try exact date first
      if (tickerPrices.has(targetDate)) {
        return tickerPrices.get(targetDate)!
      }

      // Find closest date within 30 days
      const targetTime = new Date(targetDate).getTime()
      let closestDate: string | null = null
      let closestDiff = Infinity

      for (const [date] of tickerPrices) {
        const diff = Math.abs(new Date(date).getTime() - targetTime)
        if (diff < closestDiff && diff < 30 * 24 * 60 * 60 * 1000) {
          closestDiff = diff
          closestDate = date
        }
      }

      return closestDate ? tickerPrices.get(closestDate)! : null
    }

    // Only look at buy signals
    const buySignals = signals.filter(s => s.action === 'buy' && s.trade_price > 0)
    const today = new Date()
    const todayStr = today.toISOString().slice(0, 10)

    interface OneYearStats {
      name: string
      party: 'D' | 'R'
      chamber: 'house' | 'senate'
      totalBuys: number
      // Realized: positions > 1 year old (sold at 1-year mark)
      realizedCount: number
      realizedCost: number
      realizedValue: number
      realizedPnL: number
      realizedReturnPct: number
      // Unrealized: positions < 1 year old (still holding)
      unrealizedCount: number
      unrealizedCost: number
      unrealizedValue: number
      unrealizedPnL: number
      unrealizedReturnPct: number
      // Combined
      totalReturnPct: number
      annualizedReturnPct: number
    }

    // Group by politician
    const politicianBuys = new Map<string, Signal[]>()
    for (const signal of buySignals) {
      if (!politicianBuys.has(signal.politician_name)) {
        politicianBuys.set(signal.politician_name, [])
      }
      politicianBuys.get(signal.politician_name)!.push(signal)
    }

    const stats: OneYearStats[] = []

    for (const [name, buys] of politicianBuys) {
      let realizedCount = 0
      let realizedCost = 0
      let realizedValue = 0
      let unrealizedCount = 0
      let unrealizedCost = 0
      let unrealizedValue = 0

      for (const buy of buys) {
        const cost = buy.position_size_min
        const shares = cost / buy.trade_price
        const buyDate = new Date(buy.trade_date)
        const oneYearLater = new Date(buyDate)
        oneYearLater.setFullYear(oneYearLater.getFullYear() + 1)
        const oneYearLaterStr = oneYearLater.toISOString().slice(0, 10)

        const holdDays = daysBetween(buy.trade_date, todayStr)

        if (holdDays >= 365) {
          // Position is >= 1 year old: REALIZED (sold at 1-year mark)
          const exitPrice = getPriceNearDate(buy.ticker, oneYearLaterStr)
          if (exitPrice) {
            realizedCount++
            realizedCost += cost
            realizedValue += shares * exitPrice
          } else {
            // No price at 1-year mark, use current price as fallback
            const currentPrice = priceMap.get(buy.ticker)
            if (currentPrice) {
              realizedCount++
              realizedCost += cost
              realizedValue += shares * currentPrice.price
            }
          }
        } else {
          // Position is < 1 year old: UNREALIZED (still holding)
          const currentPrice = priceMap.get(buy.ticker)
          if (currentPrice) {
            unrealizedCount++
            unrealizedCost += cost
            unrealizedValue += shares * currentPrice.price
          }
        }
      }

      const realizedPnL = realizedValue - realizedCost
      const realizedReturnPct = realizedCost > 0 ? (realizedPnL / realizedCost) * 100 : 0
      const unrealizedPnL = unrealizedValue - unrealizedCost
      const unrealizedReturnPct = unrealizedCost > 0 ? (unrealizedPnL / unrealizedCost) * 100 : 0

      const totalCost = realizedCost + unrealizedCost
      const totalPnL = realizedPnL + unrealizedPnL
      const totalReturnPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0

      // For annualized: realized is exactly 365 days, unrealized we estimate avg hold
      // Weighted average
      const avgHoldDays =
        totalCost > 0
          ? (realizedCost * 365 + unrealizedCost * 182) / totalCost // Assume unrealized is ~6 months avg
          : 365
      const annualizedReturnPct = annualizeReturn(totalReturnPct, avgHoldDays)

      const first = buys[0]
      stats.push({
        name,
        party: first.politician_party,
        chamber: first.politician_chamber,
        totalBuys: buys.length,
        realizedCount,
        realizedCost,
        realizedValue,
        realizedPnL,
        realizedReturnPct,
        unrealizedCount,
        unrealizedCost,
        unrealizedValue,
        unrealizedPnL,
        unrealizedReturnPct,
        totalReturnPct,
        annualizedReturnPct
      })
    }

    // Sort by total return (only politicians with >= 15 buys)
    const MIN_TRADES = 15
    const sorted = [...stats]
      .filter(s => s.totalBuys >= MIN_TRADES)
      .sort((a, b) => b.totalReturnPct - a.totalReturnPct)

    // Calculate aggregate (uses all politicians)
    const totalRealizedCost = stats.reduce((sum, s) => sum + s.realizedCost, 0)
    const totalRealizedValue = stats.reduce((sum, s) => sum + s.realizedValue, 0)
    const totalRealizedPnL = totalRealizedValue - totalRealizedCost
    const totalRealizedReturnPct =
      totalRealizedCost > 0 ? (totalRealizedPnL / totalRealizedCost) * 100 : 0

    const totalUnrealizedCost = stats.reduce((sum, s) => sum + s.unrealizedCost, 0)
    const totalUnrealizedValue = stats.reduce((sum, s) => sum + s.unrealizedValue, 0)
    const totalUnrealizedPnL = totalUnrealizedValue - totalUnrealizedCost
    const totalUnrealizedReturnPct =
      totalUnrealizedCost > 0 ? (totalUnrealizedPnL / totalUnrealizedCost) * 100 : 0

    const totalCost = totalRealizedCost + totalUnrealizedCost
    const totalPnL = totalRealizedPnL + totalUnrealizedPnL
    const totalReturnPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0

    console.log(`\nAGGREGATE (1-Year Exit Strategy):`)
    console.log(`  REALIZED (held >= 1 year, sold at 1-year mark):`)
    console.log(`    Positions: ${stats.reduce((sum, s) => sum + s.realizedCount, 0)}`)
    console.log(`    Cost:      ${formatMoney(totalRealizedCost)}`)
    console.log(`    Value:     ${formatMoney(totalRealizedValue)}`)
    console.log(`    P&L:       ${formatMoney(totalRealizedPnL)}`)
    console.log(`    Return:    ${formatPct(totalRealizedReturnPct)}`)
    console.log(`  UNREALIZED (held < 1 year, still open):`)
    console.log(`    Positions: ${stats.reduce((sum, s) => sum + s.unrealizedCount, 0)}`)
    console.log(`    Cost:      ${formatMoney(totalUnrealizedCost)}`)
    console.log(`    Value:     ${formatMoney(totalUnrealizedValue)}`)
    console.log(`    P&L:       ${formatMoney(totalUnrealizedPnL)}`)
    console.log(`    Return:    ${formatPct(totalUnrealizedReturnPct)}`)
    console.log(`  COMBINED:`)
    console.log(`    Total P&L: ${formatMoney(totalPnL)}`)
    console.log(`    Return:    ${formatPct(totalReturnPct)}`)

    // Print top 15 (filtered to >= 15 buys)
    console.log('\n' + '-'.repeat(140))
    console.log(`TOP 15 BY TOTAL RETURN % (1-Year Exit, min ${MIN_TRADES} trades)`)
    console.log('-'.repeat(140))
    console.log(
      pad('#', 3) +
        ' | ' +
        pad('Politician', 22, true) +
        ' | ' +
        pad('Party', 5, true) +
        ' | ' +
        pad('Buys', 5) +
        ' | ' +
        pad('Real#', 5) +
        ' | ' +
        pad('RealRet', 8) +
        ' | ' +
        pad('Unrl#', 5) +
        ' | ' +
        pad('UnrlRet', 8) +
        ' | ' +
        pad('TotalRet', 9) +
        ' | ' +
        pad('TotalP&L', 10)
    )
    console.log('-'.repeat(140))

    for (let i = 0; i < Math.min(15, sorted.length); i++) {
      const s = sorted[i]
      console.log(
        pad(String(i + 1), 3) +
          ' | ' +
          pad(s.name.slice(0, 22), 22, true) +
          ' | ' +
          pad(s.party, 5, true) +
          ' | ' +
          pad(String(s.totalBuys), 5) +
          ' | ' +
          pad(String(s.realizedCount), 5) +
          ' | ' +
          pad(formatPct(s.realizedReturnPct), 8) +
          ' | ' +
          pad(String(s.unrealizedCount), 5) +
          ' | ' +
          pad(formatPct(s.unrealizedReturnPct), 8) +
          ' | ' +
          pad(formatPct(s.totalReturnPct), 9) +
          ' | ' +
          pad(formatMoney(s.realizedPnL + s.unrealizedPnL), 10)
      )
    }

    // Collective strategies
    console.log('\n' + '-'.repeat(140))
    console.log('COLLECTIVE STRATEGIES (1-Year Exit)')
    console.log('-'.repeat(140))

    const calcCollective = (filter: (s: OneYearStats) => boolean, name: string) => {
      const filtered = stats.filter(filter)
      const rCost = filtered.reduce((sum, s) => sum + s.realizedCost, 0)
      const rValue = filtered.reduce((sum, s) => sum + s.realizedValue, 0)
      const rPnL = rValue - rCost
      const rRet = rCost > 0 ? (rPnL / rCost) * 100 : 0
      const uCost = filtered.reduce((sum, s) => sum + s.unrealizedCost, 0)
      const uValue = filtered.reduce((sum, s) => sum + s.unrealizedValue, 0)
      const uPnL = uValue - uCost
      const uRet = uCost > 0 ? (uPnL / uCost) * 100 : 0
      const tCost = rCost + uCost
      const tPnL = rPnL + uPnL
      const tRet = tCost > 0 ? (tPnL / tCost) * 100 : 0
      return { name, rRet, uRet, tRet, tPnL }
    }

    const collectives = [
      calcCollective(() => true, 'All Politicians'),
      calcCollective(s => s.party === 'D', 'All Democrats'),
      calcCollective(s => s.party === 'R', 'All Republicans'),
      calcCollective(s => s.chamber === 'house', 'All House'),
      calcCollective(s => s.chamber === 'senate', 'All Senate')
    ]

    console.log(
      pad('Strategy', 20, true) +
        ' | ' +
        pad('Realized%', 10) +
        ' | ' +
        pad('Unrealzd%', 10) +
        ' | ' +
        pad('Total%', 10) +
        ' | ' +
        pad('Total P&L', 12)
    )
    console.log('-'.repeat(70))

    for (const c of collectives) {
      console.log(
        pad(c.name, 20, true) +
          ' | ' +
          pad(formatPct(c.rRet), 10) +
          ' | ' +
          pad(formatPct(c.uRet), 10) +
          ' | ' +
          pad(formatPct(c.tRet), 10) +
          ' | ' +
          pad(formatMoney(c.tPnL), 12)
      )
    }

    // SPY comparison
    const spyBenchmark = calculateSPYBenchmark(signals)
    console.log('-'.repeat(70))
    console.log(
      pad('SPY (1-Year Hold)', 20, true) +
        ' | ' +
        pad('-', 10) +
        ' | ' +
        pad('-', 10) +
        ' | ' +
        pad(formatPct(spyBenchmark.returnPct / (spyBenchmark.holdDays / 365)), 10) +
        ' | ' +
        pad('-', 12)
    )

    console.log('\n' + '═'.repeat(140))
    console.log('KEY INSIGHT: This simulates buying when congress buys and selling')
    console.log('exactly 1 year later. Realized = held >= 1yr (sold at 1yr mark).')
    console.log('Unrealized = held < 1yr (still in portfolio). Ann% for SPY is per-year.')
    console.log('═'.repeat(140))

    expect(stats.length).toBeGreaterThan(0)
  })

  // ===========================================================================
  // SIGNAL FILTER ANALYSIS: How many signals per month at different thresholds?
  // ===========================================================================
  it('should analyze signal volume at different filter thresholds', () => {
    const signals = loadSignals()
    const priceMap = buildPriceMap(signals)
    const politicianNames = [...new Set(signals.map(s => s.politician_name))]

    // Calculate stats for all politicians (same as original table)
    const politicianStats: PoliticianStats[] = []
    for (const name of politicianNames) {
      const stats = calculatePoliticianStats(signals, name, priceMap)
      if (stats && (stats.closedTrades > 0 || stats.openPositions > 0)) {
        politicianStats.push(stats)
      }
    }

    // Sort by annualized return (best first)
    const sortedByReturn = [...politicianStats].sort(
      (a, b) => b.annualizedReturnPct - a.annualizedReturnPct
    )

    // Calculate date range for monthly average
    const buySignals = signals.filter(s => s.action === 'buy' && s.trade_price > 0)
    const dates = buySignals.map(s => new Date(s.disclosure_date).getTime())
    const minDate = new Date(Math.min(...dates))
    const maxDate = new Date(Math.max(...dates))
    const totalMonths =
      (maxDate.getFullYear() - minDate.getFullYear()) * 12 +
      (maxDate.getMonth() - minDate.getMonth()) +
      1

    console.log('\n' + '═'.repeat(120))
    console.log('SIGNAL FILTER ANALYSIS: Finding the Right Politician Filter')
    console.log('═'.repeat(120))
    console.log(
      `\nData range: ${minDate.toISOString().slice(0, 10)} to ${maxDate.toISOString().slice(0, 10)} (${totalMonths} months)`
    )
    console.log(`Total politicians with positions: ${politicianStats.length}`)
    console.log(`Total buy signals: ${buySignals.length}`)

    interface FilterResult {
      name: string
      politicians: number
      totalSignals: number
      signalsPerMonth: number
      avgAnnReturn: number
      weightedAnnReturn: number
      politicianList: string[]
    }

    const results: FilterResult[] = []

    // Helper to calculate filter results
    const calcFilter = (name: string, filter: (p: PoliticianStats) => boolean): FilterResult => {
      const filtered = sortedByReturn.filter(filter)
      const politicianSet = new Set(filtered.map(p => p.name))
      const filteredSignals = buySignals.filter(s => politicianSet.has(s.politician_name))

      const totalSignals = filteredSignals.length
      const signalsPerMonth = totalSignals / totalMonths

      // Simple average of annualized returns
      const avgAnnReturn =
        filtered.length > 0
          ? filtered.reduce((sum, p) => sum + p.annualizedReturnPct, 0) / filtered.length
          : 0

      // Weighted by signal count
      const totalTrades = filtered.reduce((sum, p) => sum + p.trades, 0)
      const weightedAnnReturn =
        totalTrades > 0
          ? filtered.reduce((sum, p) => sum + p.annualizedReturnPct * p.trades, 0) / totalTrades
          : 0

      return {
        name,
        politicians: filtered.length,
        totalSignals,
        signalsPerMonth: Math.round(signalsPerMonth * 10) / 10,
        avgAnnReturn,
        weightedAnnReturn,
        politicianList: filtered.slice(0, 10).map(p => p.name)
      }
    }

    // Test different filters
    // 1. Top N by annualized return (min 15 trades)
    const minTrades = 15
    const qualified = sortedByReturn.filter(p => p.trades >= minTrades)

    results.push(
      calcFilter('Top 3 (min 15 trades)', p => p.trades >= minTrades && qualified.indexOf(p) < 3)
    )
    results.push(
      calcFilter('Top 5 (min 15 trades)', p => p.trades >= minTrades && qualified.indexOf(p) < 5)
    )
    results.push(
      calcFilter('Top 10 (min 15 trades)', p => p.trades >= minTrades && qualified.indexOf(p) < 10)
    )
    results.push(
      calcFilter('Top 15 (min 15 trades)', p => p.trades >= minTrades && qualified.indexOf(p) < 15)
    )
    results.push(
      calcFilter('Top 20 (min 15 trades)', p => p.trades >= minTrades && qualified.indexOf(p) < 20)
    )
    results.push(
      calcFilter('Top 25 (min 15 trades)', p => p.trades >= minTrades && qualified.indexOf(p) < 25)
    )
    results.push(
      calcFilter('Top 30 (min 15 trades)', p => p.trades >= minTrades && qualified.indexOf(p) < 30)
    )

    // 2. Minimum annualized return thresholds
    results.push(calcFilter('Ann% >= 50%', p => p.annualizedReturnPct >= 50))
    results.push(calcFilter('Ann% >= 40%', p => p.annualizedReturnPct >= 40))
    results.push(calcFilter('Ann% >= 30%', p => p.annualizedReturnPct >= 30))
    results.push(calcFilter('Ann% >= 25%', p => p.annualizedReturnPct >= 25))
    results.push(calcFilter('Ann% >= 20%', p => p.annualizedReturnPct >= 20))
    results.push(calcFilter('Ann% >= 15%', p => p.annualizedReturnPct >= 15))

    // 3. Combined filters (quality + volume)
    results.push(
      calcFilter('Ann% >= 20% AND >= 15 trades', p => p.annualizedReturnPct >= 20 && p.trades >= 15)
    )
    results.push(
      calcFilter('Ann% >= 15% AND >= 30 trades', p => p.annualizedReturnPct >= 15 && p.trades >= 30)
    )
    results.push(
      calcFilter('Ann% >= 25% AND >= 50 trades', p => p.annualizedReturnPct >= 25 && p.trades >= 50)
    )

    // 4. All politicians (baseline)
    results.push(calcFilter('All Politicians', () => true))

    // Print results table
    console.log('\n' + '-'.repeat(120))
    console.log('FILTER COMPARISON (sorted by signals/month)')
    console.log('-'.repeat(120))
    console.log(
      pad('Filter', 32, true) +
        ' | ' +
        pad('Pols', 4) +
        ' | ' +
        pad('Signals', 7) +
        ' | ' +
        pad('Sig/Mo', 6) +
        ' | ' +
        pad('Avg Ann%', 8) +
        ' | ' +
        pad('Wtd Ann%', 8) +
        ' | ' +
        'Top Politicians'
    )
    console.log('-'.repeat(120))

    // Sort by signals per month for easier comparison
    const sortedResults = [...results].sort((a, b) => a.signalsPerMonth - b.signalsPerMonth)

    for (const r of sortedResults) {
      const topPols = r.politicianList.slice(0, 3).join(', ')
      console.log(
        pad(r.name.slice(0, 32), 32, true) +
          ' | ' +
          pad(String(r.politicians), 4) +
          ' | ' +
          pad(String(r.totalSignals), 7) +
          ' | ' +
          pad(r.signalsPerMonth.toFixed(1), 6) +
          ' | ' +
          pad(formatPct(r.avgAnnReturn), 8) +
          ' | ' +
          pad(formatPct(r.weightedAnnReturn), 8) +
          ' | ' +
          topPols.slice(0, 40)
      )
    }

    // Find the ~30 signals/month sweet spot
    console.log('\n' + '-'.repeat(120))
    console.log('RECOMMENDED: Filters closest to ~30 signals/month target')
    console.log('-'.repeat(120))

    const target = 30
    const closest = [...results]
      .filter(r => r.signalsPerMonth >= 20 && r.signalsPerMonth <= 50)
      .sort((a, b) => Math.abs(a.signalsPerMonth - target) - Math.abs(b.signalsPerMonth - target))

    for (const r of closest.slice(0, 5)) {
      console.log(
        `  ${r.name}: ${r.signalsPerMonth.toFixed(1)} sig/mo, ${formatPct(r.avgAnnReturn)} avg ann%`
      )
      console.log(`    Politicians: ${r.politicianList.join(', ')}`)
    }

    // Show the "Top 10 qualified" list in detail
    console.log('\n' + '-'.repeat(120))
    console.log('TOP 10 POLITICIANS (min 15 trades, sorted by Ann%)')
    console.log('-'.repeat(120))
    console.log(
      pad('#', 3) +
        ' | ' +
        pad('Politician', 24, true) +
        ' | ' +
        pad('Party', 5, true) +
        ' | ' +
        pad('Trades', 6) +
        ' | ' +
        pad('Return', 8) +
        ' | ' +
        pad('Ann%', 8) +
        ' | ' +
        pad('Win%', 5) +
        ' | ' +
        pad('Sig/Mo', 6)
    )
    console.log('-'.repeat(120))

    for (let i = 0; i < Math.min(10, qualified.length); i++) {
      const p = qualified[i]
      const pSignals = buySignals.filter(s => s.politician_name === p.name).length
      const sigPerMonth = pSignals / totalMonths
      console.log(
        pad(String(i + 1), 3) +
          ' | ' +
          pad(p.name.slice(0, 24), 24, true) +
          ' | ' +
          pad(p.party, 5, true) +
          ' | ' +
          pad(String(p.trades), 6) +
          ' | ' +
          pad(formatPct(p.totalReturnPct), 8) +
          ' | ' +
          pad(formatPct(p.annualizedReturnPct), 8) +
          ' | ' +
          pad(`${p.winRate.toFixed(0)}%`, 5) +
          ' | ' +
          pad(sigPerMonth.toFixed(1), 6)
      )
    }

    console.log('\n' + '═'.repeat(120))
    console.log('KEY: Sig/Mo = Buy signals per month | Avg Ann% = Simple avg of politician Ann%')
    console.log('     Wtd Ann% = Weighted by signal count (accounts for volume)')
    console.log('═'.repeat(120))

    expect(results.length).toBeGreaterThan(0)
  })

  // ===========================================================================
  // STRATEGY × FILTER MATRIX: Compare 4 strategies with Top 5/10/15 filters
  // Shows RAW congressional copy returns for each filter level
  // ===========================================================================
  it('should compare politician filters (Top 5/10/15)', () => {
    const signals = loadSignals()
    const priceMap = buildPriceMap(signals)
    const politicianNames = [...new Set(signals.map(s => s.politician_name))]

    // Calculate stats for all politicians
    const politicianStats: PoliticianStats[] = []
    for (const name of politicianNames) {
      const stats = calculatePoliticianStats(signals, name, priceMap)
      if (stats && (stats.closedTrades > 0 || stats.openPositions > 0)) {
        politicianStats.push(stats)
      }
    }

    // Get qualified politicians (min 15 trades) sorted by annualized return
    const MIN_TRADES = 15
    const qualified = [...politicianStats]
      .filter(p => p.trades >= MIN_TRADES)
      .sort((a, b) => b.annualizedReturnPct - a.annualizedReturnPct)

    // Create politician whitelist for each filter
    const top5Names = qualified.slice(0, 5).map(p => p.name)
    const top10Names = qualified.slice(0, 10).map(p => p.name)
    const top15Names = qualified.slice(0, 15).map(p => p.name)

    console.log('\n' + '═'.repeat(140))
    console.log('POLITICIAN FILTER COMPARISON: Top 5 vs Top 10 vs Top 15')
    console.log('═'.repeat(140))

    console.log(`\nTop 5:  ${top5Names.join(', ')}`)
    console.log(`Top 10: ${top10Names.slice(5).join(', ')}`)
    console.log(`Top 15: ${top15Names.slice(10).join(', ')}`)

    // Define the 3 filters
    const filters = [
      { name: 'Top 5', politicians: top5Names },
      { name: 'Top 10', politicians: top10Names },
      { name: 'Top 15', politicians: top15Names }
    ]

    // Print results table (just the 3 filter levels)
    console.log('\n' + '-'.repeat(140))
    console.log('RESULTS: Raw Congressional Copy Performance (FIFO Matching)')
    console.log('-'.repeat(140))
    console.log(
      pad('Filter', 10, true) +
        ' | ' +
        pad('Pols', 4) +
        ' | ' +
        pad('Trades', 6) +
        ' | ' +
        pad('Closed', 6) +
        ' | ' +
        pad('Open', 4) +
        ' | ' +
        pad('Total P&L', 10) +
        ' | ' +
        pad('Return%', 8) +
        ' | ' +
        pad('Ann%', 8) +
        ' | ' +
        pad('AvgHold', 7) +
        ' | ' +
        pad('Win%', 5)
    )
    console.log('-'.repeat(140))

    for (const filter of filters) {
      const politicianSet = new Set(filter.politicians)
      const stratStats = calculateStrategyStats(
        politicianStats,
        p => politicianSet.has(p.name),
        filter.name
      )

      console.log(
        pad(filter.name, 10, true) +
          ' | ' +
          pad(String(stratStats.politicians), 4) +
          ' | ' +
          pad(String(stratStats.trades), 6) +
          ' | ' +
          pad(String(stratStats.closedTrades), 6) +
          ' | ' +
          pad(String(stratStats.openPositions), 4) +
          ' | ' +
          pad(formatMoney(stratStats.totalPnL), 10) +
          ' | ' +
          pad(formatPct(stratStats.totalReturnPct), 8) +
          ' | ' +
          pad(formatPct(stratStats.annualizedReturnPct), 8) +
          ' | ' +
          pad(stratStats.avgHoldDays > 0 ? `${stratStats.avgHoldDays.toFixed(0)}d` : '-', 7) +
          ' | ' +
          pad(`${stratStats.winRate.toFixed(0)}%`, 5)
      )
    }

    // SPY benchmark for comparison
    const spyBenchmark = calculateSPYBenchmark(signals)
    const spyAnnualized = annualizeReturn(spyBenchmark.returnPct, spyBenchmark.holdDays)

    console.log('-'.repeat(140))
    console.log(
      pad('SPY', 10, true) +
        ' | ' +
        pad('-', 4) +
        ' | ' +
        pad('-', 6) +
        ' | ' +
        pad('-', 6) +
        ' | ' +
        pad('-', 4) +
        ' | ' +
        pad('-', 10) +
        ' | ' +
        pad(formatPct(spyBenchmark.returnPct), 8) +
        ' | ' +
        pad(formatPct(spyAnnualized), 8) +
        ' | ' +
        pad(`${spyBenchmark.holdDays}d`, 7) +
        ' | ' +
        pad('-', 5)
    )

    console.log('\n' + '═'.repeat(140))
    console.log(
      'This is the RAW congressional copy ceiling - buy when they buy, sell when they sell.'
    )
    console.log('Strategy scoring/sizing/exits will reduce this based on filters applied.')
    console.log('═'.repeat(140))

    expect(filters.length).toBe(3)
  })
})
