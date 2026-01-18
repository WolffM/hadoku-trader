const d = require('./trader-db-export.json');

// Build price lookup
const prices = new Map();
d.market_prices.forEach(p => {
  prices.set(p.ticker + ':' + p.date, p.close);
});

function getPrice(ticker, date) {
  return prices.get(ticker + ':' + date) || null;
}

// Get all price dates sorted
const allDates = [...new Set(d.market_prices.map(p => p.date))].sort();
const tradingDates = allDates.filter(d => d >= '2025-06-12');

// Find an early signal with price data
const signal = d.signals
  .filter(s => 
    s.action === 'buy' && 
    s.disclosure_date >= '2025-06-12' &&
    s.disclosure_date <= '2025-07-01' &&
    getPrice(s.ticker, s.disclosure_date)
  )
  .sort((a, b) => a.disclosure_date.localeCompare(b.disclosure_date))[0];

console.log('=== TRACKING A SINGLE POSITION ===');
console.log('Signal:', signal.ticker, '-', signal.politician_name);
console.log('Disclosure date:', signal.disclosure_date);

const entryPrice = getPrice(signal.ticker, signal.disclosure_date);
console.log('Entry price:', entryPrice.toFixed(2));

let highestPrice = entryPrice;
let daysHeld = 0;

console.log('\nTracking until exit or end of data:');

for (const date of tradingDates) {
  if (date < signal.disclosure_date) continue;
  
  const price = getPrice(signal.ticker, date);
  if (!price) continue;
  
  if (price > highestPrice) highestPrice = price;
  
  const returnPct = ((price - entryPrice) / entryPrice) * 100;
  const dropFromHigh = ((highestPrice - price) / highestPrice) * 100;
  
  // Check exit conditions
  let exit = null;
  // ChatGPT: 15% trailing stop
  if (dropFromHigh >= 15) exit = 'TRAILING_STOP (15%)';
  // ChatGPT: 60 day soft stop if return <= 0
  if (daysHeld >= 60 && returnPct <= 0) exit = 'SOFT_STOP (60d)';
  // Time exit 120 days
  if (daysHeld >= 120) exit = 'TIME_EXIT (120d)';
  // Claude: Fixed 16% stop loss
  if (returnPct <= -16) exit = 'FIXED_STOP (16%)';
  
  if (daysHeld % 10 === 0 || exit) {
    console.log(
      'Day', String(daysHeld).padStart(3), '|',
      date, '|',
      signal.ticker.padEnd(5), '|',
      '$' + price.toFixed(2).padStart(7), '|',
      'Return:', (returnPct >= 0 ? '+' : '') + returnPct.toFixed(1).padStart(5) + '%', '|',
      'Drop:', dropFromHigh.toFixed(1).padStart(4) + '%',
      exit ? '→ EXIT: ' + exit : ''
    );
  }
  
  if (exit) {
    console.log('\n*** Position closes on', date, 'after', daysHeld, 'days');
    console.log('*** Entry:', entryPrice.toFixed(2), '-> Exit:', price.toFixed(2));
    console.log('*** P&L:', (returnPct >= 0 ? '+' : '') + returnPct.toFixed(2) + '%');
    break;
  }
  
  daysHeld++;
}

if (daysHeld >= tradingDates.length - 1) {
  console.log('\n*** Position still open at end of simulation');
}
