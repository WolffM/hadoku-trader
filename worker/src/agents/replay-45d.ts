#!/usr/bin/env npx tsx
/**
 * 45-Day Signal Replay Script (ChatGPT Only)
 *
 * Runs ChatGPT agent through signals_45d.json with dynamic Top 10 filter
 * exactly as production would. Outputs 1 row per decision as CSV.
 *
 * Usage: cd worker && npx tsx src/agents/replay-45d.ts > ../docs/45d_chatgpt.csv
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { CHATGPT_CONFIG } from './configs.js'
import { calculateScoreSync, getDetailedScoring } from './scoring.js'
import { calculatePositionSize as productionCalculatePositionSize } from './sizing.js'
import { daysBetween } from './filters.js'
import { computePoliticianWinRates } from './simulation.js'
import type { AgentConfig, EnrichedSignal, ScoringBreakdown } from './types.js'

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// =============================================================================
// Types
// =============================================================================

interface RawSignal {
  id: string
  ticker: string
  action: string
  asset_type: string
  trade_price: number
  disclosure_price?: number
  trade_date: string
  disclosure_date: string
  position_size_min: number
  politician_name: string
  source: string
}

interface RankingEntry {
  politician_name: string
  rank: number | null
  annualized_return_pct: number
}

interface Position {
  ticker: string
  shares: number
  cost: number
  entryPrice: number
  entryDate: string
}

interface Decision {
  row: number
  date: string
  signalId: string
  ticker: string
  politician: string
  signalAction: 'buy' | 'sell'
  tradePrice: number
  currentPrice: number
  priceChangePct: number
  daysSinceTrade: number
  action: 'BUY' | 'SELL' | 'SKIP'
  reason: string
  score: number | null
  breakdown: ScoringBreakdown | null
  positionSize: number | null
  cashBefore: number
  cashAfter: number
  positionCount: number
}

// =============================================================================
// Data Loading (matches production exactly)
// =============================================================================

function loadSignals45d(): RawSignal[] {
  const filePath = path.join(__dirname, '../../../signals_45d.json')
  if (!fs.existsSync(filePath)) {
    throw new Error(`Signal file not found: ${filePath}`)
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  return (data.signals as RawSignal[]).filter(
    s => s.ticker && s.trade_date && s.trade_price > 0 && s.action && s.politician_name
  )
}

function loadRankings(): RankingEntry[] {
  const filePath = path.join(__dirname, '../../../rankings.json')
  if (!fs.existsSync(filePath)) {
    throw new Error(`Rankings file not found: ${filePath}`)
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  return Array.isArray(data) ? data : data.rankings
}

/**
 * Get Top N politicians from rankings - matches production getTopPoliticians()
 */
function getTopNPoliticians(n: number): string[] {
  const rankings = loadRankings()
  return rankings
    .filter(r => r.rank !== null && r.rank <= n)
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
    .map(r => r.politician_name)
}

// =============================================================================
// Scoring (matches production calculateScoreSync)
// =============================================================================

// getDetailedScoring is imported from ./scoring.js

function calculatePositionSize(config: AgentConfig, score: number, availableCash: number): number {
  return productionCalculatePositionSize(
    config,
    score,
    { remaining: availableCash },
    1,
    false,
    undefined,
    undefined
  )
}

// =============================================================================
// Agent Simulation (matches production router.ts logic)
// =============================================================================

function runChatGPTReplay(config: AgentConfig, signals: RawSignal[]): Decision[] {
  // Sort by disclosure_date (chronological processing order)
  const sortedSignals = [...signals].sort((a, b) =>
    a.disclosure_date.localeCompare(b.disclosure_date)
  )

  // Filter to signals with valid disclosure_price
  const validSignals = sortedSignals.filter(s => s.disclosure_price && s.disclosure_price > 0)

  // Compute politician win rates from historical data (matches production)
  const politicianWinRates = computePoliticianWinRates(validSignals as any)

  let cash = config.monthly_budget
  const positions: Position[] = []
  const decisions: Decision[] = []
  let rowNum = 0

  for (const simSignal of validSignals) {
    rowNum++
    const currentPrice = simSignal.disclosure_price!
    const tradePrice = simSignal.trade_price ?? currentPrice
    const daysSinceTrade = daysBetween(simSignal.trade_date, simSignal.disclosure_date)
    const priceChangePct = tradePrice > 0 ? ((currentPrice - tradePrice) / tradePrice) * 100 : 0

    const cashBefore = cash
    let action: 'BUY' | 'SELL' | 'SKIP' = 'SKIP'
    let reason = ''
    let score: number | null = null
    let breakdown: ScoringBreakdown | null = null
    let positionSize: number | null = null

    // SELL signal handling
    if (simSignal.action === 'sell') {
      const posIdx = positions.findIndex(p => p.ticker === simSignal.ticker)
      if (posIdx >= 0) {
        const pos = positions[posIdx]
        const proceeds = pos.shares * currentPrice
        cash += proceeds
        positions.splice(posIdx, 1)
        action = 'SELL'
        reason = `Closed ${pos.shares.toFixed(2)} @ $${currentPrice.toFixed(2)}`
        positionSize = proceeds
      } else {
        reason = 'No position to sell'
      }
    }
    // BUY signal handling
    else {
      // 1. Check politician whitelist (Top 10 filter applied by production)
      if (
        config.politician_whitelist &&
        !config.politician_whitelist.includes(simSignal.politician_name)
      ) {
        reason = 'Not in whitelist'
      }
      // 2. Check asset type
      else if (!config.allowed_asset_types.includes(simSignal.asset_type as any)) {
        reason = `Asset type ${simSignal.asset_type} not allowed`
      }
      // 3. Check signal age (max_signal_age_days)
      else if (daysSinceTrade > config.max_signal_age_days) {
        reason = `Too old (${daysSinceTrade}d > ${config.max_signal_age_days}d)`
      }
      // 4. Check price movement (max_price_move_pct)
      else if (Math.abs(priceChangePct) > config.max_price_move_pct) {
        reason = `Price moved ${Math.abs(priceChangePct).toFixed(1)}% > ${config.max_price_move_pct}%`
      }
      // 5. Check max_per_ticker (per day - matches countAgentTickerPositionsToday)
      else if (
        positions.filter(
          p => p.ticker === simSignal.ticker && p.entryDate === simSignal.disclosure_date
        ).length >= (config.sizing.max_per_ticker ?? 1)
      ) {
        reason = `Already bought ${simSignal.ticker} today`
      }
      // 6. Calculate score and make decision
      else if (config.scoring) {
        const enrichedSignal: EnrichedSignal = {
          id: simSignal.id,
          ticker: simSignal.ticker,
          action: simSignal.action as 'buy' | 'sell',
          asset_type: simSignal.asset_type as any,
          trade_price: tradePrice,
          disclosure_price: simSignal.disclosure_price ?? null,
          current_price: currentPrice,
          trade_date: simSignal.trade_date,
          disclosure_date: simSignal.disclosure_date,
          position_size_min: simSignal.position_size_min,
          politician_name: simSignal.politician_name,
          source: simSignal.source,
          days_since_trade: daysSinceTrade,
          days_since_filing: 0, // At disclosure time
          price_change_pct: priceChangePct,
          disclosure_drift_pct: 0 // At disclosure time
        }

        const winRate = politicianWinRates.get(simSignal.politician_name) ?? 0.5
        const scoreResult = calculateScoreSync(config.scoring, enrichedSignal, winRate)
        score = scoreResult.score
        breakdown = getDetailedScoring(config.scoring, enrichedSignal, winRate)

        // 7. Check score threshold
        if (score < config.execute_threshold) {
          reason = `Score ${score.toFixed(3)} < ${config.execute_threshold}`
        } else {
          // 8. Calculate position size
          const size = calculatePositionSize(config, score, cash)
          if (size < 1) {
            reason = `Position size too small ($${size.toFixed(2)})`
          } else if (size > cash) {
            reason = `Insufficient cash ($${size.toFixed(0)} > $${cash.toFixed(0)})`
          } else {
            // Execute!
            cash -= size
            const shares = size / currentPrice
            positions.push({
              ticker: simSignal.ticker,
              shares,
              cost: size,
              entryPrice: currentPrice,
              entryDate: simSignal.disclosure_date
            })
            action = 'BUY'
            reason = `${shares.toFixed(3)} shares @ $${currentPrice.toFixed(2)}`
            positionSize = size
          }
        }
      }
    }

    decisions.push({
      row: rowNum,
      date: simSignal.disclosure_date,
      signalId: simSignal.id,
      ticker: simSignal.ticker,
      politician: simSignal.politician_name,
      signalAction: simSignal.action as 'buy' | 'sell',
      tradePrice,
      currentPrice,
      priceChangePct,
      daysSinceTrade,
      action,
      reason,
      score,
      breakdown,
      positionSize,
      cashBefore,
      cashAfter: cash,
      positionCount: positions.length
    })
  }

  return decisions
}

// =============================================================================
// Main
// =============================================================================

function main() {
  // Load Top 10 politicians from rankings (matches production getTopPoliticians)
  let top10Politicians: string[]
  try {
    top10Politicians = getTopNPoliticians(10)
    console.error(`Top 10 from rankings.json: ${top10Politicians.join(', ')}`)
  } catch (e: unknown) {
    console.error(
      `ERROR: Could not load rankings.json: ${e instanceof Error ? e.message : String(e)}`
    )
    throw e
  }

  // Load signals
  const signals = loadSignals45d()
  console.error(`Loaded ${signals.length} signals from signals_45d.json`)

  // Apply Top 10 filter to ChatGPT config (matches production getActiveAgentsWithTopPoliticians)
  // Production: agents with null whitelist get Top 10 applied dynamically
  const chatgptWithTop10: AgentConfig = {
    ...CHATGPT_CONFIG,
    politician_whitelist: top10Politicians
  }

  console.error(`ChatGPT config: politician_whitelist = [${top10Politicians.join(', ')}]`)
  console.error(`ChatGPT config: execute_threshold = ${chatgptWithTop10.execute_threshold}`)
  console.error(`ChatGPT config: max_signal_age_days = ${chatgptWithTop10.max_signal_age_days}`)
  console.error(`ChatGPT config: max_price_move_pct = ${chatgptWithTop10.max_price_move_pct}`)
  console.error(`ChatGPT config: sizing.mode = ${chatgptWithTop10.sizing.mode}`)
  console.error(`ChatGPT config: sizing.base_amount = ${chatgptWithTop10.sizing.base_amount}`)

  // Run replay
  const decisions = runChatGPTReplay(chatgptWithTop10, signals)

  // Output CSV header
  const headers = [
    'row',
    'date',
    'signal_id',
    'ticker',
    'politician',
    'sig_action',
    'trade_price',
    'current_price',
    'price_change_pct',
    'days_since_trade',
    'decision',
    'reason',
    'score',
    'time_decay',
    'price_move',
    'pos_size',
    'pol_skill',
    'src_qual',
    'position_size_usd',
    'cash_before',
    'cash_after',
    'open_positions'
  ]
  console.log(headers.join(','))

  // Output rows
  for (const d of decisions) {
    const b = d.breakdown
    const row = [
      d.row,
      d.date.slice(0, 10),
      `"${d.signalId}"`,
      d.ticker,
      `"${d.politician}"`,
      d.signalAction.toUpperCase(),
      d.tradePrice.toFixed(2),
      d.currentPrice.toFixed(2),
      d.priceChangePct.toFixed(2),
      d.daysSinceTrade,
      d.action,
      `"${d.reason.replace(/"/g, "'")}"`,
      d.score?.toFixed(4) ?? '',
      b?.time_decay.raw.toFixed(4) ?? '',
      b?.price_movement.raw.toFixed(4) ?? '',
      b?.position_size.raw.toFixed(4) ?? '',
      b?.politician_skill.raw.toFixed(4) ?? '',
      b?.source_quality.raw.toFixed(4) ?? '',
      d.positionSize?.toFixed(2) ?? '',
      d.cashBefore.toFixed(2),
      d.cashAfter.toFixed(2),
      d.positionCount
    ]
    console.log(row.join(','))
  }

  // Summary to stderr
  const buys = decisions.filter(d => d.action === 'BUY')
  const sells = decisions.filter(d => d.action === 'SELL')
  const skips = decisions.filter(d => d.action === 'SKIP')

  console.error('\n--- SUMMARY ---')
  console.error(`Total decisions: ${decisions.length}`)
  console.error(`  BUY:  ${buys.length}`)
  console.error(`  SELL: ${sells.length}`)
  console.error(`  SKIP: ${skips.length}`)

  if (buys.length > 0) {
    const totalInvested = buys.reduce((sum, d) => sum + (d.positionSize ?? 0), 0)
    const finalCash = decisions[decisions.length - 1].cashAfter
    const openPositions = decisions[decisions.length - 1].positionCount
    console.error(`\nTotal invested: $${totalInvested.toFixed(2)}`)
    console.error(`Final cash: $${finalCash.toFixed(2)}`)
    console.error(`Open positions: ${openPositions}`)

    console.error('\nExecuted trades:')
    for (const d of buys) {
      console.error(
        `  ${d.date.slice(0, 10)} | ${d.ticker.padEnd(6)} | ${d.politician.padEnd(20)} | score=${d.score?.toFixed(3)} | $${d.positionSize?.toFixed(2)}`
      )
    }
  }

  // Skip reasons breakdown
  const skipReasons = new Map<string, number>()
  for (const d of skips) {
    const key = d.reason.split(' (')[0].split(' ').slice(0, 3).join(' ')
    skipReasons.set(key, (skipReasons.get(key) || 0) + 1)
  }
  console.error('\nSkip reasons:')
  for (const [reason, count] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${reason}: ${count}`)
  }
}

main()
