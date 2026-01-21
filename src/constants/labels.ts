/**
 * Shared label constants for the dashboard.
 */

/**
 * Human-readable names for data sources.
 */
export const SOURCE_LABELS: Record<string, string> = {
  unusual_whales: 'Unusual Whales',
  capitol_trades: 'Capitol Trades',
  quiver_quant: 'Quiver Quant',
  house_stock_watcher: 'House Watcher',
  senate_stock_watcher: 'Senate Watcher'
}

/**
 * CSS class names for party colors.
 */
export const PARTY_COLORS: Record<string, string> = {
  D: 'signal-card__party--dem',
  R: 'signal-card__party--rep',
  I: 'signal-card__party--ind'
}

/**
 * CSS class names for trade status.
 */
export const STATUS_CLASSES: Record<string, string> = {
  executed: 'trade-row__status--executed',
  pending: 'trade-row__status--pending',
  skipped: 'trade-row__status--skipped'
}
