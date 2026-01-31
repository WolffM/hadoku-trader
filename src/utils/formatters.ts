/**
 * Shared formatting utilities for the dashboard.
 */

/**
 * Format a number as USD currency.
 */
export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)
}

/**
 * Format a number as a percentage with sign.
 * @param value - The percentage value (e.g., 5.5 for 5.5%)
 * @param decimals - Number of decimal places (default: 2)
 */
export function formatPercent(value: number, decimals = 2): string {
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(decimals)}%`
}

/**
 * Format a date string for display.
 * @param dateString - ISO date string
 * @param includeTime - Whether to include time (default: false)
 */
export function formatDate(dateString: string, includeTime = false): string {
  const date = new Date(dateString)
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric'
  }
  if (includeTime) {
    options.hour = '2-digit'
    options.minute = '2-digit'
  }
  return date.toLocaleDateString('en-US', options)
}

/**
 * Format a price value, handling null.
 */
export function formatPrice(price: number | null): string {
  if (price === null) return 'N/A'
  return `$${price.toFixed(2)}`
}
