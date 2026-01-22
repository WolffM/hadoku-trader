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
 * DRY RUN MODE
 * - true: All trades are simulated, no real orders placed
 * - false: Live trading enabled, real orders will execute
 *
 * ⚠️ SET TO TRUE FOR TESTING, FALSE FOR PRODUCTION
 */
export const DRY_RUN = true;

/**
 * ENABLE TRADING
 * Master kill switch. When false, no trades will be attempted at all.
 * Signals will still be processed and scored, but execution is blocked.
 */
export const ENABLE_TRADING = true;

// =============================================================================
// EXECUTION SETTINGS
// =============================================================================

/**
 * Enable fractional shares
 * - true: Buy partial shares (e.g., 2.5 shares)
 * - false: Round down to whole shares only
 */
export const ENABLE_FRACTIONAL_SHARES = true;

/**
 * Minimum position age before selling (in days)
 * For long-term capital gains, positions must be held > 365 days
 */
export const MIN_POSITION_AGE_DAYS = 365;

// =============================================================================
// SIGNAL PROCESSING
// =============================================================================

/**
 * Process signals immediately when received
 * - true: Route to agents and execute trades immediately
 * - false: Store signals for batch processing later
 */
export const PROCESS_SIGNALS_IMMEDIATELY = true;

/**
 * Maximum signals to process per batch
 * Prevents overwhelming the system during large backfills
 */
export const MAX_SIGNALS_PER_BATCH = 100;

// =============================================================================
// BUDGET & LIMITS
// =============================================================================

/**
 * Default monthly budget per agent (in USD)
 */
export const DEFAULT_MONTHLY_BUDGET = 1000;

/**
 * Budget reset day of month (1-28)
 * On this day, agent budgets reset to their monthly allocation
 */
export const BUDGET_RESET_DAY = 1;

// =============================================================================
// LOGGING & DEBUGGING
// =============================================================================

/**
 * Enable detailed decision logging
 * Logs full reasoning chain for each trade decision
 */
export const ENABLE_DECISION_LOGGING = true;

/**
 * Log API calls to Fidelity
 * Useful for debugging but may contain sensitive data
 */
export const LOG_API_CALLS = false;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get effective dry_run setting
 * Returns true if either DRY_RUN is enabled or trading is disabled
 */
export function isDryRun(): boolean {
  return DRY_RUN || !ENABLE_TRADING;
}

/**
 * Get trading config summary for logging
 */
export function getTradingConfigSummary(): Record<string, unknown> {
  return {
    dry_run: DRY_RUN,
    enable_trading: ENABLE_TRADING,
    effective_dry_run: isDryRun(),
    fractional_shares: ENABLE_FRACTIONAL_SHARES,
    min_position_age_days: MIN_POSITION_AGE_DAYS,
    process_immediately: PROCESS_SIGNALS_IMMEDIATELY,
    max_signals_per_batch: MAX_SIGNALS_PER_BATCH,
    monthly_budget: DEFAULT_MONTHLY_BUDGET,
  };
}
