import { useRef, useState } from 'react'
import { ConnectedThemePicker, LoadingSkeleton } from '@wolffm/task-ui-components'
import { THEME_ICON_MAP } from '@wolffm/themes'
import { useTheme } from './hooks/useTheme'
import type { TraderProps } from './entry'

// Dashboard Components
import {
  OverviewCards,
  PerformanceChart,
  SignalsFeed,
  TradeLog,
  PortfolioPositions,
  SourceLeaderboard
} from './components/Dashboard'

// Mock Data (will be replaced with API calls)
import {
  mockPerformanceData,
  mockPortfolioData,
  mockSignals,
  mockTrades,
  mockSources
} from './data/mockData'

export default function App(props: TraderProps = {}) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Detect system preference for loading skeleton
  const [systemPrefersDark] = useState(() => {
    if (window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })

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
          {/* Overview KPI Cards */}
          <OverviewCards performance={mockPerformanceData} portfolio={mockPortfolioData} />

          {/* Performance Chart - Full Width */}
          <PerformanceChart data={mockPerformanceData} isDarkTheme={isDarkTheme} />

          {/* Two Column Grid */}
          <div className="dashboard-grid">
            {/* Left Column - Portfolio & Trades */}
            <div>
              <PortfolioPositions data={mockPortfolioData} />
              <div style={{ marginTop: '1.5rem' }}>
                <TradeLog trades={mockTrades} />
              </div>
            </div>

            {/* Right Column - Signals & Sources */}
            <div>
              <SignalsFeed signals={mockSignals} />
              <div style={{ marginTop: '1.5rem' }}>
                <SourceLeaderboard sources={mockSources} />
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
