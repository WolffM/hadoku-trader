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

console.log('Trading dates:', tradingDates.length, '(', tradingDates[0], '-', tradingDates[tradingDates.length-1], ')');

// Simulate one position and track price changes
const signal = d.signals.find(s => 
  s.action === 'buy' && 
  s.disclosure_date >= '2025-06-12' && 
  getPrice(s.ticker, s.disclosure_date)
);

console.log('\n=== TRACKING A SINGLE POSITION ===');
console.log('Signal:', signal.ticker, signal.politician_name);
console.log('Disclosure date:', signal.disclosure_date);

const entryPrice = getPrice(signal.ticker, signal.disclosure_date);
console.log('Entry price:', entryPrice.toFixed(2));

let highestPrice = entryPrice;
let daysHeld = 0;

console.log('\nDay-by-day tracking:');
console.log('Day | Date       | Price  | Return% | High   | DropFromHigh%');
console.log('--- | ---------- | ------ | ------- | ------ | -------------');

for (const date of tradingDates) {
  if (date < signal.disclosure_date) continue;
  
  const price = getPrice(signal.ticker, date);
  if (!price) continue;
  
  if (price > highestPrice) highestPrice = price;
  
  const returnPct = ((price - entryPrice) / entryPrice) * 100;
  const dropFromHigh = ((highestPrice - price) / highestPrice) * 100;
  
  // Check exit conditions (ChatGPT: 15% trailing stop, 60 day soft stop if return <= 0)
  let exit = null;
  if (dropFromHigh >= 15) exit = 'TRAILING_STOP (15%)';
  if (daysHeld >= 60 && returnPct <= 0) exit = 'SOFT_STOP (60d, return<=0)';
  if (daysHeld >= 120) exit = 'TIME_EXIT (120d)';
  
  console.log(
    String(daysHeld).padStart(3) + ' |',
    date, '|',
    price.toFixed(2).padStart(6), '|',
    (returnPct >= 0 ? '+' : '') + returnPct.toFixed(1).padStart(5) + '%', '|',
    highestPrice.toFixed(2).padStart(6), '|',
    dropFromHigh.toFixed(1).padStart(5) + '%',
    exit ? '→ ' + exit : ''
  );
  
  if (exit) {
    console.log('\n*** Position would close on', date, 'due to', exit);
    break;
  }
  
  daysHeld++;
  
  // Only show first 30 days for brevity
  if (daysHeld > 30) {
    console.log('... (continuing to track)');
    break;
  }
}
