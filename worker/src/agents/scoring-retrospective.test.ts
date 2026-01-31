/**
 * Scoring Algorithm Retrospective Analysis
 *
 * Evaluates how well the scoring algorithm predicts actual trade outcomes.
 * Uses the entire signal database to find optimization opportunities.
 *
 * Run with: cd worker && pnpm test scoring-retrospective
 */

import { describe, it, expect } from 'vitest'
import { CHATGPT_CONFIG } from './configs'
import {
  calculateScoreSync,
  scoreTimeDecay,
  scorePriceMovement,
  scorePositionSize
} from './scoring'
import {
  loadSignalsFromExport,
  daysBetween,
  computePoliticianWinRates,
  pad,
  formatPct,
  type RawSignal
} from './test-utils'

// =============================================================================
// Load Data (extend RawSignal with position_size_max for this test)
// =============================================================================

interface Signal extends RawSignal {
  position_size_max: number
}

function loadSignals(): Signal[] {
  return loadSignalsFromExport().filter(
    (s: Signal) => s.ticker && s.disclosure_date && s.disclosure_price && s.disclosure_price > 0
  )
}

// =============================================================================
// Trade Matching - Find buy-sell pairs to calculate actual returns
// =============================================================================

interface MatchedTrade {
  ticker: string
  politician: string
  buyDate: string
  sellDate: string
  buyPrice: number
  sellPrice: number
  holdDays: number
  returnPct: number
  buySignal: Signal
}

function matchBuySellPairs(signals: Signal[]): MatchedTrade[] {
  const matched: MatchedTrade[] = []

  // Group by politician + ticker
  const groups = new Map<string, { buys: Signal[]; sells: Signal[] }>()

  for (const signal of signals) {
    if (!signal.disclosure_price || signal.disclosure_price <= 0) continue

    const key = `${signal.politician_name}|${signal.ticker}`
    if (!groups.has(key)) {
      groups.set(key, { buys: [], sells: [] })
    }

    const group = groups.get(key)!
    if (signal.action === 'buy') {
      group.buys.push(signal)
    } else if (signal.action === 'sell') {
      group.sells.push(signal)
    }
  }

  // Match each buy with subsequent sell
  for (const [_key, group] of groups) {
    // Sort by date
    group.buys.sort((a, b) => a.disclosure_date.localeCompare(b.disclosure_date))
    group.sells.sort((a, b) => a.disclosure_date.localeCompare(b.disclosure_date))

    for (const buy of group.buys) {
      // Find first sell after this buy
      const sell = group.sells.find(s => s.disclosure_date > buy.disclosure_date)
      if (sell && sell.disclosure_price && buy.disclosure_price) {
        const holdDays = daysBetween(buy.disclosure_date, sell.disclosure_date)
        const returnPct =
          ((sell.disclosure_price - buy.disclosure_price) / buy.disclosure_price) * 100

        matched.push({
          ticker: buy.ticker,
          politician: buy.politician_name,
          buyDate: buy.disclosure_date,
          sellDate: sell.disclosure_date,
          buyPrice: buy.disclosure_price,
          sellPrice: sell.disclosure_price,
          holdDays,
          returnPct,
          buySignal: buy
        })
      }
    }
  }

  return matched
}

// =============================================================================
// Scoring Component Analysis
// =============================================================================

interface TradeWithScore {
  trade: MatchedTrade
  score: number
  breakdown: Record<string, number>
  // Individual component inputs
  daysSinceTrade: number
  priceChangePct: number
  positionSize: number
}

function enrichTradesWithScores(
  trades: MatchedTrade[],
  politicianWinRates: Map<string, number>
): TradeWithScore[] {
  const config = CHATGPT_CONFIG
  const results: TradeWithScore[] = []

  for (const trade of trades) {
    const signal = trade.buySignal
    const buyPrice = trade.buyPrice
    const tradePrice = signal.trade_price ?? buyPrice
    const daysSinceTrade = daysBetween(signal.trade_date, signal.disclosure_date)
    const priceChangePct = tradePrice > 0 ? ((buyPrice - tradePrice) / tradePrice) * 100 : 0

    const enrichedSignal = {
      id: signal.id,
      ticker: signal.ticker,
      action: signal.action as 'buy' | 'sell',
      asset_type: signal.asset_type as any,
      trade_price: tradePrice,
      current_price: buyPrice,
      trade_date: signal.trade_date,
      disclosure_date: signal.disclosure_date,
      position_size_min: signal.position_size_min,
      politician_name: signal.politician_name,
      source: signal.source,
      days_since_trade: daysSinceTrade,
      days_since_filing: 0,
      price_change_pct: priceChangePct
    }

    const winRate = politicianWinRates.get(signal.politician_name)
    const scoreResult = calculateScoreSync(config.scoring!, enrichedSignal, winRate)

    results.push({
      trade,
      score: scoreResult.score,
      breakdown: scoreResult.breakdown,
      daysSinceTrade,
      priceChangePct,
      positionSize: signal.position_size_min
    })
  }

  return results
}

// =============================================================================
// Statistical Helpers
// =============================================================================

function correlation(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length === 0) return 0

  const n = xs.length
  const sumX = xs.reduce((a, b) => a + b, 0)
  const sumY = ys.reduce((a, b) => a + b, 0)
  const sumXY = xs.reduce((sum, x, i) => sum + x * ys[i], 0)
  const sumX2 = xs.reduce((sum, x) => sum + x * x, 0)
  const sumY2 = ys.reduce((sum, y) => sum + y * y, 0)

  const num = n * sumXY - sumX * sumY
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY))

  return den === 0 ? 0 : num / den
}

function bucketAnalysis(
  data: { input: number; return: number }[],
  buckets: number[]
): { range: string; count: number; avgReturn: number; winRate: number }[] {
  const results: { range: string; count: number; avgReturn: number; winRate: number }[] = []

  for (let i = 0; i <= buckets.length; i++) {
    const min = i === 0 ? -Infinity : buckets[i - 1]
    const max = i === buckets.length ? Infinity : buckets[i]

    const filtered = data.filter(d => d.input >= min && d.input < max)
    if (filtered.length === 0) continue

    const avgReturn = filtered.reduce((sum, d) => sum + d.return, 0) / filtered.length
    const wins = filtered.filter(d => d.return > 0).length

    results.push({
      range: `${min === -Infinity ? '-∞' : min.toFixed(0)}-${max === Infinity ? '∞' : max.toFixed(0)}`,
      count: filtered.length,
      avgReturn,
      winRate: (wins / filtered.length) * 100
    })
  }

  return results
}

// Formatting helpers imported from test-utils.ts

// =============================================================================
// Tests
// =============================================================================

describe('Scoring Algorithm Retrospective', () => {
  it('should analyze correlation between score components and actual returns', () => {
    const signals = loadSignals()
    console.log(`\nLoaded ${signals.length} signals`)

    // Match buy-sell pairs
    const matchedTrades = matchBuySellPairs(signals)
    console.log(`Matched ${matchedTrades.length} buy-sell pairs`)

    // Compute win rates
    const winRates = computePoliticianWinRates(signals)

    // Enrich with scores
    const tradesWithScores = enrichTradesWithScores(matchedTrades, winRates)

    console.log('\n' + '═'.repeat(100))
    console.log('SCORING COMPONENT CORRELATION WITH ACTUAL RETURNS')
    console.log('═'.repeat(100))

    // Extract data for correlation
    const returns = tradesWithScores.map(t => t.trade.returnPct)
    const scores = tradesWithScores.map(t => t.score)
    const timeDecays = tradesWithScores.map(t => t.breakdown.time_decay ?? 0)
    const priceMovements = tradesWithScores.map(t => t.breakdown.price_movement ?? 0)
    const positionSizes = tradesWithScores.map(t => t.breakdown.position_size ?? 0)
    const politicianSkills = tradesWithScores.map(t => t.breakdown.politician_skill ?? 0)

    // Raw inputs
    const daysSinceTrade = tradesWithScores.map(t => t.daysSinceTrade)
    const priceChangePcts = tradesWithScores.map(t => t.priceChangePct)
    const positions = tradesWithScores.map(t => t.positionSize)

    console.log('\n--- Correlation with Actual Return (higher = more predictive) ---')
    console.log(`  Overall Score:      ${correlation(scores, returns).toFixed(3)}`)
    console.log(`  Time Decay:         ${correlation(timeDecays, returns).toFixed(3)}`)
    console.log(`  Price Movement:     ${correlation(priceMovements, returns).toFixed(3)}`)
    console.log(`  Position Size:      ${correlation(positionSizes, returns).toFixed(3)}`)
    console.log(`  Politician Skill:   ${correlation(politicianSkills, returns).toFixed(3)}`)

    console.log('\n--- Raw Input Correlation ---')
    console.log(`  Days Since Trade:   ${correlation(daysSinceTrade, returns).toFixed(3)}`)
    console.log(`  Price Change %:     ${correlation(priceChangePcts, returns).toFixed(3)}`)
    console.log(`  Position Size $:    ${correlation(positions, returns).toFixed(3)}`)

    expect(tradesWithScores.length).toBeGreaterThan(0)
  })

  it('should analyze returns by score bucket', () => {
    const signals = loadSignals()
    const matchedTrades = matchBuySellPairs(signals)
    const winRates = computePoliticianWinRates(signals)
    const tradesWithScores = enrichTradesWithScores(matchedTrades, winRates)

    console.log('\n' + '═'.repeat(100))
    console.log('RETURNS BY SCORE BUCKET')
    console.log('═'.repeat(100))

    const scoreBuckets = [0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]
    const scoreData = tradesWithScores.map(t => ({ input: t.score, return: t.trade.returnPct }))
    const scoreAnalysis = bucketAnalysis(scoreData, scoreBuckets)

    console.log(
      '\n' +
        pad('Score Range', 15, true) +
        ' | ' +
        pad('Count', 6) +
        ' | ' +
        pad('Avg Return', 12) +
        ' | ' +
        pad('Win Rate', 10)
    )
    console.log('-'.repeat(55))
    for (const row of scoreAnalysis) {
      console.log(
        pad(row.range, 15, true) +
          ' | ' +
          pad(String(row.count), 6) +
          ' | ' +
          pad(formatPct(row.avgReturn), 12) +
          ' | ' +
          pad(`${row.winRate.toFixed(0)}%`, 10)
      )
    }

    expect(scoreAnalysis.length).toBeGreaterThan(0)
  })

  it('should analyze returns by days since trade', () => {
    const signals = loadSignals()
    const matchedTrades = matchBuySellPairs(signals)
    const winRates = computePoliticianWinRates(signals)
    const tradesWithScores = enrichTradesWithScores(matchedTrades, winRates)

    console.log('\n' + '═'.repeat(100))
    console.log('RETURNS BY DAYS SINCE TRADE (Signal Freshness)')
    console.log('═'.repeat(100))

    const dayBuckets = [3, 7, 14, 21, 30, 45, 60, 90]
    const dayData = tradesWithScores.map(t => ({
      input: t.daysSinceTrade,
      return: t.trade.returnPct
    }))
    const dayAnalysis = bucketAnalysis(dayData, dayBuckets)

    console.log(
      '\n' +
        pad('Days Range', 15, true) +
        ' | ' +
        pad('Count', 6) +
        ' | ' +
        pad('Avg Return', 12) +
        ' | ' +
        pad('Win Rate', 10)
    )
    console.log('-'.repeat(55))
    for (const row of dayAnalysis) {
      console.log(
        pad(row.range, 15, true) +
          ' | ' +
          pad(String(row.count), 6) +
          ' | ' +
          pad(formatPct(row.avgReturn), 12) +
          ' | ' +
          pad(`${row.winRate.toFixed(0)}%`, 10)
      )
    }

    // Find optimal cutoff
    let bestCutoff = 0
    let bestDiff = -Infinity
    for (const cutoff of dayBuckets) {
      const before = tradesWithScores.filter(t => t.daysSinceTrade < cutoff)
      const after = tradesWithScores.filter(t => t.daysSinceTrade >= cutoff)
      if (before.length < 10 || after.length < 10) continue

      const avgBefore = before.reduce((s, t) => s + t.trade.returnPct, 0) / before.length
      const avgAfter = after.reduce((s, t) => s + t.trade.returnPct, 0) / after.length
      const diff = avgBefore - avgAfter

      if (diff > bestDiff) {
        bestDiff = diff
        bestCutoff = cutoff
      }
    }
    console.log(
      `\nOptimal freshness cutoff: ${bestCutoff} days (${formatPct(bestDiff)} return advantage)`
    )

    expect(dayAnalysis.length).toBeGreaterThan(0)
  })

  it('should analyze returns by price movement since trade', () => {
    const signals = loadSignals()
    const matchedTrades = matchBuySellPairs(signals)
    const winRates = computePoliticianWinRates(signals)
    const tradesWithScores = enrichTradesWithScores(matchedTrades, winRates)

    console.log('\n' + '═'.repeat(100))
    console.log("RETURNS BY PRICE MOVEMENT % (Since Politician's Trade)")
    console.log('═'.repeat(100))

    const pctBuckets = [-20, -10, -5, 0, 5, 10, 15, 20, 30]
    const pctData = tradesWithScores.map(t => ({
      input: t.priceChangePct,
      return: t.trade.returnPct
    }))
    const pctAnalysis = bucketAnalysis(pctData, pctBuckets)

    console.log(
      '\n' +
        pad('Price Δ%', 15, true) +
        ' | ' +
        pad('Count', 6) +
        ' | ' +
        pad('Avg Return', 12) +
        ' | ' +
        pad('Win Rate', 10)
    )
    console.log('-'.repeat(55))
    for (const row of pctAnalysis) {
      console.log(
        pad(row.range, 15, true) +
          ' | ' +
          pad(String(row.count), 6) +
          ' | ' +
          pad(formatPct(row.avgReturn), 12) +
          ' | ' +
          pad(`${row.winRate.toFixed(0)}%`, 10)
      )
    }

    // Analyze dip bonus effectiveness
    const dips = tradesWithScores.filter(t => t.priceChangePct < 0)
    const gains = tradesWithScores.filter(t => t.priceChangePct > 0)
    const flat = tradesWithScores.filter(t => Math.abs(t.priceChangePct) <= 2)

    console.log('\n--- Dip vs Gain Analysis ---')
    if (dips.length > 0) {
      const dipAvg = dips.reduce((s, t) => s + t.trade.returnPct, 0) / dips.length
      const dipWin = (dips.filter(t => t.trade.returnPct > 0).length / dips.length) * 100
      console.log(
        `  Dips (price dropped):    ${dips.length} trades, ${formatPct(dipAvg)} avg, ${dipWin.toFixed(0)}% win rate`
      )
    }
    if (gains.length > 0) {
      const gainAvg = gains.reduce((s, t) => s + t.trade.returnPct, 0) / gains.length
      const gainWin = (gains.filter(t => t.trade.returnPct > 0).length / gains.length) * 100
      console.log(
        `  Gains (price rose):      ${gains.length} trades, ${formatPct(gainAvg)} avg, ${gainWin.toFixed(0)}% win rate`
      )
    }
    if (flat.length > 0) {
      const flatAvg = flat.reduce((s, t) => s + t.trade.returnPct, 0) / flat.length
      const flatWin = (flat.filter(t => t.trade.returnPct > 0).length / flat.length) * 100
      console.log(
        `  Flat (±2%):              ${flat.length} trades, ${formatPct(flatAvg)} avg, ${flatWin.toFixed(0)}% win rate`
      )
    }

    expect(pctAnalysis.length).toBeGreaterThan(0)
  })

  it('should analyze returns by congressional position size', () => {
    const signals = loadSignals()
    const matchedTrades = matchBuySellPairs(signals)
    const winRates = computePoliticianWinRates(signals)
    const tradesWithScores = enrichTradesWithScores(matchedTrades, winRates)

    console.log('\n' + '═'.repeat(100))
    console.log('RETURNS BY CONGRESSIONAL POSITION SIZE (Conviction Level)')
    console.log('═'.repeat(100))

    const sizeBuckets = [5000, 15000, 50000, 100000, 250000, 500000]
    const sizeData = tradesWithScores.map(t => ({
      input: t.positionSize,
      return: t.trade.returnPct
    }))
    const sizeAnalysis = bucketAnalysis(sizeData, sizeBuckets)

    console.log(
      '\n' +
        pad('Size Range', 20, true) +
        ' | ' +
        pad('Count', 6) +
        ' | ' +
        pad('Avg Return', 12) +
        ' | ' +
        pad('Win Rate', 10)
    )
    console.log('-'.repeat(60))
    for (const row of sizeAnalysis) {
      console.log(
        pad(row.range, 20, true) +
          ' | ' +
          pad(String(row.count), 6) +
          ' | ' +
          pad(formatPct(row.avgReturn), 12) +
          ' | ' +
          pad(`${row.winRate.toFixed(0)}%`, 10)
      )
    }

    expect(sizeAnalysis.length).toBeGreaterThan(0)
  })

  it('should test alternative weight configurations', () => {
    const signals = loadSignals()
    const matchedTrades = matchBuySellPairs(signals)
    const winRates = computePoliticianWinRates(signals)

    console.log('\n' + '═'.repeat(100))
    console.log('ALTERNATIVE WEIGHT CONFIGURATIONS')
    console.log('═'.repeat(100))

    // Weight configurations to test
    const configs = [
      { name: 'Current (ChatGPT)', time: 0.3, price: 0.25, size: 0.15, skill: 0.2, source: 0.1 },
      { name: 'Time Heavy', time: 0.5, price: 0.2, size: 0.1, skill: 0.15, source: 0.05 },
      { name: 'Price Heavy', time: 0.2, price: 0.45, size: 0.1, skill: 0.15, source: 0.1 },
      { name: 'Size Heavy', time: 0.2, price: 0.2, size: 0.35, skill: 0.15, source: 0.1 },
      { name: 'Skill Heavy', time: 0.2, price: 0.2, size: 0.1, skill: 0.4, source: 0.1 },
      { name: 'Equal Weights', time: 0.2, price: 0.2, size: 0.2, skill: 0.2, source: 0.2 },
      { name: 'Time+Price', time: 0.4, price: 0.4, size: 0.05, skill: 0.1, source: 0.05 },
      { name: 'Fresh Only', time: 0.6, price: 0.2, size: 0.05, skill: 0.1, source: 0.05 }
    ]

    interface ConfigResult {
      name: string
      avgReturn: number
      winRate: number
      sharpe: number
      aboveThreshold: number
    }

    const results: ConfigResult[] = []
    const threshold = 0.55

    for (const cfg of configs) {
      // Create custom scoring config
      const customConfig = {
        components: {
          time_decay: { weight: cfg.time, half_life_days: 10 },
          price_movement: {
            weight: cfg.price,
            thresholds: { pct_0: 1.0, pct_5: 0.8, pct_15: 0.4, pct_25: 0.0 }
          },
          position_size: {
            weight: cfg.size,
            thresholds: [15000, 50000, 100000, 250000],
            scores: [0.2, 0.4, 0.6, 0.8, 1.0]
          },
          politician_skill: { weight: cfg.skill, min_trades_for_data: 20, default_score: 0.5 },
          source_quality: {
            weight: cfg.source,
            scores: { quiver_quant: 1.0, capitol_trades: 0.9, default: 0.8 },
            confirmation_bonus: 0.05,
            max_confirmation_bonus: 0.15
          }
        }
      }

      // Score all trades with this config
      const scored: { score: number; return: number }[] = []

      for (const trade of matchedTrades) {
        const signal = trade.buySignal
        const buyPrice = trade.buyPrice
        const tradePrice = signal.trade_price ?? buyPrice
        const daysSinceTrade = daysBetween(signal.trade_date, signal.disclosure_date)
        const priceChangePct = tradePrice > 0 ? ((buyPrice - tradePrice) / tradePrice) * 100 : 0

        const enrichedSignal = {
          id: signal.id,
          ticker: signal.ticker,
          action: signal.action as 'buy' | 'sell',
          asset_type: signal.asset_type as any,
          trade_price: tradePrice,
          current_price: buyPrice,
          trade_date: signal.trade_date,
          disclosure_date: signal.disclosure_date,
          position_size_min: signal.position_size_min,
          politician_name: signal.politician_name,
          source: signal.source,
          days_since_trade: daysSinceTrade,
          days_since_filing: 0,
          price_change_pct: priceChangePct
        }

        const winRate = winRates.get(signal.politician_name)
        const scoreResult = calculateScoreSync(customConfig as any, enrichedSignal, winRate)

        scored.push({ score: scoreResult.score, return: trade.returnPct })
      }

      // Filter to trades above threshold
      const aboveThreshold = scored.filter(s => s.score >= threshold)
      const returns = aboveThreshold.map(s => s.return)

      if (returns.length === 0) continue

      const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length
      const wins = returns.filter(r => r > 0).length
      const winRate = (wins / returns.length) * 100

      // Simple Sharpe approximation
      const variance =
        returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
      const stdDev = Math.sqrt(variance)
      const sharpe = stdDev > 0 ? avgReturn / stdDev : 0

      results.push({
        name: cfg.name,
        avgReturn,
        winRate,
        sharpe,
        aboveThreshold: aboveThreshold.length
      })
    }

    // Sort by average return
    results.sort((a, b) => b.avgReturn - a.avgReturn)

    console.log(`\nResults for trades with score >= ${threshold}:`)
    console.log(
      '\n' +
        pad('Config', 18, true) +
        ' | ' +
        pad('Trades', 7) +
        ' | ' +
        pad('Avg Return', 12) +
        ' | ' +
        pad('Win Rate', 10) +
        ' | ' +
        pad('Sharpe', 8)
    )
    console.log('-'.repeat(70))
    for (const r of results) {
      console.log(
        pad(r.name, 18, true) +
          ' | ' +
          pad(String(r.aboveThreshold), 7) +
          ' | ' +
          pad(formatPct(r.avgReturn), 12) +
          ' | ' +
          pad(`${r.winRate.toFixed(0)}%`, 10) +
          ' | ' +
          pad(r.sharpe.toFixed(2), 8)
      )
    }

    console.log(
      `\nBest configuration: ${results[0].name} with ${formatPct(results[0].avgReturn)} avg return`
    )

    expect(results.length).toBeGreaterThan(0)
  })

  it('should find optimal threshold for execution', () => {
    const signals = loadSignals()
    const matchedTrades = matchBuySellPairs(signals)
    const winRates = computePoliticianWinRates(signals)
    const tradesWithScores = enrichTradesWithScores(matchedTrades, winRates)

    console.log('\n' + '═'.repeat(100))
    console.log('OPTIMAL EXECUTION THRESHOLD ANALYSIS')
    console.log('═'.repeat(100))

    const thresholds = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]

    console.log(
      '\n' +
        pad('Threshold', 10) +
        ' | ' +
        pad('Trades', 7) +
        ' | ' +
        pad('Avg Return', 12) +
        ' | ' +
        pad('Win Rate', 10) +
        ' | ' +
        pad('Total Return', 14)
    )
    console.log('-'.repeat(65))

    let bestThreshold = 0
    let bestTotalReturn = -Infinity

    for (const threshold of thresholds) {
      const filtered = tradesWithScores.filter(t => t.score >= threshold)
      if (filtered.length === 0) continue

      const returns = filtered.map(t => t.trade.returnPct)
      const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length
      const wins = returns.filter(r => r > 0).length
      const winRate = (wins / returns.length) * 100
      const totalReturn = returns.reduce((a, b) => a + b, 0)

      if (totalReturn > bestTotalReturn) {
        bestTotalReturn = totalReturn
        bestThreshold = threshold
      }

      console.log(
        pad(threshold.toFixed(2), 10) +
          ' | ' +
          pad(String(filtered.length), 7) +
          ' | ' +
          pad(formatPct(avgReturn), 12) +
          ' | ' +
          pad(`${winRate.toFixed(0)}%`, 10) +
          ' | ' +
          pad(formatPct(totalReturn), 14)
      )
    }

    console.log(`\nOptimal threshold: ${bestThreshold.toFixed(2)} (maximizes total return)`)
    console.log(`Current ChatGPT threshold: 0.55`)

    expect(thresholds.length).toBeGreaterThan(0)
  })

  it('should analyze top politician performance vs scoring', () => {
    const signals = loadSignals()
    const matchedTrades = matchBuySellPairs(signals)
    const winRates = computePoliticianWinRates(signals)
    const tradesWithScores = enrichTradesWithScores(matchedTrades, winRates)

    console.log('\n' + '═'.repeat(100))
    console.log('TOP POLITICIAN PERFORMANCE VS SCORING')
    console.log('═'.repeat(100))

    // Group by politician
    const byPolitician = new Map<string, TradeWithScore[]>()
    for (const t of tradesWithScores) {
      const name = t.trade.politician
      if (!byPolitician.has(name)) {
        byPolitician.set(name, [])
      }
      byPolitician.get(name)!.push(t)
    }

    // Calculate stats per politician
    interface PoliticianStats {
      name: string
      trades: number
      avgReturn: number
      winRate: number
      avgScore: number
      scoreCorrelation: number
    }

    const stats: PoliticianStats[] = []

    for (const [name, trades] of byPolitician) {
      if (trades.length < 5) continue // Need minimum trades

      const returns = trades.map(t => t.trade.returnPct)
      const scores = trades.map(t => t.score)

      const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length
      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length
      const wins = returns.filter(r => r > 0).length
      const winRate = (wins / returns.length) * 100
      const corr = correlation(scores, returns)

      stats.push({
        name,
        trades: trades.length,
        avgReturn,
        winRate,
        avgScore,
        scoreCorrelation: corr
      })
    }

    // Sort by average return
    stats.sort((a, b) => b.avgReturn - a.avgReturn)

    console.log('\nTop 15 Politicians by Return:')
    console.log(
      '\n' +
        pad('Politician', 25, true) +
        ' | ' +
        pad('Trades', 7) +
        ' | ' +
        pad('Avg Return', 12) +
        ' | ' +
        pad('Win%', 6) +
        ' | ' +
        pad('Avg Score', 10) +
        ' | ' +
        pad('Score Corr', 11)
    )
    console.log('-'.repeat(85))

    for (const p of stats.slice(0, 15)) {
      console.log(
        pad(p.name.slice(0, 25), 25, true) +
          ' | ' +
          pad(String(p.trades), 7) +
          ' | ' +
          pad(formatPct(p.avgReturn), 12) +
          ' | ' +
          pad(`${p.winRate.toFixed(0)}%`, 6) +
          ' | ' +
          pad(p.avgScore.toFixed(2), 10) +
          ' | ' +
          pad(p.scoreCorrelation.toFixed(3), 11)
      )
    }

    // Check if scoring correlates with politician performance
    const politicianReturns = stats.map(s => s.avgReturn)
    const politicianScores = stats.map(s => s.avgScore)
    const overallCorr = correlation(politicianScores, politicianReturns)

    console.log(
      `\nCorrelation between avg score and avg return across politicians: ${overallCorr.toFixed(3)}`
    )
    console.log(
      '(Positive = scoring identifies better politicians, Negative = scoring is misleading)'
    )

    expect(stats.length).toBeGreaterThan(0)
  })
})
