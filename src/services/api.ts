/**
 * API service for fetching data from the trader-worker endpoints.
 */

import {
  API_BASE_URL,
  type Signal,
  type PerformanceData,
  type PortfolioData,
  type ExecutedTrade,
  type SourcePerformance,
  type ExecuteTradeRequest,
  type ExecuteTradeResponse,
  type HealthResponse,
} from '../types/api'

// Re-export for convenience
export { API_BASE_URL }

/**
 * Generic fetch wrapper with error handling.
 */
async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`API Error (${response.status}): ${error}`)
  }

  return response.json()
}

/**
 * Fetch congressional trade signals.
 */
export async function fetchSignals(): Promise<Signal[]> {
  const data = await fetchApi<{ signals: Signal[] }>('/signals')
  return data.signals
}

/**
 * Fetch performance data (portfolio, signals, S&P 500).
 */
export async function fetchPerformance(): Promise<PerformanceData> {
  return fetchApi<PerformanceData>('/performance')
}

/**
 * Fetch current portfolio positions.
 */
export async function fetchPortfolio(): Promise<PortfolioData> {
  return fetchApi<PortfolioData>('/portfolio')
}

/**
 * Fetch executed trades history.
 */
export async function fetchTrades(): Promise<ExecutedTrade[]> {
  const data = await fetchApi<{ trades: ExecutedTrade[] }>('/trades')
  return data.trades
}

/**
 * Fetch signal source performance rankings.
 */
export async function fetchSources(): Promise<SourcePerformance[]> {
  const data = await fetchApi<{ sources: SourcePerformance[] }>('/sources')
  return data.sources
}

/**
 * Execute a trade via the Fidelity service.
 */
export async function executeTrade(
  request: ExecuteTradeRequest,
  apiKey: string
): Promise<ExecuteTradeResponse> {
  return fetchApi<ExecuteTradeResponse>('/execute', {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
    },
    body: JSON.stringify(request),
  })
}

/**
 * Health check endpoint.
 */
export async function fetchHealth(): Promise<HealthResponse> {
  return fetchApi<HealthResponse>('/health')
}

/**
 * Fetch all dashboard data in parallel.
 */
export async function fetchDashboardData() {
  const [signals, performance, portfolio, trades, sources] = await Promise.all([
    fetchSignals(),
    fetchPerformance(),
    fetchPortfolio(),
    fetchTrades(),
    fetchSources(),
  ])

  return { signals, performance, portfolio, trades, sources }
}
