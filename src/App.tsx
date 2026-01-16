import { useRef, useState, useEffect } from 'react'
import { ConnectedThemePicker, LoadingSkeleton } from '@wolffm/task-ui-components'
import { THEME_ICON_MAP } from '@wolffm/themes'
import { useTheme } from './hooks/useTheme'
import type { TraderProps } from './entry'
import type {
  Signal,
  PerformanceData,
  ExecutedTrade,
  SourcePerformance
} from './types/api'

// Dashboard Components
import {
  OverviewCards,
  PerformanceChart,
  SignalsFeed,
  TradeLog,
  SourceLeaderboard
} from './components/Dashboard'

// API Service
import { fetchDashboardData } from './services/api'

// Mock Data (fallback for development)
import {
  mockPerformanceData,
  mockSignals,
  mockTrades,
  mockSources
} from './data/mockData'

interface DashboardState {
  signals: Signal[]
  performance: PerformanceData
  trades: ExecutedTrade[]
  sources: SourcePerformance[]
  isLoading: boolean
  error: string | null
}

// Session cache to persist data across component remounts
const SESSION_CACHE_KEY = 'trader-dashboard-cache'

function getCachedData(): Partial<DashboardState> | null {
  try {
    const cached = sessionStorage.getItem(SESSION_CACHE_KEY)
    if (cached) {
      const data = JSON.parse(cached)
      console.log('[trader] Using cached data from sessionStorage')
      return data
    }
  } catch {
    // Ignore cache errors
  }
  return null
}

function setCachedData(data: Omit<DashboardState, 'isLoading' | 'error'>) {
  try {
    sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(data))
  } catch {
    // Ignore cache errors
  }
}

export default function App(props: TraderProps = {}) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Detect system preference for loading skeleton
  const [systemPrefersDark] = useState(() => {
    if (window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })

  // Dashboard data state - initialize from cache if available
  const [data, setData] = useState<DashboardState>(() => {
    const cached = getCachedData()
    return {
      signals: cached?.signals ?? mockSignals,
      performance: cached?.performance ?? mockPerformanceData,
      trades: cached?.trades ?? mockTrades,
      sources: cached?.sources ?? mockSources,
      isLoading: !cached, // Don't show loading if we have cached data
      error: null,
    }
  })

  // Fetch dashboard data on mount
  useEffect(() => {
    let mounted = true
    console.log('[trader] Component mounted, fetching data...')

    async function loadData() {
      try {
        const result = await fetchDashboardData()
        if (mounted) {
          // Merge with existing data (keep current data for any failed endpoints)
          setData((prev) => {
            const newData = {
              signals: result.signals ?? prev.signals,
              performance: result.performance ?? prev.performance,
              trades: result.trades ?? prev.trades,
              sources: result.sources ?? prev.sources,
              isLoading: false,
              error: null,
            }
            // Cache successful data
            setCachedData({
              signals: newData.signals,
              performance: newData.performance,
              trades: newData.trades,
              sources: newData.sources,
            })
            console.log('[trader] Data loaded and cached')
            return newData
          })
        }
      } catch (err) {
        console.error('[trader] Failed to fetch dashboard data:', err)
        if (mounted) {
          // Keep existing data on error, just clear loading state
          setData((prev) => ({
            ...prev,
            isLoading: false,
            error: err instanceof Error ? err.message : 'Failed to load data',
          }))
        }
      }
    }

    loadData()

    return () => {
      console.log('[trader] Component unmounting')
      mounted = false
    }
  }, [])

  const { theme, setTheme, isDarkTheme, isThemeReady, isInitialThemeLoad, THEME_FAMILIES } =
    useTheme({
      propsTheme: props.theme,
      experimentalThemes: false,
      containerRef
    })

  // Show loading skeleton during initial theme load to prevent FOUC
  if (isInitialThemeLoad && !isThemeReady) {
    return <LoadingSkeleton isDarkTheme={systemPrefersDark} />
  }

  return (
    <div
      ref={containerRef}
      className="trader-container"
      data-theme={theme}
      data-dark-theme={isDarkTheme ? 'true' : 'false'}
    >
      <div className="trader">
        <header className="trader__header">
          <h1>Congress Trader</h1>

          <ConnectedThemePicker
            themeFamilies={THEME_FAMILIES}
            currentTheme={theme}
            onThemeChange={setTheme}
            getThemeIcon={(themeName: string) => {
              const Icon = THEME_ICON_MAP[themeName as keyof typeof THEME_ICON_MAP]
              return Icon ? <Icon /> : null
            }}
          />
        </header>

        <main className="trader__content">
          {/* Error Banner */}
          {data.error && (
            <div className="trader__error">
              <span>⚠️ Using cached data: {data.error}</span>
            </div>
          )}

          {/* Loading Indicator */}
          {data.isLoading && (
            <div className="trader__loading">Loading live data...</div>
          )}

          {/* Overview KPI Cards */}
          <OverviewCards performance={data.performance} />

          {/* Performance Chart - Full Width */}
          <PerformanceChart data={data.performance} isDarkTheme={isDarkTheme} />

          {/* Two Column Grid */}
          <div className="dashboard-grid">
            {/* Left Column - Signals & Sources */}
            <div>
              <SignalsFeed signals={data.signals} />
              <div style={{ marginTop: '1.5rem' }}>
                <SourceLeaderboard sources={data.sources} />
              </div>
            </div>

            {/* Right Column - Trade History */}
            <div>
              <TradeLog trades={data.trades} />
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
