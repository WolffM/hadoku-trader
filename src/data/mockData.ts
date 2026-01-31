// Mock data for development
// This simulates what we'd receive from the hadoku-site API

import type { Signal, PerformanceData, ExecutedTrade, SourcePerformance } from '../types/api'

// Generate date strings for the past N days
function generateDates(days: number): string[] {
  const dates: string[] = []
  const today = new Date()
  for (let i = days; i >= 0; i--) {
    const date = new Date(today)
    date.setDate(date.getDate() - i)
    dates.push(date.toISOString().split('T')[0])
  }
  return dates
}

// Generate performance history with cumulative % returns
function generateReturnHistory(totalReturn: number, variance: number, dates: string[]) {
  // Distribute the total return across all dates with some randomness
  const dailyAvgReturn = totalReturn / dates.length
  let cumulative = 0
  return dates.map(date => {
    const dailyChange = dailyAvgReturn + (Math.random() - 0.5) * variance
    cumulative += dailyChange
    return { date, value: Math.round(cumulative * 100) / 100 }
  })
}

const dates = generateDates(90)

export const mockPerformanceData: PerformanceData = {
  signals_performance: {
    total_return_pct: 18.5,
    mtd_return_pct: 3.2,
    ytd_return_pct: 18.5,
    history: generateReturnHistory(18.5, 0.8, dates)
  },
  hadoku_performance: {
    total_return_pct: 22.3,
    mtd_return_pct: 4.1,
    ytd_return_pct: 22.3,
    history: generateReturnHistory(22.3, 1.0, dates)
  },
  sp500_performance: {
    total_return_pct: 12.1,
    mtd_return_pct: 1.8,
    ytd_return_pct: 12.1,
    history: generateReturnHistory(12.1, 0.5, dates)
  },
  last_updated: new Date().toISOString()
}

export const mockSignals: Signal[] = [
  {
    id: 'sig_001',
    source: 'unusual_whales',
    politician: {
      name: 'Nancy Pelosi',
      chamber: 'house',
      party: 'D',
      state: 'CA'
    },
    trade: {
      ticker: 'NVDA',
      action: 'buy',
      asset_type: 'stock',
      trade_date: '2025-12-01',
      trade_price: 140.0,
      disclosure_date: '2025-12-15',
      disclosure_price: 142.5,
      position_size: '$100K-$250K',
      position_size_min: 100000,
      position_size_max: 250000
    },
    meta: {
      source_url: 'https://unusualwhales.com/congress/trade/12345',
      source_id: 'uw_12345',
      scraped_at: '2025-12-15T14:32:00Z'
    }
  },
  {
    id: 'sig_002',
    source: 'capitol_trades',
    politician: {
      name: 'Tommy Tuberville',
      chamber: 'senate',
      party: 'R',
      state: 'AL'
    },
    trade: {
      ticker: 'PLTR',
      action: 'buy',
      asset_type: 'stock',
      trade_date: '2025-12-10',
      trade_price: 70.0,
      disclosure_date: '2025-12-14',
      disclosure_price: null,
      position_size: '$50K-$100K',
      position_size_min: 50000,
      position_size_max: 100000
    },
    meta: {
      source_url: 'https://capitoltrades.com/trades/98765',
      source_id: 'ct_98765',
      scraped_at: '2025-12-14T09:15:00Z'
    }
  },
  {
    id: 'sig_003',
    source: 'unusual_whales',
    politician: {
      name: 'Dan Crenshaw',
      chamber: 'house',
      party: 'R',
      state: 'TX'
    },
    trade: {
      ticker: 'MSFT',
      action: 'sell',
      asset_type: 'stock',
      trade_date: '2025-12-05',
      trade_price: 420.0,
      disclosure_date: '2025-12-12',
      disclosure_price: 425.0,
      position_size: '$15K-$50K',
      position_size_min: 15000,
      position_size_max: 50000
    },
    meta: {
      source_url: 'https://unusualwhales.com/congress/trade/54321',
      source_id: 'uw_54321',
      scraped_at: '2025-12-12T16:45:00Z'
    }
  },
  {
    id: 'sig_004',
    source: 'quiver_quant',
    politician: {
      name: 'Mark Green',
      chamber: 'house',
      party: 'R',
      state: 'TN'
    },
    trade: {
      ticker: 'GOOGL',
      action: 'buy',
      asset_type: 'stock',
      trade_date: '2025-12-08',
      trade_price: 172.0,
      disclosure_date: '2025-12-13',
      disclosure_price: 175.2,
      position_size: '$15K-$50K',
      position_size_min: 15000,
      position_size_max: 50000
    },
    meta: {
      source_url: 'https://quiverquant.com/trade/67890',
      source_id: 'qq_67890',
      scraped_at: '2025-12-13T11:20:00Z'
    }
  },
  {
    id: 'sig_005',
    source: 'capitol_trades',
    politician: {
      name: 'Josh Gottheimer',
      chamber: 'house',
      party: 'D',
      state: 'NJ'
    },
    trade: {
      ticker: 'AAPL',
      action: 'buy',
      asset_type: 'stock',
      trade_date: '2025-12-11',
      trade_price: 195.0,
      disclosure_date: '2025-12-16',
      disclosure_price: 198.5,
      position_size: '$50K-$100K',
      position_size_min: 50000,
      position_size_max: 100000
    },
    meta: {
      source_url: 'https://capitoltrades.com/trades/11111',
      source_id: 'ct_11111',
      scraped_at: '2025-12-16T08:00:00Z'
    }
  }
]

export const mockTrades: ExecutedTrade[] = [
  {
    id: 'trade_001',
    date: '2025-12-15T10:30:00Z',
    ticker: 'NVDA',
    action: 'buy',
    quantity: 15,
    price: 138.5,
    total: 2077.5,
    signal_id: 'sig_001',
    reasoning: {
      politician: 'Nancy Pelosi',
      source_count: 2,
      conviction_multiplier: 1.25,
      priced_in_factor: 0.85,
      position_size_tier: '$100K-$250K'
    },
    status: 'executed'
  },
  {
    id: 'trade_002',
    date: '2025-12-14T11:15:00Z',
    ticker: 'PLTR',
    action: 'buy',
    quantity: 50,
    price: 72.4,
    total: 3620.0,
    signal_id: 'sig_002',
    reasoning: {
      politician: 'Tommy Tuberville',
      source_count: 1,
      conviction_multiplier: 1.0,
      priced_in_factor: 0.92,
      position_size_tier: '$50K-$100K'
    },
    status: 'executed'
  },
  {
    id: 'trade_003',
    date: '2025-12-13T14:00:00Z',
    ticker: 'GOOGL',
    action: 'buy',
    quantity: 12,
    price: 175.2,
    total: 2102.4,
    signal_id: 'sig_004',
    reasoning: {
      politician: 'Mark Green',
      source_count: 1,
      conviction_multiplier: 1.0,
      priced_in_factor: 0.88,
      position_size_tier: '$15K-$50K'
    },
    status: 'executed'
  },
  {
    id: 'trade_004',
    date: '2025-12-16T09:45:00Z',
    ticker: 'AAPL',
    action: 'buy',
    quantity: 20,
    price: 198.5,
    total: 3970.0,
    signal_id: 'sig_005',
    reasoning: {
      politician: 'Josh Gottheimer',
      source_count: 1,
      conviction_multiplier: 1.0,
      priced_in_factor: 0.95,
      position_size_tier: '$50K-$100K'
    },
    status: 'executed'
  }
]

export const mockSources: SourcePerformance[] = [
  {
    name: 'unusual_whales',
    total_signals: 156,
    executed_signals: 124,
    avg_return_pct: 9.2,
    win_rate: 0.68
  },
  {
    name: 'capitol_trades',
    total_signals: 203,
    executed_signals: 178,
    avg_return_pct: 7.8,
    win_rate: 0.62
  },
  {
    name: 'quiver_quant',
    total_signals: 89,
    executed_signals: 71,
    avg_return_pct: 6.5,
    win_rate: 0.58
  },
  {
    name: 'house_stock_watcher',
    total_signals: 145,
    executed_signals: 112,
    avg_return_pct: 5.9,
    win_rate: 0.55
  },
  {
    name: 'senate_stock_watcher',
    total_signals: 67,
    executed_signals: 52,
    avg_return_pct: 8.1,
    win_rate: 0.65
  }
]
