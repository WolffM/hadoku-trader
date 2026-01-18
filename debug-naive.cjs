const d = require('./trader-db-export.json');

// Build price lookup
const prices = new Map();
d.market_prices.forEach(p => {
  prices.set(p.ticker + ':' + p.date, p.close);
});

function getPrice(ticker, date) {
  return prices.get(ticker + ':' + date) || null;
}

// NAIVE config from configs.ts
const NAIVE = {
  id: 'naive',
  politician_whitelist: null,
  politician_scope_all: true,
  allowed_asset_types: ['stock', 'etf', 'option'],
  max_signal_age_days: 90,
  max_price_move_pct: 100,
  max_open_positions: 20,
  max_per_ticker: 1,
  max_position_amount: 100, // Only $100 per position!
  min_position_amount: 25,
  monthly_budget: 1000,
};

console.log('=== NAIVE AGENT DEBUG ===\n');
console.log('Config:', JSON.stringify(NAIVE, null, 2));

// Get buy signals starting from 2025-06-12
const signals = d.signals
  .filter(s => s.action === 'buy' && s.disclosure_date >= '2025-06-12')
  .sort((a, b) => a.disclosure_date.localeCompare(b.disclosure_date));

console.log('\nTotal buy signals:', signals.length);

// Simulate trades
let cash = 1000;
let positions = [];
let currentMonth = '2025-06';
let trades = 0;
let skips = { no_price: 0, max_ticker: 0, max_pos: 0, no_budget: 0 };

for (const signal of signals.slice(0, 100)) { // First 100 signals
  const price = getPrice(signal.ticker, signal.disclosure_date);
  
  // Check month change
  const month = signal.disclosure_date.substring(0, 7);
  if (month !== currentMonth) {
    cash += 1000;
    currentMonth = month;
    console.log(`\n[${month}] New month, budget now $${cash.toFixed(2)}, positions: ${positions.length}`);
  }
  
  if (!price) {
    skips.no_price++;
    continue;
  }
  
  const tickerCount = positions.filter(p => p.ticker === signal.ticker).length;
  if (tickerCount >= NAIVE.max_per_ticker) {
    skips.max_ticker++;
    continue;
  }
  
  if (positions.length >= NAIVE.max_open_positions) {
    skips.max_pos++;
    continue;
  }
  
  // Calculate position size - equal_split mode
  const positionSize = Math.min(NAIVE.max_position_amount, cash / (NAIVE.max_open_positions - positions.length));
  
  if (positionSize < NAIVE.min_position_amount) {
    skips.no_budget++;
    continue;
  }
  
  const shares = Math.floor(positionSize / price);
  if (shares < 1) {
    console.log(`  Skip ${signal.ticker}: price $${price.toFixed(2)} too high for $${positionSize.toFixed(2)}`);
    continue;
  }
  
  const cost = shares * price;
  cash -= cost;
  positions.push({ ticker: signal.ticker, date: signal.disclosure_date, price, shares });
  trades++;
  
  console.log(`  Trade #${trades}: ${signal.ticker} ${shares} shares @ $${price.toFixed(2)} = $${cost.toFixed(2)}, cash left: $${cash.toFixed(2)}`);
}

console.log('\n=== SUMMARY ===');
console.log('Trades:', trades);
console.log('Skips:', skips);
console.log('Positions:', positions.length);
console.log('Cash remaining:', cash.toFixed(2));
