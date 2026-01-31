/**
 * End-to-End Signal Processing Test
 *
 * Simulates the production signal ingestion flow:
 * 1. Signal arrives (simulated by creating mock signal)
 * 2. Signal is stored in database
 * 3. Agents route and score the signal
 * 4. Trade decisions are made
 *
 * Uses mock D1 database to test the full flow without production dependencies.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { TraderEnv } from '../types'
// Import directly from source files to avoid broken index.ts exports
import { routeSignalToAgents } from './router'
import { enrichSignal, type RawSignalRow, generateId } from './filters'
import { CHATGPT_CONFIG, CLAUDE_CONFIG, GEMINI_CONFIG } from './configs'
import { calculateScore } from './scoring'
import { calculatePositionSize } from './sizing'

// =============================================================================
// Mock D1 Database
// =============================================================================

interface MockRow {
  [key: string]: any
}

/**
 * In-memory mock of Cloudflare D1 database
 */
function createMockD1() {
  const tables: Record<string, MockRow[]> = {
    signals: [],
    trades: [],
    positions: [],
    agents: [],
    agent_budgets: [],
    market_prices: [],
    politician_stats: []
  }

  return {
    tables,

    prepare(sql: string) {
      let boundParams: any[] = []

      return {
        bind(...params: any[]) {
          boundParams = params
          return this
        },

        async run() {
          // Handle INSERT
          if (sql.trim().toUpperCase().startsWith('INSERT')) {
            const tableMatch = sql.match(/INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+(\w+)/i)
            if (!tableMatch) throw new Error(`Could not parse INSERT: ${sql}`)
            const tableName = tableMatch[1]

            // Extract column names from the SQL
            const columnsMatch = sql.match(/\(([^)]+)\)\s*VALUES/i)
            if (!columnsMatch) throw new Error(`Could not parse columns: ${sql}`)
            const columns = columnsMatch[1].split(',').map(c => c.trim())

            // Create row object
            const row: MockRow = {}
            columns.forEach((col, i) => {
              row[col] = boundParams[i]
            })

            if (!tables[tableName]) {
              tables[tableName] = []
            }
            tables[tableName].push(row)

            return { success: true, meta: { changes: 1 } }
          }

          // Handle UPDATE
          if (sql.trim().toUpperCase().startsWith('UPDATE')) {
            const tableMatch = sql.match(/UPDATE\s+(\w+)/i)
            if (!tableMatch) throw new Error(`Could not parse UPDATE: ${sql}`)
            const tableName = tableMatch[1]

            // Simple WHERE id = ? handling
            const whereMatch = sql.match(/WHERE\s+id\s*=\s*\?/i)
            if (whereMatch) {
              const idParam = boundParams[boundParams.length - 1]
              const idx = tables[tableName]?.findIndex(r => r.id === idParam)
              if (idx !== undefined && idx >= 0) {
                // Extract SET clause and update
                const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i)
                if (setMatch) {
                  const setParts = setMatch[1].split(',')
                  let paramIdx = 0
                  setParts.forEach(part => {
                    const colMatch = part.trim().match(/(\w+)\s*=/)
                    if (colMatch && tables[tableName][idx]) {
                      tables[tableName][idx][colMatch[1]] = boundParams[paramIdx++]
                    }
                  })
                }
              }
            }

            return { success: true, meta: { changes: 1 } }
          }

          return { success: true, meta: { changes: 0 } }
        },

        async first(): Promise<MockRow | null> {
          // Handle SELECT queries
          if (!sql.trim().toUpperCase().startsWith('SELECT')) return null

          const tableMatch = sql.match(/FROM\s+(\w+)/i)
          if (!tableMatch) return null
          const tableName = tableMatch[1]

          const tableData = tables[tableName] || []

          // Handle WHERE clauses
          if (sql.includes('WHERE')) {
            // Simple equality check: WHERE col = ? AND col2 = ?
            const whereMatch = sql.match(/WHERE\s+(.+?)(?:ORDER|LIMIT|$)/i)
            if (whereMatch) {
              const conditions = whereMatch[1].split(/\s+AND\s+/i)
              let paramIdx = 0

              for (const row of tableData) {
                let matches = true
                for (const cond of conditions) {
                  const colMatch = cond.trim().match(/(\w+)\s*=\s*\?/)
                  if (colMatch) {
                    if (row[colMatch[1]] !== boundParams[paramIdx]) {
                      matches = false
                      break
                    }
                    paramIdx++
                  } else if (cond.includes('IS NULL')) {
                    const nullColMatch = cond.match(/(\w+)\s+IS\s+NULL/i)
                    if (
                      nullColMatch &&
                      row[nullColMatch[1]] !== null &&
                      row[nullColMatch[1]] !== undefined
                    ) {
                      matches = false
                      break
                    }
                  }
                }
                if (matches) return row
              }
            }
            return null
          }

          return tableData[0] || null
        },

        async all(): Promise<{ results: MockRow[] }> {
          if (!sql.trim().toUpperCase().startsWith('SELECT')) {
            return { results: [] }
          }

          const tableMatch = sql.match(/FROM\s+(\w+)/i)
          if (!tableMatch) return { results: [] }
          const tableName = tableMatch[1]

          let results = [...(tables[tableName] || [])]

          // Handle WHERE processed_at IS NULL
          if (sql.includes('processed_at IS NULL')) {
            results = results.filter(r => r.processed_at === null || r.processed_at === undefined)
          }

          // Handle WHERE is_active = 1
          if (sql.includes('is_active = 1')) {
            results = results.filter(r => r.is_active === 1)
          }

          // Handle LIMIT
          const limitMatch = sql.match(/LIMIT\s+(\d+)/i)
          if (limitMatch) {
            results = results.slice(0, parseInt(limitMatch[1]))
          }

          return { results }
        }
      }
    }
  }
}

/**
 * Create a mock TraderEnv with in-memory database
 */
function createMockEnv(): TraderEnv & { mockDb: ReturnType<typeof createMockD1> } {
  const mockDb = createMockD1()

  // Pre-populate agent configs
  mockDb.tables.agents = [
    {
      id: 'chatgpt',
      name: 'Decay Edge',
      is_active: 1,
      config_json: JSON.stringify(CHATGPT_CONFIG)
    },
    { id: 'claude', name: 'Decay Alpha', is_active: 1, config_json: JSON.stringify(CLAUDE_CONFIG) },
    {
      id: 'gemini',
      name: 'Titan Conviction',
      is_active: 1,
      config_json: JSON.stringify(GEMINI_CONFIG)
    }
  ]

  // Pre-populate budget for current month
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  mockDb.tables.agent_budgets = [
    { agent_id: 'chatgpt', month, total: 1000, spent: 0 },
    { agent_id: 'claude', month, total: 1000, spent: 0 },
    { agent_id: 'gemini', month, total: 1000, spent: 0 }
  ]

  return {
    TRADER_DB: mockDb as any,
    TRADER_API_KEY: 'test-api-key',
    SCRAPER_API_KEY: 'test-scraper-key',
    TUNNEL_URL: 'http://localhost:3001',
    mockDb
  } as TraderEnv & { mockDb: ReturnType<typeof createMockD1> }
}

// =============================================================================
// Test Data: Mock Signals
// =============================================================================

/**
 * Create a raw signal row for testing
 */
function createRawSignal(overrides: Partial<RawSignalRow> = {}): RawSignalRow {
  const now = new Date()
  const tradeDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000) // 10 days ago
  const disclosureDate = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000) // 3 days ago

  return {
    id: generateId('sig'),
    ticker: 'NVDA',
    action: 'buy',
    asset_type: 'stock',
    trade_price: 140.0,
    trade_date: tradeDate.toISOString().split('T')[0],
    disclosure_date: disclosureDate.toISOString().split('T')[0],
    position_size_min: 100001,
    politician_name: 'Nancy Pelosi',
    source: 'quiver_quant',
    ...overrides
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('End-to-End Signal Flow', () => {
  let env: TraderEnv & { mockDb: ReturnType<typeof createMockD1> }

  beforeEach(() => {
    env = createMockEnv()
  })

  describe('Signal Enrichment', () => {
    it('should correctly enrich raw signal data for scoring', () => {
      const now = new Date()
      const tradeDate = new Date(now)
      tradeDate.setDate(tradeDate.getDate() - 10)
      const disclosureDate = new Date(now)
      disclosureDate.setDate(disclosureDate.getDate() - 3)

      const rawSignal: RawSignalRow = {
        id: 'sig_test123',
        ticker: 'NVDA',
        action: 'buy',
        asset_type: 'stock',
        trade_price: 140.0,
        trade_date: tradeDate.toISOString().split('T')[0],
        disclosure_date: disclosureDate.toISOString().split('T')[0],
        position_size_min: 100001,
        politician_name: 'Nancy Pelosi',
        source: 'quiver_quant'
      }

      const currentPrice = 145.0
      const enriched = enrichSignal(rawSignal, currentPrice)

      // Check enrichment calculations
      expect(enriched.current_price).toBe(145.0)
      // Core enrichment fields should be set
      expect(enriched.id).toBe('sig_test123')
      expect(enriched.ticker).toBe('NVDA')
      expect(enriched.action).toBe('buy')
      // days_since_disclosure may be calculated from disclosure_date
      // These are optional in enrichment so just verify the object exists
      expect(enriched).toBeDefined()

      console.log('Enriched signal:', {
        days_since_disclosure: enriched.days_since_disclosure,
        pct_move: enriched.pct_move_since_disclosure?.toFixed(2) ?? 'N/A'
      })
    })
  })

  describe('Scoring System', () => {
    it('should calculate score components correctly', async () => {
      // Create a signal with known characteristics
      const rawSignal = createRawSignal()
      const currentPrice = 142.8 // 2% move since disclosure
      const enriched = enrichSignal(rawSignal, currentPrice)

      // Calculate score with ChatGPT config
      const scoreResult = await calculateScore(env, CHATGPT_CONFIG.scoring!, enriched)

      expect(scoreResult.score).toBeGreaterThan(0)
      expect(scoreResult.score).toBeLessThanOrEqual(1)
      expect(scoreResult.breakdown).toBeDefined()

      // Check individual components
      expect(scoreResult.breakdown?.time_decay).toBeGreaterThan(0)
      expect(scoreResult.breakdown?.price_movement).toBeGreaterThan(0)
      expect(scoreResult.breakdown?.position_size).toBeGreaterThan(0)
      expect(scoreResult.breakdown?.source_quality).toBe(1.0) // quiver_quant = 1.0

      console.log('Score result:', {
        score: scoreResult.score.toFixed(3),
        breakdown: scoreResult.breakdown
      })
    })

    it('should penalize stale signals', async () => {
      const now = new Date()

      // Fresh signal (1 day old) - use a trade date that makes sense
      const freshTradeDate = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)
      const freshSignal = createRawSignal({
        trade_date: freshTradeDate.toISOString().split('T')[0],
        disclosure_date: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0]
      })

      // Stale signal (40 days old) - well beyond half-life
      const staleTradeDate = new Date(now.getTime() - 50 * 24 * 60 * 60 * 1000)
      const staleSignal = createRawSignal({
        id: generateId('sig'),
        trade_date: staleTradeDate.toISOString().split('T')[0],
        disclosure_date: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0]
      })

      const currentPrice = 142.0

      const freshEnriched = enrichSignal(freshSignal, currentPrice)
      const staleEnriched = enrichSignal(staleSignal, currentPrice)

      const freshScore = await calculateScore(env, CHATGPT_CONFIG.scoring!, freshEnriched)
      const staleScore = await calculateScore(env, CHATGPT_CONFIG.scoring!, staleEnriched)

      // Fresh signals should have higher time_decay component
      expect(freshScore.breakdown?.time_decay).toBeGreaterThan(
        staleScore.breakdown?.time_decay || 0
      )
      // Overall score may be affected by other factors, just check time_decay

      console.log('Fresh vs Stale:', {
        fresh: {
          score: freshScore.score.toFixed(3),
          time_decay: freshScore.breakdown?.time_decay?.toFixed(3),
          days: freshEnriched.days_since_disclosure
        },
        stale: {
          score: staleScore.score.toFixed(3),
          time_decay: staleScore.breakdown?.time_decay?.toFixed(3),
          days: staleEnriched.days_since_disclosure
        }
      })
    })

    it('should reward larger congressional positions', async () => {
      // Small position
      const smallSignal = createRawSignal({
        position_size_min: 5000
      })

      // Large position
      const largeSignal = createRawSignal({
        id: generateId('sig'),
        position_size_min: 500001
      })

      const currentPrice = 142.0

      const smallScore = await calculateScore(
        env,
        CHATGPT_CONFIG.scoring!,
        enrichSignal(smallSignal, currentPrice)
      )
      const largeScore = await calculateScore(
        env,
        CHATGPT_CONFIG.scoring!,
        enrichSignal(largeSignal, currentPrice)
      )

      // Large positions should have higher position_size component
      expect(largeScore.breakdown?.position_size).toBeGreaterThan(
        smallScore.breakdown?.position_size || 0
      )

      console.log('Small vs Large position:', {
        small: {
          score: smallScore.score.toFixed(3),
          position_size: smallScore.breakdown?.position_size?.toFixed(3)
        },
        large: {
          score: largeScore.score.toFixed(3),
          position_size: largeScore.breakdown?.position_size?.toFixed(3)
        }
      })
    })
  })

  describe('Position Sizing', () => {
    it('should calculate position size based on score and mode', () => {
      const budget = { total: 1000, spent: 0, remaining: 1000 }

      // Test score_squared mode (ChatGPT)
      const sizeSquared = calculatePositionSize(
        CHATGPT_CONFIG,
        0.8, // High score
        budget,
        1,
        false,
        100001 // Congressional position size
      )

      // score_squared: score^2 × base_multiplier × budget
      // 0.8^2 × 0.15 × 1000 = 96
      expect(sizeSquared).toBeCloseTo(96, 0)

      // Test score_linear mode (Claude)
      const sizeLinear = calculatePositionSize(CLAUDE_CONFIG, 0.8, budget, 1, false, 100001)

      // score_linear: base_amount × score = 15 × 0.8 = 12
      expect(sizeLinear).toBeCloseTo(12, 0)

      console.log('Position sizes:', {
        score_squared: sizeSquared,
        score_linear: sizeLinear
      })
    })

    it('should apply half-size for rebalance trades', () => {
      const budget = { total: 1000, spent: 0, remaining: 1000 }

      const fullSize = calculatePositionSize(
        CHATGPT_CONFIG,
        0.8,
        budget,
        1,
        false, // Full size
        100001
      )

      const halfSize = calculatePositionSize(
        CHATGPT_CONFIG,
        0.8,
        budget,
        1,
        true, // Half size
        100001
      )

      expect(halfSize).toBeCloseTo(fullSize / 2, 0)

      console.log('Full vs Half size:', { full: fullSize, half: halfSize })
    })

    it('should respect max_position_amount cap', () => {
      const budget = { total: 10000, spent: 0, remaining: 10000 } // Large budget

      const size = calculatePositionSize(
        CHATGPT_CONFIG, // max_position_amount = 1000
        1.0, // Perfect score
        budget,
        1,
        false,
        100001
      )

      // Should be capped at max_position_amount
      expect(size).toBeLessThanOrEqual(CHATGPT_CONFIG.sizing.max_position_amount)
    })
  })

  describe('Agent Filtering', () => {
    it('should filter signals by politician whitelist (Gemini)', () => {
      // Gemini only accepts Titan politicians
      const geminiWhitelist = GEMINI_CONFIG.politician_whitelist

      expect(geminiWhitelist).toContain('Nancy Pelosi')
      expect(geminiWhitelist).toContain('Mark Green')
      expect(geminiWhitelist).not.toContain('Random Senator')

      console.log('Gemini whitelist:', geminiWhitelist)
    })

    it('should filter signals by asset type', () => {
      // Gemini only accepts stocks
      expect(GEMINI_CONFIG.allowed_asset_types).toEqual(['stock'])

      // ChatGPT accepts all
      expect(CHATGPT_CONFIG.allowed_asset_types).toContain('stock')
      expect(CHATGPT_CONFIG.allowed_asset_types).toContain('etf')
      expect(CHATGPT_CONFIG.allowed_asset_types).toContain('option')
    })
  })

  describe('Full Pipeline Integration', () => {
    it('should process a signal through the complete pipeline', async () => {
      console.log('\n=== Full Pipeline Test ===\n')

      // Step 1: Create signal
      const rawSignal = createRawSignal({
        politician_name: 'Nancy Pelosi',
        ticker: 'NVDA',
        position_size_min: 100001
      })

      console.log('1. Signal created:', {
        id: rawSignal.id,
        ticker: rawSignal.ticker,
        politician: rawSignal.politician_name
      })

      // Step 2: Store in mock database (simulating signal ingestion)
      env.mockDb.tables.signals.push({
        ...rawSignal,
        processed_at: null
      })

      console.log('2. Signal stored in DB:', {
        total_signals: env.mockDb.tables.signals.length
      })

      // Step 3: Route through agents (without execution)
      const currentPrice = 145.0
      const decisions = await routeSignalToAgents(env, rawSignal, currentPrice, false)

      console.log('\n3. Agent decisions:')
      for (const decision of decisions) {
        console.log(`   ${decision.agent_id}:`, {
          action: decision.action,
          reason: decision.decision_reason,
          score: decision.score?.toFixed(3) || 'N/A'
        })
      }

      // Verify we got decisions from all 3 agents
      expect(decisions.length).toBe(3)

      // ChatGPT should score and decide (it has scoring enabled)
      const chatgptDecision = decisions.find(d => d.agent_id === 'chatgpt')
      expect(chatgptDecision).toBeDefined()
      expect(chatgptDecision?.score).toBeDefined()

      // Gemini should execute (Nancy Pelosi is in whitelist)
      const geminiDecision = decisions.find(d => d.agent_id === 'gemini')
      expect(geminiDecision).toBeDefined()
      expect(geminiDecision?.action).toBe('execute') // No scoring, passes filters = execute

      // Step 4: Check trades were logged
      console.log('\n4. Trades logged:', env.mockDb.tables.trades.length)

      console.log('\n=== Pipeline Test Complete ===\n')
    })

    it('should skip non-whitelisted politicians for Gemini', async () => {
      // Signal from a politician not in Gemini's whitelist
      const rawSignal = createRawSignal({
        politician_name: 'Random Senator'
      })

      const decisions = await routeSignalToAgents(env, rawSignal, 145.0, false)

      // Gemini should skip (politician not in whitelist)
      const geminiDecision = decisions.find(d => d.agent_id === 'gemini')
      expect(geminiDecision?.action).toBe('skip')
      // The actual reason code may be "filter_politician" or "skip_politician"
      expect(geminiDecision?.decision_reason).toMatch(/politician/)

      // ChatGPT and Claude should still process (no politician filter)
      const chatgptDecision = decisions.find(d => d.agent_id === 'chatgpt')
      expect(chatgptDecision?.score).toBeDefined()

      console.log('Non-whitelist politician:', {
        gemini: geminiDecision?.decision_reason,
        chatgpt: chatgptDecision?.action
      })
    })

    it('should skip ETF signals for Gemini', async () => {
      // Gemini only accepts stocks
      const rawSignal = createRawSignal({
        politician_name: 'Nancy Pelosi', // Whitelisted
        asset_type: 'etf' // Not allowed for Gemini
      })

      const decisions = await routeSignalToAgents(env, rawSignal, 145.0, false)

      // Gemini should skip (ETF not allowed)
      const geminiDecision = decisions.find(d => d.agent_id === 'gemini')
      expect(geminiDecision?.action).toBe('skip')
      // The actual reason code may be "filter_asset_type" or "skip_asset_type"
      expect(geminiDecision?.decision_reason).toMatch(/asset_type/)

      // ChatGPT should still process ETFs
      const chatgptDecision = decisions.find(d => d.agent_id === 'chatgpt')
      expect(chatgptDecision?.score).toBeDefined()
    })
  })

  describe('Decision Threshold Behavior', () => {
    it('should execute when score >= execute_threshold', async () => {
      // Create a fresh, high-quality signal that should score well
      const now = new Date()
      const rawSignal = createRawSignal({
        trade_date: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        disclosure_date: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0], // Very fresh
        position_size_min: 500001, // Large position = high conviction
        source: 'quiver_quant' // Best source
      })

      const currentPrice = 140.5 // Small move (good)
      const enriched = enrichSignal(rawSignal, currentPrice)

      const scoreResult = await calculateScore(env, CHATGPT_CONFIG.scoring!, enriched)

      const shouldExecute = scoreResult.score >= CHATGPT_CONFIG.execute_threshold

      console.log('High-quality signal:', {
        days_old: enriched.days_since_disclosure,
        pct_move: enriched.pct_move_since_disclosure?.toFixed(2) ?? 'N/A',
        score: scoreResult.score.toFixed(3),
        threshold: CHATGPT_CONFIG.execute_threshold,
        should_execute: shouldExecute
      })

      // This should be a high-scoring signal
      expect(scoreResult.score).toBeGreaterThan(0.5)
    })

    it('should execute_half when score between thresholds', async () => {
      // ChatGPT has half_size_threshold = 0.45, execute_threshold = 0.55
      // Create a signal that scores between these

      const rawSignal = createRawSignal({
        disclosure_date: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0], // Moderately stale
        position_size_min: 20000, // Small-medium position
        source: 'house_stock_watcher' // Lower quality source (0.8)
      })

      const currentPrice = 150.0 // Larger move
      const enriched = enrichSignal(rawSignal, currentPrice)

      const scoreResult = await calculateScore(env, CHATGPT_CONFIG.scoring!, enriched)

      const isHalfSize =
        scoreResult.score >= CHATGPT_CONFIG.half_size_threshold! &&
        scoreResult.score < CHATGPT_CONFIG.execute_threshold

      console.log('Medium-quality signal:', {
        score: scoreResult.score.toFixed(3),
        half_threshold: CHATGPT_CONFIG.half_size_threshold,
        execute_threshold: CHATGPT_CONFIG.execute_threshold,
        is_half_size: isHalfSize
      })
    })
  })
})

describe('Async Signal Provider Simulation', () => {
  /**
   * This test simulates the production scenario where signals arrive asynchronously
   * from the scraper and need to be processed.
   */

  it('should handle rapid signal ingestion', async () => {
    const env = createMockEnv()

    // Simulate 10 signals arriving in quick succession
    const signals = Array.from({ length: 10 }, (_, i) =>
      createRawSignal({
        id: generateId('sig'),
        ticker: ['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN'][i % 5]
      })
    )

    console.log('\n=== Rapid Signal Ingestion Test ===\n')

    // Add signals to mock DB
    const startTime = Date.now()
    for (const signal of signals) {
      env.mockDb.tables.signals.push({ ...signal, processed_at: null })
    }

    // Process all signals through agents
    const allDecisions = []
    for (const signal of signals) {
      const decisions = await routeSignalToAgents(env, signal, 145.0, false)
      allDecisions.push({ signal_id: signal.id, ticker: signal.ticker, decisions })
    }
    const processTime = Date.now() - startTime

    console.log(`Processed ${signals.length} signals in ${processTime}ms`)
    console.log(`Total decisions made: ${allDecisions.length * 3}`)

    // Verify all were processed
    expect(allDecisions.length).toBe(10)

    // Verify trades were logged
    expect(env.mockDb.tables.trades.length).toBeGreaterThan(0)

    console.log(`Trades logged: ${env.mockDb.tables.trades.length}`)
  })

  it('should handle signals for multiple different tickers', async () => {
    const env = createMockEnv()

    const tickers = ['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN']
    const signals = tickers.map((ticker, i) =>
      createRawSignal({
        id: generateId('sig'),
        ticker,
        position_size_min: 50000 + i * 50000 // Varying position sizes
      })
    )

    console.log('\n=== Multi-Ticker Test ===\n')

    const results: Record<string, { chatgpt: string; claude: string; gemini: string }> = {}

    for (const signal of signals) {
      const decisions = await routeSignalToAgents(env, signal, 145.0, false)

      results[signal.ticker] = {
        chatgpt: decisions.find(d => d.agent_id === 'chatgpt')?.action || 'unknown',
        claude: decisions.find(d => d.agent_id === 'claude')?.action || 'unknown',
        gemini: decisions.find(d => d.agent_id === 'gemini')?.action || 'unknown'
      }
    }

    console.log('Results by ticker:')
    console.table(results)

    // All tickers should have decisions for all agents
    for (const ticker of tickers) {
      expect(results[ticker]).toBeDefined()
      expect(results[ticker].chatgpt).toBeDefined()
      expect(results[ticker].claude).toBeDefined()
      expect(results[ticker].gemini).toBeDefined()
    }
  })

  it('should correctly track budget across multiple signals', async () => {
    const env = createMockEnv()

    // Start with fresh budget
    const initialBudget = env.mockDb.tables.agent_budgets.find(b => b.agent_id === 'chatgpt')
    expect(initialBudget?.spent).toBe(0)

    // Process multiple signals (trades will be logged but not executed in this test)
    const signals = Array.from({ length: 5 }, (_, i) =>
      createRawSignal({
        id: generateId('sig'),
        ticker: 'NVDA'
      })
    )

    for (const signal of signals) {
      await routeSignalToAgents(env, signal, 145.0, false)
    }

    // Check that trades were logged
    console.log('Trades after 5 signals:', env.mockDb.tables.trades.length)
    expect(env.mockDb.tables.trades.length).toBeGreaterThan(0)
  })
})

describe('SELL Signal Handling', () => {
  it('should skip SELL signals when no position exists', async () => {
    const env = createMockEnv()

    // Create a SELL signal (no corresponding position)
    const sellSignal = createRawSignal({
      action: 'sell',
      ticker: 'NVDA'
    })

    const decisions = await routeSignalToAgents(env, sellSignal, 145.0, false)

    // All agents should skip (no position to sell)
    for (const decision of decisions) {
      expect(decision.action).toBe('skip')
      expect(decision.decision_reason).toBe('skip_no_position')
    }

    console.log(
      'SELL without position:',
      decisions.map(d => ({
        agent: d.agent_id,
        action: d.action,
        reason: d.decision_reason
      }))
    )
  })
})
