const d = require('./trader-db-export.json');

// Build price lookup
const prices = new Map();
d.market_prices.forEach(p => {
  prices.set(p.ticker + ':' + p.date, p.close);
});

function getPrice(ticker, date) {
  return prices.get(ticker + ':' + date) || null;
}

// Agent configs (simplified)
const CHATGPT = {
  id: 'chatgpt',
  politician_whitelist: null,
  politician_scope_all: true,
  allowed_asset_types: ['stock'],
  max_signal_age_days: 30,
  max_price_move_pct: 15,
  execute_threshold: 0.5,
};

const CLAUDE = {
  id: 'claude',
  politician_whitelist: null,
  politician_scope_all: true,
  allowed_asset_types: ['stock'],
  max_signal_age_days: 45,
  max_price_move_pct: 20,
  execute_threshold: 0.4,
};

const GEMINI = {
  id: 'gemini',
  politician_whitelist: ['Nancy Pelosi', 'Mark Green', 'Michael McCaul', 'Ro Khanna', 'Rick Larsen'],
  politician_scope_all: false,
  allowed_asset_types: ['stock'],
  max_signal_age_days: 30,
  max_price_move_pct: 15,
  execute_threshold: 0,
};

const NAIVE = {
  id: 'naive',
  politician_whitelist: null,
  politician_scope_all: true,
  allowed_asset_types: ['stock', 'etf', 'option'],
  max_signal_age_days: 90,
  max_price_move_pct: 100,
  execute_threshold: 0,
};

// Get buy signals in date range
const signals = d.signals
  .filter(s => s.action === 'buy' && s.disclosure_date >= '2025-06-12')
  .sort((a, b) => a.disclosure_date.localeCompare(b.disclosure_date))
  .slice(0, 20); // First 20 signals for analysis

console.log('=== SIGNAL-BY-SIGNAL ANALYSIS (First 20 buy signals) ===\n');

for (const signal of signals) {
  const currentPrice = getPrice(signal.ticker, signal.disclosure_date);
  const tradePrice = signal.trade_price;

  // Calculate days since trade (as of disclosure date)
  const tradeDate = new Date(signal.trade_date);
  const discDate = new Date(signal.disclosure_date);
  const daysSinceTrade = Math.floor((discDate - tradeDate) / (1000 * 60 * 60 * 24));

  const priceChangePct = currentPrice && tradePrice
    ? ((currentPrice - tradePrice) / tradePrice) * 100
    : null;

  console.log('----------------------------------------');
  console.log('Signal:', signal.id.substring(0, 25));
  console.log('  Ticker:', signal.ticker);
  console.log('  Politician:', signal.politician_name);
  console.log('  Trade Date:', signal.trade_date, '-> Disclosure:', signal.disclosure_date);
  console.log('  Days Since Trade:', daysSinceTrade);
  console.log('  Trade Price:', tradePrice?.toFixed(2), '-> Current:', currentPrice?.toFixed(2));
  console.log('  Price Change:', priceChangePct !== null ? priceChangePct.toFixed(1) + '%' : 'N/A');
  console.log('  Position Size:', signal.position_size_min);

  // Check each agent
  for (const agent of [CHATGPT, CLAUDE, GEMINI, NAIVE]) {
    const reasons = [];
    let passes = true;

    // Check politician whitelist
    if (agent.politician_whitelist) {
      const inList = agent.politician_whitelist.some(p =>
        signal.politician_name.toLowerCase().includes(p.toLowerCase())
      );
      if (!inList) {
        passes = false;
        reasons.push('politician_not_in_whitelist');
      }
    }

    // Check asset type
    if (!agent.allowed_asset_types.includes(signal.asset_type)) {
      passes = false;
      reasons.push('asset_type_' + signal.asset_type);
    }

    // Check signal age
    if (daysSinceTrade > agent.max_signal_age_days) {
      passes = false;
      reasons.push('too_old_' + daysSinceTrade + '>' + agent.max_signal_age_days);
    }

    // Check price movement
    if (priceChangePct !== null && Math.abs(priceChangePct) > agent.max_price_move_pct) {
      passes = false;
      reasons.push('price_moved_' + Math.abs(priceChangePct).toFixed(1) + '%>' + agent.max_price_move_pct + '%');
    }

    // Check if we have price data
    if (!currentPrice) {
      passes = false;
      reasons.push('no_price_data');
    }

    const status = passes ? 'PASS' : 'SKIP';
    const reasonStr = reasons.length > 0 ? reasons.join(', ') : 'all_filters_passed';
    console.log('  ' + agent.id.toUpperCase().padEnd(8) + ':', status, '-', reasonStr);
  }
}

// Summary stats
console.log('\n\n=== SUMMARY STATS ===\n');

const allBuySignals = d.signals.filter(s => s.action === 'buy' && s.disclosure_date >= '2025-06-12');
console.log('Total buy signals:', allBuySignals.length);

// Count by filter failure
let noPrice = 0;
let tooOld30 = 0;
let tooOld45 = 0;
let priceMoved15 = 0;
let priceMoved20 = 0;
let passAll = 0;

for (const signal of allBuySignals) {
  const currentPrice = getPrice(signal.ticker, signal.disclosure_date);
  const tradeDate = new Date(signal.trade_date);
  const discDate = new Date(signal.disclosure_date);
  const daysSinceTrade = Math.floor((discDate - tradeDate) / (1000 * 60 * 60 * 24));
  const priceChangePct = currentPrice && signal.trade_price
    ? Math.abs((currentPrice - signal.trade_price) / signal.trade_price * 100)
    : null;

  if (!currentPrice) {
    noPrice++;
    continue;
  }

  if (daysSinceTrade > 45) tooOld45++;
  if (daysSinceTrade > 30) tooOld30++;
  if (priceChangePct > 20) priceMoved20++;
  if (priceChangePct > 15) priceMoved15++;

  if (daysSinceTrade <= 30 && priceChangePct <= 15) {
    passAll++;
  }
}

console.log('No price data:', noPrice);
console.log('Too old (>30 days):', tooOld30);
console.log('Too old (>45 days):', tooOld45);
console.log('Price moved >15%:', priceMoved15);
console.log('Price moved >20%:', priceMoved20);
console.log('Pass all filters (30d, 15%):', passAll);

// Now simulate what happens with position limits
console.log('\n\n=== SIMULATION WITH POSITION LIMITS ===\n');

const buySignals = d.signals
  .filter(s => s.action === 'buy' && s.disclosure_date >= '2025-06-12')
  .sort((a, b) => a.disclosure_date.localeCompare(b.disclosure_date));

// Track per agent
const agents = {
  chatgpt: { trades: 0, skips: {}, cash: 1000, positions: [], maxPos: 5, maxPerTicker: 1, maxAge: 30, maxMove: 15 },
  claude: { trades: 0, skips: {}, cash: 1000, positions: [], maxPos: 10, maxPerTicker: 2, maxAge: 45, maxMove: 20 },
  gemini: { trades: 0, skips: {}, cash: 1000, positions: [], maxPos: 10, maxPerTicker: 1, maxAge: 30, maxMove: 15, whitelist: ['Nancy Pelosi', 'Mark Green', 'Michael McCaul', 'Ro Khanna', 'Rick Larsen'] },
  naive: { trades: 0, skips: {}, cash: 1000, positions: [], maxPos: 20, maxPerTicker: 1, maxAge: 90, maxMove: 100 },
};

let currentMonth = '2025-06';

for (const signal of buySignals) {
  const currentPrice = getPrice(signal.ticker, signal.disclosure_date);
  const tradeDate = new Date(signal.trade_date);
  const discDate = new Date(signal.disclosure_date);
  const daysSinceTrade = Math.floor((discDate - tradeDate) / (1000 * 60 * 60 * 24));
  const priceChangePct = currentPrice && signal.trade_price
    ? Math.abs((currentPrice - signal.trade_price) / signal.trade_price * 100)
    : null;

  // Check for month change - add budget
  const month = signal.disclosure_date.substring(0, 7);
  if (month !== currentMonth) {
    for (const agent of Object.values(agents)) {
      agent.cash += 1000;
    }
    currentMonth = month;
  }

  for (const [agentId, agent] of Object.entries(agents)) {
    let skip = null;

    // Check whitelist (Gemini only)
    if (agent.whitelist) {
      const inList = agent.whitelist.some(p => signal.politician_name.toLowerCase().includes(p.toLowerCase()));
      if (!inList) { skip = 'politician'; }
    }

    // Check filters
    if (!skip && !currentPrice) skip = 'no_price';
    if (!skip && daysSinceTrade > agent.maxAge) skip = 'too_old';
    if (!skip && priceChangePct > agent.maxMove) skip = 'price_moved';

    // Check position limits
    if (!skip && agent.positions.length >= agent.maxPos) skip = 'max_positions';
    if (!skip) {
      const tickerCount = agent.positions.filter(p => p === signal.ticker).length;
      if (tickerCount >= agent.maxPerTicker) skip = 'max_per_ticker';
    }

    // Check budget (assume $100 per trade)
    if (!skip && agent.cash < 100) skip = 'no_budget';

    if (skip) {
      agent.skips[skip] = (agent.skips[skip] || 0) + 1;
    } else {
      agent.trades++;
      agent.cash -= 100;
      agent.positions.push(signal.ticker);
    }
  }
}

console.log('Results by agent:');
for (const [agentId, agent] of Object.entries(agents)) {
  console.log('\n' + agentId.toUpperCase() + ':');
  console.log('  Trades executed:', agent.trades);
  console.log('  Skip reasons:', agent.skips);
  console.log('  Final positions:', agent.positions.length);
}
