/**
 * 45-Day Signal Verification Test
 *
 * Stage 1: Local simulation of signals_45d.json with all agents.
 * Produces detailed decision log, scoring breakdowns, and portfolio summary.
 *
 * Run with: cd worker && pnpm test verification-45d
 */

import { describe, it, expect } from 'vitest'
import { CHATGPT_CONFIG, CLAUDE_CONFIG, GEMINI_CONFIG, NAIVE_CONFIG } from './configs'
import {
  calculateScoreSync,
  scoreTimeDecay,
  scorePriceMovement,
  scorePositionSize
} from './scoring'
import {
  loadSignalsFromFile,
  loadSignalsFromExport,
  daysBetween,
  computePoliticianWinRates,
  buildPoliticianFilters,
  pad,
  formatPct,
  type RawSignal,
  type TestPosition
} from './test-utils'
import type { AgentConfig, EnrichedSignal, ScoringConfig, ScoringBreakdown } from './types'

// =============================================================================
// Types (test-specific, extending shared types)
// =============================================================================

// Use RawSignal from test-utils as SimSignal
type SimSignal = RawSignal

// Use TestPosition from test-utils as Position
type Position = TestPosition

// ScoringBreakdown is imported from ./types

interface Decision {
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

interface AgentResult {
  agentId: string
  agentName: string
  decisions: Decision[]
  totalSignals: number
  executed: number
  skipped: number
  finalCash: number
  openPositions: Position[]
  netInvested: number // Current $ in open positions (cost basis)
  grossBuys: number // Total $ spent on all buys
  sellProceeds: number // Total $ returned from sells
  estimatedValue: number
}

// =============================================================================
// Helpers - formatting functions imported from test-utils.ts
// =============================================================================

function loadSignals45d(): SimSignal[] {
  return loadSignalsFromFile('signals_45d.json').filter(
    (s: SimSignal) => s.ticker && s.trade_date && s.trade_price > 0 && s.action && s.politician_name
  )
}

/**
 * Calculate detailed scoring breakdown for a signal
 */
function getDetailedScoring(
  config: ScoringConfig,
  signal: EnrichedSignal,
  winRate: number
): ScoringBreakdown {
  const components = config.components
  const breakdown: ScoringBreakdown = {
    time_decay: { raw: 0, weight: 0, contribution: 0 },
    price_movement: { raw: 0, weight: 0, contribution: 0 },
    position_size: { raw: 0, weight: 0, contribution: 0 },
    politician_skill: { raw: 0, weight: 0, contribution: 0 },
    source_quality: { raw: 0, weight: 0, contribution: 0 },
    final_score: 0
  }

  let totalWeight = 0
  let weightedSum = 0

  // 1. Time Decay
  if (components.time_decay) {
    const raw = scoreTimeDecay(components.time_decay, signal)
    const weight = components.time_decay.weight
    breakdown.time_decay = { raw, weight, contribution: raw * weight }
    weightedSum += raw * weight
    totalWeight += weight
  }

  // 2. Price Movement
  if (components.price_movement) {
    const raw = scorePriceMovement(components.price_movement, signal)
    const weight = components.price_movement.weight
    breakdown.price_movement = { raw, weight, contribution: raw * weight }
    weightedSum += raw * weight
    totalWeight += weight
  }

  // 3. Position Size
  if (components.position_size) {
    const raw = scorePositionSize(components.position_size, signal)
    const weight = components.position_size.weight
    breakdown.position_size = { raw, weight, contribution: raw * weight }
    weightedSum += raw * weight
    totalWeight += weight
  }

  // 4. Politician Skill (use provided win rate)
  if (components.politician_skill) {
    const raw =
      winRate !== undefined
        ? Math.max(0.4, Math.min(0.7, winRate))
        : components.politician_skill.default_score
    const weight = components.politician_skill.weight
    breakdown.politician_skill = { raw, weight, contribution: raw * weight }
    weightedSum += raw * weight
    totalWeight += weight
  }

  // 5. Source Quality
  if (components.source_quality) {
    const raw =
      components.source_quality.scores[signal.source] ??
      components.source_quality.scores['default'] ??
      0.8
    const weight = components.source_quality.weight
    breakdown.source_quality = { raw, weight, contribution: raw * weight }
    weightedSum += raw * weight
    totalWeight += weight
  }

  // 6. Filing Speed (Claude only)
  if (components.filing_speed) {
    let raw = 1.0
    if (signal.days_since_filing <= 7) {
      raw = 1.0 + (components.filing_speed.fast_bonus ?? 0.05)
    } else if (signal.days_since_filing >= 30) {
      raw = 1.0 + (components.filing_speed.slow_penalty ?? -0.1)
    }
    const weight = components.filing_speed.weight
    breakdown.filing_speed = { raw, weight, contribution: raw * weight }
    weightedSum += raw * weight
    totalWeight += weight
  }

  // 7. Cross Confirmation (Claude only)
  if (components.cross_confirmation) {
    const raw = 0.5 // Default, no confirmation data in JSON
    const weight = components.cross_confirmation.weight
    breakdown.cross_confirmation = { raw, weight, contribution: raw * weight }
    weightedSum += raw * weight
    totalWeight += weight
  }

  breakdown.final_score = totalWeight > 0 ? Math.max(0, Math.min(1, weightedSum / totalWeight)) : 0

  return breakdown
}

/**
 * Calculate position size based on agent config and score
 */
function calculatePositionSize(config: AgentConfig, score: number, availableCash: number): number {
  const sizing = config.sizing

  let size: number
  if (sizing.mode === 'score_squared') {
    // ChatGPT: score² × base_multiplier × budget
    size = score * score * (sizing.base_multiplier ?? 0.15) * config.monthly_budget
  } else if (sizing.mode === 'score_linear') {
    // Claude: base_amount × score × budget_ratio
    size = (sizing.base_amount ?? 15) * score * (availableCash / config.monthly_budget)
  } else if (sizing.mode === 'smart_budget') {
    // Gemini: equal split of remaining budget (simplified)
    size = Math.min(200, availableCash * 0.2)
  } else {
    size = 100
  }

  // Apply constraints
  size = Math.min(size, sizing.max_position_amount ?? 1000)
  size = Math.min(size, availableCash * (sizing.max_position_pct ?? 1.0))
  size = Math.max(0, size)

  return Math.round(size * 100) / 100
}

/**
 * Run verification simulation for a single agent
 */
function runAgentVerification(config: AgentConfig, signals: SimSignal[]): AgentResult {
  // Sort signals chronologically by disclosure_date
  const sortedSignals = [...signals].sort((a, b) =>
    a.disclosure_date.localeCompare(b.disclosure_date)
  )

  // Filter to valid signals with disclosure price
  const validSignals = sortedSignals.filter(s => s.disclosure_price && s.disclosure_price > 0)

  // Compute politician win rates from signal data (using shared utility)
  const politicianWinRates = computePoliticianWinRates(validSignals as any)

  // Simulation state
  let cash = config.monthly_budget // Start with $1000
  const positions: Position[] = []
  const decisions: Decision[] = []

  for (const simSignal of validSignals) {
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

    // SELL signal
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
    // BUY signal
    else {
      // Check politician whitelist
      if (
        config.politician_whitelist &&
        !config.politician_whitelist.includes(simSignal.politician_name)
      ) {
        reason = `Not in whitelist`
      }
      // Check asset type
      else if (!config.allowed_asset_types.includes(simSignal.asset_type as any)) {
        reason = `Asset type ${simSignal.asset_type} not allowed`
      }
      // Check signal age
      else if (daysSinceTrade > config.max_signal_age_days) {
        reason = `Too old (${daysSinceTrade}d > ${config.max_signal_age_days}d)`
      }
      // Check price movement
      else if (Math.abs(priceChangePct) > config.max_price_move_pct) {
        reason = `Price moved ${Math.abs(priceChangePct).toFixed(1)}% > ${config.max_price_move_pct}%`
      }
      // Check max positions per ticker (prevent duplicate buys)
      else if (
        positions.filter(p => p.ticker === simSignal.ticker).length >=
        (config.sizing.max_per_ticker ?? 1)
      ) {
        reason = `Already have position in ${simSignal.ticker} (max_per_ticker=${config.sizing.max_per_ticker ?? 1})`
      }
      // Scoring check (if agent uses scoring)
      else if (config.scoring) {
        const enrichedSignal: EnrichedSignal = {
          id: simSignal.id,
          ticker: simSignal.ticker,
          action: simSignal.action as 'buy' | 'sell',
          asset_type: simSignal.asset_type as any,
          trade_price: tradePrice,
          current_price: currentPrice,
          trade_date: simSignal.trade_date,
          disclosure_date: simSignal.disclosure_date,
          position_size_min: simSignal.position_size_min,
          politician_name: simSignal.politician_name,
          source: simSignal.source,
          days_since_trade: daysSinceTrade,
          days_since_filing: daysSinceTrade, // Use same for simplicity
          price_change_pct: priceChangePct
        }

        const winRate = politicianWinRates.get(simSignal.politician_name) ?? 0.5
        const scoreResult = calculateScoreSync(config.scoring, enrichedSignal, winRate)
        score = scoreResult.score
        breakdown = getDetailedScoring(config.scoring, enrichedSignal, winRate)

        if (score < config.execute_threshold) {
          reason = `Score ${score.toFixed(3)} < ${config.execute_threshold}`
        } else {
          // Calculate position size
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
      // No scoring (Gemini-style pass/fail)
      else {
        const size = calculatePositionSize(config, 1.0, cash)
        if (size < 1) {
          reason = `Position size too small`
        } else if (size > cash) {
          reason = `Insufficient cash`
        } else {
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

    decisions.push({
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

  const executed = decisions.filter(d => d.action === 'BUY' || d.action === 'SELL').length
  const skipped = decisions.filter(d => d.action === 'SKIP').length

  // Net currently invested = cost basis of open positions
  const netInvested = positions.reduce((sum, p) => sum + p.cost, 0)

  // Gross buys = total $ spent on all buys (even if later sold)
  const grossBuys = decisions
    .filter(d => d.action === 'BUY')
    .reduce((sum, d) => sum + (d.positionSize ?? 0), 0)

  // Cash returned from sells
  const sellProceeds = decisions
    .filter(d => d.action === 'SELL')
    .reduce((sum, d) => sum + (d.positionSize ?? 0), 0)

  const estimatedValue = cash + netInvested // Cash + open position cost basis

  return {
    agentId: config.id,
    agentName: config.name,
    decisions,
    totalSignals: validSignals.length,
    executed,
    skipped,
    finalCash: cash,
    openPositions: positions,
    netInvested,
    grossBuys,
    sellProceeds,
    estimatedValue
  }
}

// =============================================================================
// Print Functions
// =============================================================================

function printDecisionLog(result: AgentResult): void {
  console.log('\n' + '═'.repeat(180))
  console.log(`DECISION LOG: ${result.agentName} (${result.agentId})`)
  console.log('═'.repeat(180))
  console.log(
    pad('Date', 10, true) +
      ' | ' +
      pad('ID', 18, true) +
      ' | ' +
      pad('Ticker', 6, true) +
      ' | ' +
      pad('Politician', 18, true) +
      ' | ' +
      pad('Sig', 4, true) +
      ' | ' +
      pad('Days', 4) +
      ' | ' +
      pad('Δ%', 7) +
      ' | ' +
      pad('Score', 5) +
      ' | ' +
      pad('Action', 4, true) +
      ' | ' +
      pad('Size', 8) +
      ' | ' +
      pad('Cash', 8) +
      ' | ' +
      pad('Pos', 3) +
      ' | ' +
      'Reason'
  )
  console.log('-'.repeat(180))

  for (const d of result.decisions) {
    const actionColor = d.action === 'BUY' ? 'BUY ' : d.action === 'SELL' ? 'SELL' : 'SKIP'
    console.log(
      pad(d.date.slice(0, 10), 10, true) +
        ' | ' +
        pad(d.signalId.slice(0, 18), 18, true) +
        ' | ' +
        pad(d.ticker.slice(0, 6), 6, true) +
        ' | ' +
        pad(d.politician.slice(0, 18), 18, true) +
        ' | ' +
        pad(d.signalAction.toUpperCase(), 4, true) +
        ' | ' +
        pad(String(d.daysSinceTrade), 4) +
        ' | ' +
        pad(formatPct(d.priceChangePct).slice(0, 7), 7) +
        ' | ' +
        pad(d.score !== null ? d.score.toFixed(2) : '-', 5) +
        ' | ' +
        pad(actionColor, 4, true) +
        ' | ' +
        pad(d.positionSize !== null ? `$${d.positionSize.toFixed(0)}` : '-', 8) +
        ' | ' +
        pad(`$${d.cashAfter.toFixed(0)}`, 8) +
        ' | ' +
        pad(String(d.positionCount), 3) +
        ' | ' +
        d.reason.slice(0, 50)
    )
  }

  // Summary
  console.log('\n' + '-'.repeat(180))
  console.log(
    `SUMMARY: ${result.totalSignals} signals | ${result.executed} executed | ${result.skipped} skipped`
  )
  console.log(
    `Final: $${result.finalCash.toFixed(0)} cash, ${result.openPositions.length} open positions`
  )

  // Skip reasons breakdown
  const skipReasons = new Map<string, number>()
  for (const d of result.decisions.filter(d => d.action === 'SKIP')) {
    const key = d.reason.split(' (')[0].split(' ').slice(0, 3).join(' ')
    skipReasons.set(key, (skipReasons.get(key) || 0) + 1)
  }
  console.log('\nSKIP REASONS:')
  for (const [reason, count] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}`)
  }
}

function printScoringBreakdowns(result: AgentResult): void {
  const executedDecisions = result.decisions.filter(d => d.action === 'BUY' && d.breakdown)

  console.log('\n' + '═'.repeat(100))
  console.log(
    `SCORING BREAKDOWNS: ${result.agentName} (${executedDecisions.length} executed trades)`
  )
  console.log('═'.repeat(100))

  for (const d of executedDecisions) {
    const b = d.breakdown!
    console.log(`\nSignal: ${d.signalId} (${d.ticker}, ${d.politician}, ${d.signalAction})`)
    console.log(
      `  Days since trade: ${d.daysSinceTrade}, Price change: ${formatPct(d.priceChangePct)}`
    )
    console.log(`  ─────────────────────────────────────────────────────────`)

    if (b.time_decay.weight > 0) {
      console.log(
        `  time_decay:       ${b.time_decay.raw.toFixed(3)} × ${b.time_decay.weight.toFixed(2)} = ${b.time_decay.contribution.toFixed(4)}`
      )
    }
    if (b.price_movement.weight > 0) {
      console.log(
        `  price_movement:   ${b.price_movement.raw.toFixed(3)} × ${b.price_movement.weight.toFixed(2)} = ${b.price_movement.contribution.toFixed(4)}`
      )
    }
    if (b.position_size.weight > 0) {
      console.log(
        `  position_size:    ${b.position_size.raw.toFixed(3)} × ${b.position_size.weight.toFixed(2)} = ${b.position_size.contribution.toFixed(4)}`
      )
    }
    if (b.politician_skill.weight > 0) {
      console.log(
        `  politician_skill: ${b.politician_skill.raw.toFixed(3)} × ${b.politician_skill.weight.toFixed(2)} = ${b.politician_skill.contribution.toFixed(4)}`
      )
    }
    if (b.source_quality.weight > 0) {
      console.log(
        `  source_quality:   ${b.source_quality.raw.toFixed(3)} × ${b.source_quality.weight.toFixed(2)} = ${b.source_quality.contribution.toFixed(4)}`
      )
    }
    if (b.filing_speed && b.filing_speed.weight > 0) {
      console.log(
        `  filing_speed:     ${b.filing_speed.raw.toFixed(3)} × ${b.filing_speed.weight.toFixed(2)} = ${b.filing_speed.contribution.toFixed(4)}`
      )
    }
    if (b.cross_confirmation && b.cross_confirmation.weight > 0) {
      console.log(
        `  cross_confirm:    ${b.cross_confirmation.raw.toFixed(3)} × ${b.cross_confirmation.weight.toFixed(2)} = ${b.cross_confirmation.contribution.toFixed(4)}`
      )
    }

    console.log(`  ─────────────────────────────────────────────────────────`)
    console.log(
      `  FINAL SCORE: ${b.final_score.toFixed(4)} (threshold=${result.agentId === 'chatgpt' ? 0.55 : 0.55})`
    )
    console.log(`  POSITION SIZE: $${d.positionSize?.toFixed(2)}`)
  }
}

/**
 * Print condensed executed trades report with scoring breakdown in columns
 */
function printCondensedTradesReport(result: AgentResult): void {
  const executedTrades = result.decisions.filter(d => d.action === 'BUY' || d.action === 'SELL')

  console.log('\n' + '═'.repeat(160))
  console.log(
    `EXECUTED TRADES: ${result.agentName} (${result.agentId}) - ${executedTrades.length} trades`
  )
  console.log('═'.repeat(160))

  // Header - condensed with score components
  console.log(
    pad('#', 2) +
      ' | ' +
      pad('Date', 10, true) +
      ' | ' +
      pad('Ticker', 6, true) +
      ' | ' +
      pad('Politician', 16, true) +
      ' | ' +
      pad('Days', 4) +
      ' | ' +
      pad('Δ%', 6) +
      ' | ' +
      pad('Time', 5) +
      ' | ' +
      pad('Price', 5) +
      ' | ' +
      pad('Size', 5) +
      ' | ' +
      pad('Skill', 5) +
      ' | ' +
      pad('Src', 4) +
      ' | ' +
      pad('Score', 5) +
      ' | ' +
      pad('$Size', 6) +
      ' | ' +
      pad('Cash', 7) +
      ' | ' +
      'Action'
  )
  console.log('-'.repeat(160))

  let tradeNum = 0
  for (const d of executedTrades) {
    tradeNum++
    const b = d.breakdown

    // Format score components (show raw values)
    const timeDecay = b?.time_decay.raw.toFixed(2) ?? '-'
    const priceMove = b?.price_movement.raw.toFixed(2) ?? '-'
    const posSize = b?.position_size.raw.toFixed(2) ?? '-'
    const polSkill = b?.politician_skill.raw.toFixed(2) ?? '-'
    const srcQual = b?.source_quality.raw.toFixed(2) ?? '-'

    console.log(
      pad(String(tradeNum), 2) +
        ' | ' +
        pad(d.date.slice(0, 10), 10, true) +
        ' | ' +
        pad(d.ticker.slice(0, 6), 6, true) +
        ' | ' +
        pad(d.politician.slice(0, 16), 16, true) +
        ' | ' +
        pad(String(d.daysSinceTrade), 4) +
        ' | ' +
        pad(formatPct(d.priceChangePct).slice(0, 6), 6) +
        ' | ' +
        pad(timeDecay, 5) +
        ' | ' +
        pad(priceMove, 5) +
        ' | ' +
        pad(posSize, 5) +
        ' | ' +
        pad(polSkill, 5) +
        ' | ' +
        pad(srcQual, 4) +
        ' | ' +
        pad(d.score?.toFixed(2) ?? '-', 5) +
        ' | ' +
        pad(d.positionSize ? `$${d.positionSize.toFixed(0)}` : '-', 6) +
        ' | ' +
        pad(`$${d.cashAfter.toFixed(0)}`, 7) +
        ' | ' +
        d.action
    )
  }

  // Summary line
  console.log('-'.repeat(160))
  const totalBuys = executedTrades.filter(d => d.action === 'BUY').length
  const totalSells = executedTrades.filter(d => d.action === 'SELL').length

  // Use netInvested (cost basis of open positions) from result
  console.log(
    `TOTAL: ${totalBuys} buys, ${totalSells} sells | Net Invested: $${result.netInvested.toFixed(0)} | Final Cash: $${result.finalCash.toFixed(0)} | Open: ${result.openPositions.length} positions`
  )

  // Score component legend
  console.log(
    '\nScore Components: Time=time_decay(w=0.30) | Price=price_movement(w=0.25) | Size=position_size(w=0.15) | Skill=politician_skill(w=0.20) | Src=source_quality(w=0.10)'
  )
}

function printPortfolioSummary(results: AgentResult[]): void {
  console.log('\n' + '═'.repeat(100))
  console.log('PORTFOLIO SUMMARY (After 45 days with $1000 starting budget)')
  console.log('═'.repeat(100))

  console.log(
    pad('Agent', 20, true) +
      ' | ' +
      pad('Trades', 8) +
      ' | ' +
      pad('Invested', 10) +
      ' | ' +
      pad('Open', 6) +
      ' | ' +
      pad('Cash', 10) +
      ' | ' +
      pad('Est. Value', 12)
  )
  console.log('-'.repeat(100))

  for (const r of results) {
    const buys = r.decisions.filter(d => d.action === 'BUY').length
    console.log(
      pad(`${r.agentName} (${r.agentId})`, 20, true) +
        ' | ' +
        pad(String(buys), 8) +
        ' | ' +
        pad(`$${r.netInvested.toFixed(0)}`, 10) +
        ' | ' +
        pad(String(r.openPositions.length), 6) +
        ' | ' +
        pad(`$${r.finalCash.toFixed(0)}`, 10) +
        ' | ' +
        pad(`$${r.estimatedValue.toFixed(0)}`, 12)
    )
  }

  // Open positions detail
  console.log('\n' + '─'.repeat(100))
  console.log('OPEN POSITIONS BY AGENT:')

  for (const r of results) {
    if (r.openPositions.length === 0) {
      console.log(`\n${r.agentName}: (no positions)`)
    } else {
      console.log(`\n${r.agentName} (${r.openPositions.length} positions):`)
      for (const p of r.openPositions) {
        console.log(
          `  ${p.ticker}: ${p.shares.toFixed(3)} shares @ $${p.entryPrice.toFixed(2)} = $${p.cost.toFixed(2)}`
        )
      }
    }
  }
}

// =============================================================================
// Tests
// =============================================================================

// =============================================================================
// CSV Export Function
// =============================================================================

/**
 * Print a single-row-per-decision CSV report for hadoku-site validation.
 * Includes all scoring components and decision details.
 */
function printCSVDecisionReport(result: AgentResult, filterName: string): void {
  console.log('\n' + '═'.repeat(200))
  console.log(`CSV DECISION REPORT: ${result.agentName} + ${filterName}`)
  console.log(
    `Total Decisions: ${result.decisions.length} | Executed: ${result.executed} | Skipped: ${result.skipped}`
  )
  console.log('═'.repeat(200))

  // CSV Header
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
    'time_decay_raw',
    'time_decay_w',
    'price_move_raw',
    'price_move_w',
    'pos_size_raw',
    'pos_size_w',
    'pol_skill_raw',
    'pol_skill_w',
    'src_qual_raw',
    'src_qual_w',
    'position_size_usd',
    'cash_before',
    'cash_after',
    'open_positions'
  ]
  console.log(headers.join(','))

  // CSV Rows
  let rowNum = 0
  for (const d of result.decisions) {
    rowNum++
    const b = d.breakdown

    const row = [
      rowNum,
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
      b?.time_decay.weight.toFixed(2) ?? '',
      b?.price_movement.raw.toFixed(4) ?? '',
      b?.price_movement.weight.toFixed(2) ?? '',
      b?.position_size.raw.toFixed(4) ?? '',
      b?.position_size.weight.toFixed(2) ?? '',
      b?.politician_skill.raw.toFixed(4) ?? '',
      b?.politician_skill.weight.toFixed(2) ?? '',
      b?.source_quality.raw.toFixed(4) ?? '',
      b?.source_quality.weight.toFixed(2) ?? '',
      d.positionSize?.toFixed(2) ?? '',
      d.cashBefore.toFixed(2),
      d.cashAfter.toFixed(2),
      d.positionCount
    ]
    console.log(row.join(','))
  }

  // Summary
  console.log('\n' + '-'.repeat(200))
  console.log(`SUMMARY: ${result.totalSignals} signals processed`)
  console.log(
    `  Executed: ${result.executed} (BUY: ${result.decisions.filter(d => d.action === 'BUY').length}, SELL: ${result.decisions.filter(d => d.action === 'SELL').length})`
  )
  console.log(`  Skipped: ${result.skipped}`)
  console.log(`  Net Invested: $${result.netInvested.toFixed(2)}`)
  console.log(`  Gross Buys: $${result.grossBuys.toFixed(2)}`)
  console.log(`  Sell Proceeds: $${result.sellProceeds.toFixed(2)}`)
  console.log(`  Final Cash: $${result.finalCash.toFixed(2)}`)
  console.log(`  Open Positions: ${result.openPositions.length}`)
}

/**
 * Run verification with a politician filter applied
 */
function runAgentVerificationWithFilter(
  config: AgentConfig,
  signals: SimSignal[],
  politicianFilter: Set<string> | null
): AgentResult {
  // Create a modified config with politician whitelist if filter provided
  const effectiveConfig = politicianFilter
    ? { ...config, politician_whitelist: [...politicianFilter] }
    : config

  return runAgentVerification(effectiveConfig, signals)
}

describe('45-Day Signal Verification', () => {
  it('should run ALL agents and produce verification report', () => {
    const signals = loadSignals45d()
    console.log(`\n${'='.repeat(100)}`)
    console.log(`LOADING: signals_45d.json`)
    console.log(`${'='.repeat(100)}`)
    console.log(`Total signals: ${signals.length}`)
    console.log(
      `Date range: ${signals[0]?.disclosure_date || 'N/A'} to ${signals[signals.length - 1]?.disclosure_date || 'N/A'}`
    )

    // Count by action
    const buys = signals.filter(s => s.action === 'buy').length
    const sells = signals.filter(s => s.action === 'sell').length
    console.log(`Buy signals: ${buys}, Sell signals: ${sells}`)

    // Count unique politicians
    const politicians = new Set(signals.map(s => s.politician_name))
    console.log(`Unique politicians: ${politicians.size}`)

    // Run all agents
    const results: AgentResult[] = []

    // ChatGPT (Decay Edge)
    console.log(`\n${'─'.repeat(100)}`)
    console.log(`Running ChatGPT (Decay Edge)...`)
    const chatgptResult = runAgentVerification(CHATGPT_CONFIG, signals)
    results.push(chatgptResult)
    printDecisionLog(chatgptResult)
    printScoringBreakdowns(chatgptResult)

    // Claude (Decay Alpha)
    console.log(`\n${'─'.repeat(100)}`)
    console.log(`Running Claude (Decay Alpha)...`)
    const claudeResult = runAgentVerification(CLAUDE_CONFIG, signals)
    results.push(claudeResult)
    printDecisionLog(claudeResult)
    printScoringBreakdowns(claudeResult)

    // Gemini (Titan Conviction)
    console.log(`\n${'─'.repeat(100)}`)
    console.log(`Running Gemini (Titan Conviction)...`)
    const geminiResult = runAgentVerification(GEMINI_CONFIG, signals)
    results.push(geminiResult)
    printDecisionLog(geminiResult)

    // Naive (control)
    console.log(`\n${'─'.repeat(100)}`)
    console.log(`Running Naive (Monkey Trader) for comparison...`)
    const naiveResult = runAgentVerification(NAIVE_CONFIG, signals)
    results.push(naiveResult)

    // Portfolio summary
    printPortfolioSummary(results)

    // Basic assertions
    expect(signals.length).toBeGreaterThan(0)
    expect(chatgptResult.decisions.length).toBeGreaterThan(0)
    expect(claudeResult.decisions.length).toBeGreaterThan(0)
  })

  it('should verify ChatGPT scoring consistency', () => {
    const signals = loadSignals45d()
    const result = runAgentVerification(CHATGPT_CONFIG, signals)

    // Verify all executed trades have valid scores
    const executedTrades = result.decisions.filter(d => d.action === 'BUY')

    for (const trade of executedTrades) {
      expect(trade.score).not.toBeNull()
      expect(trade.score).toBeGreaterThanOrEqual(CHATGPT_CONFIG.execute_threshold)
      expect(trade.breakdown).not.toBeNull()

      // Verify breakdown components
      if (trade.breakdown) {
        expect(trade.breakdown.time_decay.weight).toBe(0.3)
        expect(trade.breakdown.price_movement.weight).toBe(0.25)
        expect(trade.breakdown.position_size.weight).toBe(0.15)
        expect(trade.breakdown.politician_skill.weight).toBe(0.2)
        expect(trade.breakdown.source_quality.weight).toBe(0.1)
      }
    }

    console.log(`\nVerified ${executedTrades.length} ChatGPT trades have consistent scoring`)
  })

  it('should produce condensed trades report (ChatGPT only)', () => {
    const signals = loadSignals45d()

    console.log(`\n${'═'.repeat(100)}`)
    console.log(`CONDENSED TRADE REPORT - ChatGPT (Decay Edge)`)
    console.log(`${'═'.repeat(100)}`)
    console.log(`Signals loaded: ${signals.length}`)

    const result = runAgentVerification(CHATGPT_CONFIG, signals)
    printCondensedTradesReport(result)

    // Also show open positions
    console.log(`\n${'─'.repeat(100)}`)
    console.log(`OPEN POSITIONS (${result.openPositions.length}):`)
    console.log('-'.repeat(100))
    for (const p of result.openPositions) {
      console.log(
        `  ${pad(p.ticker, 6, true)} | ${p.shares.toFixed(4)} shares @ $${p.entryPrice.toFixed(2)} = $${p.cost.toFixed(2)}`
      )
    }

    expect(result.decisions.length).toBeGreaterThan(0)
  })

  it('should produce condensed trades report (ALL agents)', () => {
    const signals = loadSignals45d()

    console.log(`\n${'═'.repeat(100)}`)
    console.log(`CONDENSED TRADE REPORT - ALL AGENTS`)
    console.log(`${'═'.repeat(100)}`)
    console.log(`Signals loaded: ${signals.length}`)

    // ChatGPT
    const chatgptResult = runAgentVerification(CHATGPT_CONFIG, signals)
    printCondensedTradesReport(chatgptResult)

    // Claude
    const claudeResult = runAgentVerification(CLAUDE_CONFIG, signals)
    printCondensedTradesReport(claudeResult)

    // Gemini
    const geminiResult = runAgentVerification(GEMINI_CONFIG, signals)
    printCondensedTradesReport(geminiResult)

    // Portfolio comparison
    console.log(`\n${'═'.repeat(100)}`)
    console.log(`PORTFOLIO COMPARISON`)
    console.log('═'.repeat(100))
    console.log(
      pad('Agent', 25, true) +
        ' | ' +
        pad('Buys', 5) +
        ' | ' +
        pad('Sells', 5) +
        ' | ' +
        pad('Invested', 10) +
        ' | ' +
        pad('Cash', 8) +
        ' | ' +
        pad('Positions', 10)
    )
    console.log('-'.repeat(100))

    for (const r of [chatgptResult, claudeResult, geminiResult]) {
      const buys = r.decisions.filter(d => d.action === 'BUY').length
      const sells = r.decisions.filter(d => d.action === 'SELL').length
      console.log(
        pad(`${r.agentName} (${r.agentId})`, 25, true) +
          ' | ' +
          pad(String(buys), 5) +
          ' | ' +
          pad(String(sells), 5) +
          ' | ' +
          pad(`$${r.netInvested.toFixed(0)}`, 10) +
          ' | ' +
          pad(`$${r.finalCash.toFixed(0)}`, 8) +
          ' | ' +
          pad(String(r.openPositions.length), 10)
      )
    }

    expect(chatgptResult.decisions.length).toBeGreaterThan(0)
  })

  it('should produce ChatGPT+Top10 CSV decision report for hadoku-site validation', () => {
    // Load 3-year historical data to compute Top 10 politician filter
    console.log(`\n${'═'.repeat(100)}`)
    console.log(`CHATGPT + TOP 10 DECISION REPORT FOR HADOKU-SITE VALIDATION`)
    console.log(`${'═'.repeat(100)}`)

    console.log('\nStep 1: Loading 3-year historical data to compute Top 10 filter...')
    const historicalSignals = loadSignalsFromExport() as RawSignal[]
    console.log(`  Loaded ${historicalSignals.length} historical signals`)

    // Build politician filters from historical data
    console.log('\nStep 2: Computing politician filters...')
    const filters = buildPoliticianFilters(historicalSignals)
    const top10Filter = filters.find(f => f.name === 'Top 10')

    if (!top10Filter) {
      throw new Error('Could not compute Top 10 filter from historical data')
    }

    console.log(`  Top 10 Politicians (min 15 trades, sorted by annualized return):`)
    for (const name of top10Filter.politicians) {
      console.log(`    - ${name}`)
    }
    console.log(`  Signals per month with Top 10 filter: ${top10Filter.signalsPerMonth.toFixed(1)}`)

    // Load 45-day signals
    console.log('\nStep 3: Loading 45-day signals...')
    const signals45d = loadSignals45d()
    console.log(`  Loaded ${signals45d.length} signals from signals_45d.json`)

    // Count how many signals match the Top 10 filter
    const matchingSignals = signals45d.filter(s => top10Filter.politicians.has(s.politician_name))
    console.log(`  Signals from Top 10 politicians: ${matchingSignals.length}`)

    // Run ChatGPT with Top 10 filter
    console.log('\nStep 4: Running ChatGPT agent with Top 10 politician filter...')
    const result = runAgentVerificationWithFilter(
      CHATGPT_CONFIG,
      signals45d,
      top10Filter.politicians
    )

    // Print the CSV decision report
    printCSVDecisionReport(result, 'Top 10')

    // Also print open positions
    if (result.openPositions.length > 0) {
      console.log(`\nOPEN POSITIONS (${result.openPositions.length}):`)
      for (const p of result.openPositions) {
        console.log(
          `  ${p.ticker}: ${p.shares.toFixed(4)} shares @ $${p.entryPrice.toFixed(2)} = $${p.cost.toFixed(2)}`
        )
      }
    }

    expect(result.decisions.length).toBeGreaterThan(0)
  })
})
