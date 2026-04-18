/**
 * Central Trading Configuration
 *
 * All tunable trading parameters in one place.
 * Modify these settings to adjust trading behavior without touching agent configs.
 */

// =============================================================================
// MASTER SWITCHES
// =============================================================================

/**
 * ENABLE TRADING
 * Master kill switch. When false, no trades will be attempted at all.
 * Signals will still be processed and scored, but execution is blocked.
 */
export const ENABLE_TRADING = true

// =============================================================================
// EXECUTION SETTINGS
// =============================================================================

/**
 * Enable fractional shares
 * - true: Buy partial shares (e.g., 2.5 shares)
 * - false: Round down to whole shares only
 *
 * Fidelity's equity order form accepts decimal quantities directly in the
 * #eqt-shared-quantity input (verified via DOM probe: 0.5 and 2.5 stick
 * after input+blur, no validation wipe). Prior silent truncation was an
 * artifact of our Python-side str(int(quantity)) cast, now fixed to
 * format as decimal with trailing zeros stripped.
 */
export const ENABLE_FRACTIONAL_SHARES = true

/**
 * Minimum position age before selling (in days)
 * For long-term capital gains, positions must be held > 365 days
 */
export const MIN_POSITION_AGE_DAYS = 365

// =============================================================================
// SIGNAL PROCESSING
// =============================================================================

/**
 * Process signals immediately when received
 * - true: Route to agents and execute trades immediately
 * - false: Store signals for batch processing later
 */
export const PROCESS_SIGNALS_IMMEDIATELY = true

/**
 * Maximum signals to process per batch
 * Prevents overwhelming the system during large backfills
 */
export const MAX_SIGNALS_PER_BATCH = 100

// =============================================================================
// BUDGET & LIMITS
// =============================================================================

/**
 * Default monthly budget per agent (in USD)
 */
export const DEFAULT_MONTHLY_BUDGET = 1000

/**
 * Maximum fraction of monthly_budget that can be committed across all
 * trades for a given agent+month. The complement (1 - SPEND_CAP_PCT) is
 * always retained as a safety buffer against:
 *  - calculateShares rounding overshoot between sizing and fill
 *  - price drift between our cached current_price and Fidelity's fill
 *  - Fidelity's own 030910 "orders > 95% of Cash Available to Trade"
 *    rule for market orders entered outside regular hours
 * Enforced in getAgentBudget (budget.remaining returns
 * max(0, total_budget × SPEND_CAP_PCT − spent)) so every consumer of
 * budget.remaining — sizing, UI, dashboards — sees the capped number.
 */
export const SPEND_CAP_PCT = 0.99

/**
 * Budget reset day of month (1-28)
 * On this day, agent budgets reset to their monthly allocation
 */
export const BUDGET_RESET_DAY = 1

// =============================================================================
// LOGGING & DEBUGGING
// =============================================================================

/**
 * Enable detailed decision logging
 * Logs full reasoning chain for each trade decision
 */
export const ENABLE_DECISION_LOGGING = true

/**
 * Log API calls to Fidelity
 * Useful for debugging but may contain sensitive data
 */
export const LOG_API_CALLS = false

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Is this invocation a dry run?
 * Live trading requires ENABLE_LIVE_TRADING=true in the env AND the
 * ENABLE_TRADING kill switch on. Anything else is a dry run — the trade
 * gets previewed but no real order is submitted to Fidelity.
 */
export function isDryRun(env?: { ENABLE_LIVE_TRADING?: string }): boolean {
  if (!ENABLE_TRADING) return true
  return env?.ENABLE_LIVE_TRADING !== 'true'
}

/**
 * Get trading config summary for logging
 */
export function getTradingConfigSummary(env?: {
  ENABLE_LIVE_TRADING?: string
}): Record<string, unknown> {
  return {
    enable_trading: ENABLE_TRADING,
    dry_run: isDryRun(env),
    fractional_shares: ENABLE_FRACTIONAL_SHARES,
    min_position_age_days: MIN_POSITION_AGE_DAYS,
    process_immediately: PROCESS_SIGNALS_IMMEDIATELY,
    max_signals_per_batch: MAX_SIGNALS_PER_BATCH,
    monthly_budget: DEFAULT_MONTHLY_BUDGET
  }
}
