const fs = require('fs');
const { execSync } = require('child_process');

const traders = JSON.parse(fs.readFileSync('data/all-traders.json', 'utf8'));
console.log(`Pulling FULL history for ${traders.length} traders...`);

function fetchPage(address, offset) {
  const addr = address.toLowerCase();
  try {
    const out = execSync(
      `curl -s "https://data-api.polymarket.com/activity?user=${addr}&limit=500&offset=${offset}"`,
      { timeout: 20000 }
    );
    return JSON.parse(out.toString());
  } catch(e) {
    return [];
  }
}

function fetchAll(address) {
  let all = [];
  let offset = 0;
  while (true) {
    const page = fetchPage(address, offset);
    if (!Array.isArray(page) || page.length === 0) break;
    all = all.concat(page);
    if (page.length < 500) break; // last page
    offset += 500;
    if (offset > 10000) break; // safety cap
  }
  return all;
}

function aggregatePositions(activities) {
  if (!Array.isArray(activities) || activities.length === 0) return [];
  
  const markets = {};
  for (const a of activities) {
    const slug = a.slug || a.market_slug || a.conditionId || a.title || 'unknown';
    const title = a.title || a.question || slug;
    if (!markets[slug]) markets[slug] = { bought: 0, sold: 0, redeemed: 0, title, trades: 0 };
    
    const amount = Math.abs(parseFloat(a.usdcSize || a.usd_amount || a.amount || a.value || 0));
    const type = (a.type || '').toUpperCase();
    const side = (a.side || '').toUpperCase();
    
    markets[slug].trades++;
    
    if (type === 'TRADE') {
      if (side === 'BUY') markets[slug].bought += amount;
      else if (side === 'SELL') markets[slug].sold += amount;
    } else if (type === 'BUY' || side === 'BUY') {
      markets[slug].bought += amount;
    } else if (type === 'SELL' || side === 'SELL') {
      markets[slug].sold += amount;
    } else if (type === 'REDEMPTION' || type === 'REDEEM') {
      markets[slug].redeemed += amount;
    }
  }
  
  const closed = [];
  for (const [slug, m] of Object.entries(markets)) {
    const totalReturn = m.sold + m.redeemed;
    const pnl = totalReturn - m.bought;
    const isClosed = m.redeemed > 0 || (m.bought > 0 && m.sold > m.bought * 0.9);
    
    if (isClosed || totalReturn > 0) {
      closed.push({
        market: m.title,
        invested: Math.round(m.bought),
        returned: Math.round(totalReturn),
        pnl: Math.round(pnl),
        status: isClosed ? 'closed' : 'partial',
        trades: m.trades
      });
    }
  }
  
  return closed.sort((a, b) => b.pnl - a.pnl);
}

// Process all traders sequentially (to avoid rate limits), but batch curls for speed
const BATCH = 5;
let totalActivities = 0;
let totalPages = 0;

for (let i = 0; i < traders.length; i++) {
  const t = traders[i];
  if (!t.address) {
    console.log(`  [${i+1}/${traders.length}] ${t.username} — no address, skip`);
    continue;
  }
  
  process.stdout.write(`  [${i+1}/${traders.length}] ${t.username}...`);
  const activities = fetchAll(t.address);
  const closed = aggregatePositions(activities);
  t.closedPositions = closed;
  t.totalHistoricalTrades = activities.length;
  
  const pages = Math.ceil(activities.length / 500) || 1;
  totalPages += pages;
  totalActivities += activities.length;
  console.log(` ${activities.length} activities, ${pages} page(s), ${closed.length} closed positions`);
}

console.log(`\nDone! ${totalActivities} total activities across ${totalPages} pages`);
const withClosed = traders.filter(t => t.closedPositions && t.closedPositions.length > 0);
console.log(`${withClosed.length}/${traders.length} traders have closed positions`);

fs.writeFileSync('data/all-traders.json', JSON.stringify(traders, null, 2));
console.log('Saved to data/all-traders.json');

// Update index.html
const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('const TRADERS = [');
if (start === -1) { console.error('Cannot find TRADERS in index.html'); process.exit(1); }

const endMarker = html.indexOf('// Replace at build');
if (endMarker !== -1) {
  const newHtml = html.substring(0, start) + 'const TRADERS = ' + JSON.stringify(traders, null, 2) + ';\n\n' + html.substring(endMarker);
  fs.writeFileSync('index.html', newHtml);
} else {
  // Find end of array
  let depth = 0, found = false;
  for (let j = start; j < html.length; j++) {
    if (html[j] === '[') depth++;
    if (html[j] === ']') { depth--; if (depth === 0) {
      const semi = html[j+1] === ';' ? j+2 : j+1;
      const newHtml = html.substring(0, start) + 'const TRADERS = ' + JSON.stringify(traders, null, 2) + ';\n\n' + html.substring(semi);
      fs.writeFileSync('index.html', newHtml);
      found = true; break;
    }}
  }
  if (!found) { console.error('Cannot find end of TRADERS array'); process.exit(1); }
}
console.log('Updated index.html');
