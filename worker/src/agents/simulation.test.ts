/**
 * Portfolio Simulation Test
 *
 * Run with: cd worker && pnpm test simulation
 */

import { describe, it, expect } from 'vitest'
import { CHATGPT_CONFIG, CLAUDE_CONFIG, GEMINI_CONFIG, NAIVE_CONFIG } from './configs'
import { runSimulation, type SimSignal } from './simulation'
import {
  loadSignalsFromExport,
  pad,
  formatPct,
  formatMoney,
  buildPriceMap,
  buildPoliticianFilters,
  calculatePoliticianStats,
  type RawSignal,
  type TestPoliticianStats
} from './test-utils'

// =============================================================================
// Load Data
// =============================================================================

function loadSignals(): SimSignal[] {
  return loadSignalsFromExport()
}

function loadSignalsTyped(): RawSignal[] {
  return loadSignalsFromExport().filter(
    (s: RawSignal) =>
      s.ticker &&
      s.trade_date &&
      s.trade_price > 0 &&
      s.action &&
      s.politician_name &&
      s.politician_party &&
      s.politician_chamber
  )
}

// =============================================================================
// Tests
// =============================================================================

describe('Portfolio Simulation', () => {
  it('should run 4 strategies × 5 filters = 20 combinations', () => {
    const signals = loadSignals()
    const typedSignals = loadSignalsTyped()
    console.log(`\nLoaded ${signals.length} signals`)

    // Build politician filters
    const filters = buildPoliticianFilters(typedSignals)
    console.log(`\nBuilt ${filters.length} politician filters:`)
    for (const f of filters) {
      console.log(
        `  ${f.name}: ${f.politicians.size} politicians, ${f.signalsPerMonth.toFixed(1)} sig/mo`
      )
    }

    // Define strategies
    const strategies = [
      { name: 'ChatGPT', config: CHATGPT_CONFIG },
      { name: 'Claude', config: CLAUDE_CONFIG },
      { name: 'Gemini', config: GEMINI_CONFIG },
      { name: 'Naive', config: NAIVE_CONFIG }
    ]

    // Run all combinations
    interface ResultRow {
      strategy: string
      filter: string
      signalsPerMonth: number
      months: number
      buys: number
      sells: number
      closedTrades: number
      winRate: number
      realizedPnL: number
      finalPortfolio: number
      totalDeposits: number
      growthPct: number
    }

    const results: ResultRow[] = []

    for (const filter of filters) {
      for (const strategy of strategies) {
        const result = runSimulation(strategy.config, signals, filter.politicians)

        const totalBuys = result.monthlySnapshots.reduce((sum, m) => sum + m.buys, 0)
        const totalSells = result.monthlySnapshots.reduce((sum, m) => sum + m.sells, 0)
        const wins = result.closedTrades.filter(t => t.profit > 0).length
        const winRate =
          result.closedTrades.length > 0 ? (wins / result.closedTrades.length) * 100 : 0
        const lastSnapshot = result.monthlySnapshots[result.monthlySnapshots.length - 1]

        results.push({
          strategy: strategy.name,
          filter: filter.name,
          signalsPerMonth: filter.signalsPerMonth,
          months: result.months,
          buys: totalBuys,
          sells: totalSells,
          closedTrades: result.closedTrades.length,
          winRate,
          realizedPnL: result.realizedPnL,
          finalPortfolio: lastSnapshot?.portfolioValue ?? 0,
          totalDeposits: result.totalDeposits,
          growthPct: lastSnapshot?.growthPct ?? 0
        })
      }
    }

    // Print results table
    console.log('\n' + '═'.repeat(130))
    console.log('STRATEGY × FILTER MATRIX: 4 Strategies × 5 Politician Filters (35 months)')
    console.log('═'.repeat(130))

    console.log(
      pad('Strategy', 10, true) +
        ' | ' +
        pad('Filter', 10, true) +
        ' | ' +
        pad('Sig/Mo', 6) +
        ' | ' +
        pad('Buys', 5) +
        ' | ' +
        pad('Sells', 5) +
        ' | ' +
        pad('Closed', 6) +
        ' | ' +
        pad('Win%', 5) +
        ' | ' +
        pad('RealPnL', 9) +
        ' | ' +
        pad('Deposits', 8) +
        ' | ' +
        pad('Portfolio', 10) +
        ' | ' +
        pad('Growth', 8)
    )
    console.log('-'.repeat(130))

    // Group by filter for better readability
    for (const filter of filters) {
      const filterResults = results.filter(r => r.filter === filter.name)
      for (const r of filterResults) {
        console.log(
          pad(r.strategy, 10, true) +
            ' | ' +
            pad(r.filter, 10, true) +
            ' | ' +
            pad(r.signalsPerMonth.toFixed(1), 6) +
            ' | ' +
            pad(String(r.buys), 5) +
            ' | ' +
            pad(String(r.sells), 5) +
            ' | ' +
            pad(String(r.closedTrades), 6) +
            ' | ' +
            pad(`${r.winRate.toFixed(0)}%`, 5) +
            ' | ' +
            pad(formatMoney(r.realizedPnL), 9) +
            ' | ' +
            pad(formatMoney(r.totalDeposits), 8) +
            ' | ' +
            pad(formatMoney(r.finalPortfolio), 10) +
            ' | ' +
            pad(formatPct(r.growthPct), 8)
        )
      }
      console.log('-'.repeat(130))
    }

    // Summary: Best combination
    const sortedByGrowth = [...results].sort((a, b) => b.growthPct - a.growthPct)
    console.log('\nTOP 5 COMBINATIONS BY GROWTH:')
    for (let i = 0; i < 5; i++) {
      const r = sortedByGrowth[i]
      console.log(
        `  ${i + 1}. ${r.strategy} + ${r.filter}: ${formatPct(r.growthPct)} growth, ${formatMoney(r.finalPortfolio)} portfolio`
      )
    }

    expect(results.length).toBe(20)
  })

  // ===========================================================================
  // COMPREHENSIVE STRATEGY COMPARISON: All Agents + Benchmarks
  // ===========================================================================

  it('should compare ALL strategies over 3-year training set', () => {
    const signals = loadSignals()
    const typedSignals = loadSignalsTyped()
    console.log(`\nLoaded ${signals.length} signals for 3-year comparison`)

    // Build politician filters
    const priceMap = buildPriceMap(typedSignals)
    const politicianNames = [...new Set(typedSignals.map(s => s.politician_name))]

    // Calculate stats for all politicians
    const allStats: TestPoliticianStats[] = []
    for (const name of politicianNames) {
      const stats = calculatePoliticianStats(typedSignals, name, priceMap)
      if (stats && (stats.closedTrades > 0 || stats.trades > 0)) {
        allStats.push(stats)
      }
    }

    // Build Top 10 filter (our best performing filter)
    const MIN_TRADES = 15
    const qualified = [...allStats]
      .filter(p => p.trades >= MIN_TRADES)
      .sort((a, b) => b.annualizedReturnPct - a.annualizedReturnPct)
    const top10Politicians = new Set(qualified.slice(0, 10).map(p => p.name))

    // Get all politicians set
    const allPoliticians = new Set(typedSignals.map(s => s.politician_name))

    // Nancy Pelosi only set
    const pelosiOnly = new Set(['Nancy Pelosi'])

    // Calculate date range
    const buySignals = typedSignals.filter(s => s.action === 'buy' && s.trade_price > 0)
    const dates = buySignals.map(s => new Date(s.disclosure_date).getTime())
    const minDate = new Date(Math.min(...dates))
    const maxDate = new Date(Math.max(...dates))
    const totalMonths =
      (maxDate.getFullYear() - minDate.getFullYear()) * 12 +
      (maxDate.getMonth() - minDate.getMonth()) +
      1

    console.log(
      `\nDate range: ${minDate.toISOString().slice(0, 10)} to ${maxDate.toISOString().slice(0, 10)}`
    )
    console.log(`Total months: ${totalMonths}`)

    // ===========================================================================
    // Define all strategies to test
    // ===========================================================================

    interface StrategyResult {
      name: string
      description: string
      months: number
      totalDeposits: number
      portfolioValue: number
      growthPct: number
      annualizedReturnPct: number
      totalBuys: number
      closedTrades: number
      winRate: number
      realizedPnL: number
    }

    const results: StrategyResult[] = []

    // 1. ChatGPT + Top 10 (our recommended strategy)
    {
      const result = runSimulation(CHATGPT_CONFIG, signals, top10Politicians)
      const lastSnapshot = result.monthlySnapshots[result.monthlySnapshots.length - 1]
      const totalBuys = result.monthlySnapshots.reduce((sum, m) => sum + m.buys, 0)
      const wins = result.closedTrades.filter(t => t.profit > 0).length
      const years = totalMonths / 12
      const totalReturn = lastSnapshot ? lastSnapshot.growthPct / 100 : 0
      const annualized = years > 0 ? (Math.pow(1 + totalReturn, 1 / years) - 1) * 100 : 0

      results.push({
        name: 'ChatGPT + Top 10',
        description: 'Decay Edge with top 10 politicians',
        months: totalMonths,
        totalDeposits: result.totalDeposits,
        portfolioValue: lastSnapshot?.portfolioValue ?? 0,
        growthPct: lastSnapshot?.growthPct ?? 0,
        annualizedReturnPct: annualized,
        totalBuys,
        closedTrades: result.closedTrades.length,
        winRate: result.closedTrades.length > 0 ? (wins / result.closedTrades.length) * 100 : 0,
        realizedPnL: result.realizedPnL
      })
    }

    // 2. ChatGPT + All Politicians
    {
      const result = runSimulation(CHATGPT_CONFIG, signals, allPoliticians)
      const lastSnapshot = result.monthlySnapshots[result.monthlySnapshots.length - 1]
      const totalBuys = result.monthlySnapshots.reduce((sum, m) => sum + m.buys, 0)
      const wins = result.closedTrades.filter(t => t.profit > 0).length
      const years = totalMonths / 12
      const totalReturn = lastSnapshot ? lastSnapshot.growthPct / 100 : 0
      const annualized = years > 0 ? (Math.pow(1 + totalReturn, 1 / years) - 1) * 100 : 0

      results.push({
        name: 'ChatGPT + All',
        description: 'Decay Edge with all politicians',
        months: totalMonths,
        totalDeposits: result.totalDeposits,
        portfolioValue: lastSnapshot?.portfolioValue ?? 0,
        growthPct: lastSnapshot?.growthPct ?? 0,
        annualizedReturnPct: annualized,
        totalBuys,
        closedTrades: result.closedTrades.length,
        winRate: result.closedTrades.length > 0 ? (wins / result.closedTrades.length) * 100 : 0,
        realizedPnL: result.realizedPnL
      })
    }

    // 3. Claude + Top 10
    {
      const result = runSimulation(CLAUDE_CONFIG, signals, top10Politicians)
      const lastSnapshot = result.monthlySnapshots[result.monthlySnapshots.length - 1]
      const totalBuys = result.monthlySnapshots.reduce((sum, m) => sum + m.buys, 0)
      const wins = result.closedTrades.filter(t => t.profit > 0).length
      const years = totalMonths / 12
      const totalReturn = lastSnapshot ? lastSnapshot.growthPct / 100 : 0
      const annualized = years > 0 ? (Math.pow(1 + totalReturn, 1 / years) - 1) * 100 : 0

      results.push({
        name: 'Claude + Top 10',
        description: 'Decay Alpha with top 10 politicians',
        months: totalMonths,
        totalDeposits: result.totalDeposits,
        portfolioValue: lastSnapshot?.portfolioValue ?? 0,
        growthPct: lastSnapshot?.growthPct ?? 0,
        annualizedReturnPct: annualized,
        totalBuys,
        closedTrades: result.closedTrades.length,
        winRate: result.closedTrades.length > 0 ? (wins / result.closedTrades.length) * 100 : 0,
        realizedPnL: result.realizedPnL
      })
    }

    // 4. Claude + All Politicians
    {
      const result = runSimulation(CLAUDE_CONFIG, signals, allPoliticians)
      const lastSnapshot = result.monthlySnapshots[result.monthlySnapshots.length - 1]
      const totalBuys = result.monthlySnapshots.reduce((sum, m) => sum + m.buys, 0)
      const wins = result.closedTrades.filter(t => t.profit > 0).length
      const years = totalMonths / 12
      const totalReturn = lastSnapshot ? lastSnapshot.growthPct / 100 : 0
      const annualized = years > 0 ? (Math.pow(1 + totalReturn, 1 / years) - 1) * 100 : 0

      results.push({
        name: 'Claude + All',
        description: 'Decay Alpha with all politicians',
        months: totalMonths,
        totalDeposits: result.totalDeposits,
        portfolioValue: lastSnapshot?.portfolioValue ?? 0,
        growthPct: lastSnapshot?.growthPct ?? 0,
        annualizedReturnPct: annualized,
        totalBuys,
        closedTrades: result.closedTrades.length,
        winRate: result.closedTrades.length > 0 ? (wins / result.closedTrades.length) * 100 : 0,
        realizedPnL: result.realizedPnL
      })
    }

    // 5. Gemini + Titan 5 (original config)
    {
      const titanPoliticians = new Set(GEMINI_CONFIG.politician_whitelist || [])
      const result = runSimulation(GEMINI_CONFIG, signals, titanPoliticians)
      const lastSnapshot = result.monthlySnapshots[result.monthlySnapshots.length - 1]
      const totalBuys = result.monthlySnapshots.reduce((sum, m) => sum + m.buys, 0)
      const wins = result.closedTrades.filter(t => t.profit > 0).length
      const years = totalMonths / 12
      const totalReturn = lastSnapshot ? lastSnapshot.growthPct / 100 : 0
      const annualized = years > 0 ? (Math.pow(1 + totalReturn, 1 / years) - 1) * 100 : 0

      results.push({
        name: 'Gemini + Titans',
        description: 'Titan Conviction with 5 whitelisted',
        months: totalMonths,
        totalDeposits: result.totalDeposits,
        portfolioValue: lastSnapshot?.portfolioValue ?? 0,
        growthPct: lastSnapshot?.growthPct ?? 0,
        annualizedReturnPct: annualized,
        totalBuys,
        closedTrades: result.closedTrades.length,
        winRate: result.closedTrades.length > 0 ? (wins / result.closedTrades.length) * 100 : 0,
        realizedPnL: result.realizedPnL
      })
    }

    // 6. Naive (Monkey Trader) + All
    {
      const result = runSimulation(NAIVE_CONFIG, signals, allPoliticians)
      const lastSnapshot = result.monthlySnapshots[result.monthlySnapshots.length - 1]
      const totalBuys = result.monthlySnapshots.reduce((sum, m) => sum + m.buys, 0)
      const wins = result.closedTrades.filter(t => t.profit > 0).length
      const years = totalMonths / 12
      const totalReturn = lastSnapshot ? lastSnapshot.growthPct / 100 : 0
      const annualized = years > 0 ? (Math.pow(1 + totalReturn, 1 / years) - 1) * 100 : 0

      results.push({
        name: 'Monkey Trader',
        description: 'No scoring, buy everything',
        months: totalMonths,
        totalDeposits: result.totalDeposits,
        portfolioValue: lastSnapshot?.portfolioValue ?? 0,
        growthPct: lastSnapshot?.growthPct ?? 0,
        annualizedReturnPct: annualized,
        totalBuys,
        closedTrades: result.closedTrades.length,
        winRate: result.closedTrades.length > 0 ? (wins / result.closedTrades.length) * 100 : 0,
        realizedPnL: result.realizedPnL
      })
    }

    // 7. Nancy Pelosi Only
    {
      const result = runSimulation(CHATGPT_CONFIG, signals, pelosiOnly)
      const lastSnapshot = result.monthlySnapshots[result.monthlySnapshots.length - 1]
      const totalBuys = result.monthlySnapshots.reduce((sum, m) => sum + m.buys, 0)
      const wins = result.closedTrades.filter(t => t.profit > 0).length
      const years = totalMonths / 12
      const totalReturn = lastSnapshot ? lastSnapshot.growthPct / 100 : 0
      const annualized = years > 0 ? (Math.pow(1 + totalReturn, 1 / years) - 1) * 100 : 0

      // Also calculate Pelosi's historical stats
      const pelosiStats = allStats.find(s => s.name === 'Nancy Pelosi')

      results.push({
        name: 'Nancy Pelosi Only',
        description: `${pelosiStats?.trades ?? 0} trades, ${pelosiStats?.annualizedReturnPct?.toFixed(0) ?? 'N/A'}% ann. hist.`,
        months: totalMonths,
        totalDeposits: result.totalDeposits,
        portfolioValue: lastSnapshot?.portfolioValue ?? 0,
        growthPct: lastSnapshot?.growthPct ?? 0,
        annualizedReturnPct: annualized,
        totalBuys,
        closedTrades: result.closedTrades.length,
        winRate: result.closedTrades.length > 0 ? (wins / result.closedTrades.length) * 100 : 0,
        realizedPnL: result.realizedPnL
      })
    }

    // 8. SPY Buy & Hold (simulated benchmark)
    // Note: We don't have SPY data in our signals, so we use historical avg return
    {
      // S&P 500 historical average: ~10% annual return
      // We simulate $1000/month invested over the period
      const monthlyDeposit = 1000
      const annualReturn = 0.1 // 10% average annual return
      const monthlyReturn = Math.pow(1 + annualReturn, 1 / 12) - 1

      let spyPortfolio = 0
      for (let m = 0; m < totalMonths; m++) {
        spyPortfolio = (spyPortfolio + monthlyDeposit) * (1 + monthlyReturn)
      }
      const totalDeposits = monthlyDeposit * totalMonths
      const growthPct = ((spyPortfolio - totalDeposits) / totalDeposits) * 100

      results.push({
        name: 'SPY Buy & Hold',
        description: 'S&P 500 index (10% avg annual)',
        months: totalMonths,
        totalDeposits,
        portfolioValue: spyPortfolio,
        growthPct,
        annualizedReturnPct: 10,
        totalBuys: totalMonths,
        closedTrades: 0,
        winRate: 0,
        realizedPnL: 0
      })
    }

    // ===========================================================================
    // Print Results Table
    // ===========================================================================

    console.log('\n' + '═'.repeat(150))
    console.log('3-YEAR STRATEGY COMPARISON ($1,000/month budget)')
    console.log('═'.repeat(150))

    console.log(
      pad('Strategy', 20, true) +
        ' | ' +
        pad('Description', 35, true) +
        ' | ' +
        pad('Months', 6) +
        ' | ' +
        pad('Deposits', 10) +
        ' | ' +
        pad('Portfolio', 12) +
        ' | ' +
        pad('Growth%', 8) +
        ' | ' +
        pad('Ann%', 6) +
        ' | ' +
        pad('Buys', 5) +
        ' | ' +
        pad('Closed', 6) +
        ' | ' +
        pad('Win%', 5)
    )
    console.log('-'.repeat(150))

    // Sort by growth percentage descending
    const sortedResults = [...results].sort((a, b) => b.growthPct - a.growthPct)

    for (const r of sortedResults) {
      console.log(
        pad(r.name.slice(0, 20), 20, true) +
          ' | ' +
          pad(r.description.slice(0, 35), 35, true) +
          ' | ' +
          pad(String(r.months), 6) +
          ' | ' +
          pad(formatMoney(r.totalDeposits), 10) +
          ' | ' +
          pad(formatMoney(r.portfolioValue), 12) +
          ' | ' +
          pad(formatPct(r.growthPct), 8) +
          ' | ' +
          pad(formatPct(r.annualizedReturnPct).slice(0, 6), 6) +
          ' | ' +
          pad(String(r.totalBuys), 5) +
          ' | ' +
          pad(String(r.closedTrades), 6) +
          ' | ' +
          pad(`${r.winRate.toFixed(0)}%`, 5)
      )
    }

    console.log('-'.repeat(150))

    // ===========================================================================
    // Summary and Recommendations
    // ===========================================================================

    console.log('\n' + '─'.repeat(80))
    console.log('RANKINGS BY TOTAL GROWTH:')
    console.log('─'.repeat(80))
    for (let i = 0; i < sortedResults.length; i++) {
      const r = sortedResults[i]
      const badge = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`
      console.log(
        `${badge} ${r.name.padEnd(20)} ${formatPct(r.growthPct).padStart(8)} growth → ${formatMoney(r.portfolioValue)} portfolio`
      )
    }

    // Compare best strategy to SPY
    const bestStrategy = sortedResults[0]
    const spyResult = results.find(r => r.name === 'SPY Buy & Hold')!
    const outperformance = bestStrategy.growthPct - spyResult.growthPct

    console.log('\n' + '─'.repeat(80))
    console.log('BENCHMARK COMPARISON:')
    console.log('─'.repeat(80))
    console.log(`Best Strategy: ${bestStrategy.name}`)
    console.log(`  Total Growth: ${formatPct(bestStrategy.growthPct)}`)
    console.log(`  Portfolio:    ${formatMoney(bestStrategy.portfolioValue)}`)
    console.log(`\nSPY Buy & Hold:`)
    console.log(`  Total Growth: ${formatPct(spyResult.growthPct)}`)
    console.log(`  Portfolio:    ${formatMoney(spyResult.portfolioValue)}`)
    console.log(
      `\nOutperformance: ${formatPct(outperformance)} (${outperformance > 0 ? 'BEATING' : 'LOSING TO'} market)`
    )

    // Nancy Pelosi comparison
    const pelosiResult = results.find(r => r.name === 'Nancy Pelosi Only')!
    console.log(`\nNancy Pelosi Only:`)
    console.log(`  Total Growth: ${formatPct(pelosiResult.growthPct)}`)
    console.log(`  Portfolio:    ${formatMoney(pelosiResult.portfolioValue)}`)
    console.log(`  Win Rate:     ${pelosiResult.winRate.toFixed(0)}%`)

    // Top 10 politicians in our filter
    console.log('\n' + '─'.repeat(80))
    console.log('TOP 10 POLITICIANS (used in best strategies):')
    console.log('─'.repeat(80))
    for (let i = 0; i < 10 && i < qualified.length; i++) {
      const p = qualified[i]
      console.log(
        `  ${(i + 1).toString().padStart(2)}. ${p.name.padEnd(25)} ${p.party} | ${p.trades} trades | Ann: ${formatPct(p.annualizedReturnPct)}`
      )
    }

    expect(results.length).toBeGreaterThan(0)
    expect(bestStrategy.growthPct).toBeGreaterThan(0)
  })

  // ==========================================================================
  // Debug test: Verify Nancy Pelosi simulation uses production runSimulation()
  // This test validates simulation results without re-implementing logic
  // ==========================================================================
  it('should correctly simulate Nancy Pelosi trades using production code', () => {
    const signals = loadSignals()
    const pelosiOnly = new Set(['Nancy Pelosi'])

    // Run simulation using production code
    const result = runSimulation(CHATGPT_CONFIG, signals, pelosiOnly)

    // Verify we got reasonable results
    const totalBuys = result.monthlySnapshots.reduce((sum, m) => sum + m.buys, 0)
    const totalSells = result.monthlySnapshots.reduce((sum, m) => sum + m.sells, 0)

    console.log('\n=== PELOSI SIMULATION (using production runSimulation) ===')
    console.log(`Months: ${result.months}`)
    console.log(`Buys: ${totalBuys}, Sells: ${totalSells}`)
    console.log(`Open positions: ${result.openPositions.length}`)
    console.log(
      `Portfolio value: $${(result.finalCash + result.openPositions.reduce((s, p) => s + p.cost, 0)).toFixed(0)}`
    )

    // After fixing the rounding bug, Pelosi should have multiple trades
    expect(totalBuys).toBeGreaterThan(1)
    expect(result.openPositions.length).toBeGreaterThan(0)
  })
})
