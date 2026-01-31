import { useState } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend
} from 'recharts'
import type { PerformanceData } from '../../types/api'

interface PerformanceChartProps {
  data: PerformanceData
  isDarkTheme: boolean
}

type TimeRange = '7d' | '30d' | '90d' | 'all'

function filterByTimeRange<T extends { date: string }>(data: T[], range: TimeRange): T[] {
  if (range === 'all') return data

  const now = new Date()
  const daysMap: Record<TimeRange, number> = {
    '7d': 7,
    '30d': 30,
    '90d': 90,
    all: Infinity
  }

  const cutoff = new Date(now.getTime() - daysMap[range] * 24 * 60 * 60 * 1000)

  return data.filter(item => new Date(item.date) >= cutoff)
}

export function PerformanceChart({ data, isDarkTheme }: PerformanceChartProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>('30d')

  // Merge all three performance histories into one dataset
  const signalsHistory = filterByTimeRange(data.signals_performance.history, timeRange)
  const hadokuHistory = filterByTimeRange(data.hadoku_performance.history, timeRange)
  const sp500History = filterByTimeRange(data.sp500_performance.history, timeRange)

  const chartData = signalsHistory.map((item, index) => ({
    date: item.date,
    signals: item.value,
    hadoku: hadokuHistory[index]?.value ?? 0,
    sp500: sp500History[index]?.value ?? 0
  }))

  // Theme-aware colors
  const colors = {
    signals: isDarkTheme ? '#60a5fa' : '#3b82f6', // blue
    hadoku: isDarkTheme ? '#4ade80' : '#22c55e', // green
    sp500: isDarkTheme ? '#a78bfa' : '#8b5cf6', // purple
    grid: isDarkTheme ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
    text: isDarkTheme ? '#94a3b8' : '#64748b'
  }

  const timeRanges: { value: TimeRange; label: string }[] = [
    { value: '7d', label: '7D' },
    { value: '30d', label: '30D' },
    { value: '90d', label: '90D' },
    { value: 'all', label: 'All' }
  ]

  return (
    <div className="performance-chart">
      <div className="performance-chart__header">
        <h2 className="performance-chart__title">Performance Comparison</h2>
        <div className="performance-chart__controls">
          {timeRanges.map(range => (
            <button
              key={range.value}
              className={`performance-chart__range-btn ${
                timeRange === range.value ? 'performance-chart__range-btn--active' : ''
              }`}
              onClick={() => setTimeRange(range.value)}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      <div className="performance-chart__container">
        <ResponsiveContainer width="100%" height={350}>
          <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="colorSignals" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colors.signals} stopOpacity={0.3} />
                <stop offset="95%" stopColor={colors.signals} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="colorHadoku" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colors.hadoku} stopOpacity={0.3} />
                <stop offset="95%" stopColor={colors.hadoku} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="colorSP500" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colors.sp500} stopOpacity={0.3} />
                <stop offset="95%" stopColor={colors.sp500} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
            <XAxis
              dataKey="date"
              tick={{ fill: colors.text, fontSize: 12 }}
              tickFormatter={(value: string | number | Date) => {
                const date = new Date(value)
                return `${date.getMonth() + 1}/${date.getDate()}`
              }}
            />
            <YAxis
              tick={{ fill: colors.text, fontSize: 12 }}
              tickFormatter={(value: number) => `${value.toFixed(1)}%`}
              domain={['dataMin - 1', 'dataMax + 1']}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: isDarkTheme ? '#1e293b' : '#ffffff',
                border: `1px solid ${isDarkTheme ? '#334155' : '#e2e8f0'}`,
                borderRadius: '8px',
                color: isDarkTheme ? '#f1f5f9' : '#1e293b'
              }}
              formatter={(value: number | undefined) => [
                value !== undefined ? `${value.toFixed(2)}%` : 'N/A',
                ''
              ]}
              labelFormatter={(label: string | number | Date) =>
                new Date(label).toLocaleDateString()
              }
            />
            <Legend
              wrapperStyle={{ paddingTop: '20px' }}
              formatter={(value: string) => {
                const labels: Record<string, string> = {
                  hadoku: 'Hadoku',
                  signals: 'Signals',
                  sp500: 'S&P 500'
                }
                return <span style={{ color: colors.text }}>{labels[value] ?? value}</span>
              }}
            />
            <Area
              type="monotone"
              dataKey="hadoku"
              stroke={colors.hadoku}
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#colorHadoku)"
            />
            <Area
              type="monotone"
              dataKey="signals"
              stroke={colors.signals}
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#colorSignals)"
            />
            <Area
              type="monotone"
              dataKey="sp500"
              stroke={colors.sp500}
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#colorSP500)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
