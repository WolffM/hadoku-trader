/**
 * API service for fetching data from the trader-worker endpoints.
 */

import {
  API_BASE_URL,
  type Signal,
  type PerformanceData,
  type ExecutedTrade,
  type SourcePerformance,
  type AgentSummary,
  type AgentDetail,
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
 * Fetch performance data (signals, hadoku, S&P 500).
 */
export async function fetchPerformance(): Promise<PerformanceData> {
  return fetchApi<PerformanceData>('/performance')
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
 * Fetch all agent summaries with budget and position counts.
 */
export async function fetchAgents(): Promise<AgentSummary[]> {
  const data = await fetchApi<{ agents: AgentSummary[] }>('/agents')
  return data.agents
}

/**
 * Fetch agent details including positions.
 */
export async function fetchAgent(agentId: string): Promise<AgentDetail> {
  return fetchApi<AgentDetail>(`/agents/${agentId}`)
}

/**
 * Fetch all dashboard data in parallel.
 * Uses Promise.allSettled to not fail if individual endpoints fail.
 */
export async function fetchDashboardData() {
  console.log('[trader-api] Fetching dashboard data from:', API_BASE_URL)

  const results = await Promise.allSettled([
    fetchSignals(),
    fetchPerformance(),
    fetchTrades(),
    fetchSources(),
  ])

  const [signalsResult, performanceResult, tradesResult, sourcesResult] = results

  // Log any failures
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[trader-api] Endpoint ${i} failed:`, r.reason)
    }
  })

  // Extract successful results, throw if critical data missing
  const signals = signalsResult.status === 'fulfilled' ? signalsResult.value : null
  const performance = performanceResult.status === 'fulfilled' ? performanceResult.value : null
  const trades = tradesResult.status === 'fulfilled' ? tradesResult.value : null
  const sources = sourcesResult.status === 'fulfilled' ? sourcesResult.value : null

  // If we got nothing, throw error
  if (!signals && !performance && !trades && !sources) {
    throw new Error('All API endpoints failed')
  }

  console.log('[trader-api] Fetch complete:', {
    signals: signals?.length ?? 'failed',
    performance: performance ? 'ok' : 'failed',
    trades: trades?.length ?? 'failed',
    sources: sources?.length ?? 'failed',
  })

  return { signals, performance, trades, sources }
}
