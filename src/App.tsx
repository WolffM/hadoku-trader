import { useRef, useState, useEffect } from 'react'
import { ConnectedThemePicker, LoadingSkeleton } from '@wolffm/task-ui-components'
import { THEME_ICON_MAP } from '@wolffm/themes'
import { useTheme } from './hooks/useTheme'
import type { TraderProps } from './entry'
import type {
  Signal,
  PerformanceData,
  PortfolioData,
  ExecutedTrade,
  SourcePerformance
} from './types/api'

// Dashboard Components
import {
  OverviewCards,
  PerformanceChart,
  SignalsFeed,
  TradeLog,
  PortfolioPositions,
  SourceLeaderboard
} from './components/Dashboard'

// API Service
import { fetchDashboardData } from './services/api'

// Mock Data (fallback for development)
import {
  mockPerformanceData,
  mockPortfolioData,
  mockSignals,
  mockTrades,
  mockSources
} from './data/mockData'

interface DashboardState {
  signals: Signal[]
  performance: PerformanceData
  portfolio: PortfolioData
  trades: ExecutedTrade[]
  sources: SourcePerformance[]
  isLoading: boolean
  error: string | null
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

  // Dashboard data state
  const [data, setData] = useState<DashboardState>({
    signals: mockSignals,
    performance: mockPerformanceData,
    portfolio: mockPortfolioData,
    trades: mockTrades,
    sources: mockSources,
    isLoading: true,
    error: null,
  })

  // Fetch dashboard data on mount
  useEffect(() => {
    let mounted = true

    async function loadData() {
      try {
        const result = await fetchDashboardData()
        if (mounted) {
          setData({
            ...result,
            isLoading: false,
            error: null,
          })
        }
      } catch (err) {
        console.error('Failed to fetch dashboard data:', err)
        if (mounted) {
          // Keep mock data on error, just clear loading state
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
          <OverviewCards performance={data.performance} portfolio={data.portfolio} />

          {/* Performance Chart - Full Width */}
          <PerformanceChart data={data.performance} isDarkTheme={isDarkTheme} />

          {/* Two Column Grid */}
          <div className="dashboard-grid">
            {/* Left Column - Portfolio & Trades */}
            <div>
              <PortfolioPositions data={data.portfolio} />
              <div style={{ marginTop: '1.5rem' }}>
                <TradeLog trades={data.trades} />
              </div>
            </div>

            {/* Right Column - Signals & Sources */}
            <div>
              <SignalsFeed signals={data.signals} />
              <div style={{ marginTop: '1.5rem' }}>
                <SourceLeaderboard sources={data.sources} />
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
