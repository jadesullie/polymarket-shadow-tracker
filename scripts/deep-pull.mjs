import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const BASE = '/Users/jadesullie/.openclaw/workspace/polymarket-tracker';
const DATA = join(BASE, 'data');
const RAW = join(DATA, 'raw-trades');
mkdirSync(RAW, { recursive: true });

const traders = JSON.parse(readFileSync(join(DATA, 'all-traders.json'), 'utf8'));
console.log(`Processing ${traders.length} traders...`);

// Fetch with retry
async function fetchJSON(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === retries - 1) { console.error(`Failed: ${url} - ${e.message}`); return []; }
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// Fetch all trades for one trader
async function fetchTrader(addr) {
  const cached = join(RAW, `${addr}.json`);
  // Use cache if exists and has data
  if (existsSync(cached)) {
    try {
      const d = JSON.parse(readFileSync(cached, 'utf8'));
      if (d.length > 0) { console.log(`  Cached: ${addr} (${d.length} trades)`); return d; }
    } catch {}
  }
  
  let all = [];
  let offset = 0;
  const MAX = 2000;
  
  while (offset < MAX) {
    const data = await fetchJSON(`https://data-api.polymarket.com/activity?user=${addr}&limit=500&offset=${offset}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 500) break;
    offset += 500;
    await new Promise(r => setTimeout(r, 200));
  }
  
  writeFileSync(cached, JSON.stringify(all));
  console.log(`  Fetched: ${addr} (${all.length} trades)`);
  return all;
}

// Process trades into closed positions
function processTraderTrades(trades) {
  // Group by market (eventSlug or slug)
  const markets = {};
  for (const t of trades) {
    const key = t.eventSlug || t.slug || t.title;
    if (!key) continue;
    if (!markets[key]) markets[key] = { 
      title: t.title, slug: t.slug, eventSlug: t.eventSlug,
      buys: [], sells: [], redemptions: [], trades: [] 
    };
    markets[key].trades.push(t);
    if (t.type === 'TRADE' && t.side === 'BUY') markets[key].buys.push(t);
    else if (t.type === 'TRADE' && t.side === 'SELL') markets[key].sells.push(t);
    else if (t.type === 'REDEMPTION') markets[key].redemptions.push(t);
  }
  
  const closedPositions = [];
  
  for (const [key, m] of Object.entries(markets)) {
    const totalBought = m.buys.reduce((s, t) => s + (parseFloat(t.usdcSize) || 0), 0);
    const totalSold = m.sells.reduce((s, t) => s + (parseFloat(t.usdcSize) || 0), 0);
    const totalRedeemed = m.redemptions.reduce((s, t) => s + (parseFloat(t.usdcSize) || 0), 0);
    const totalBuySize = m.buys.reduce((s, t) => s + (parseFloat(t.size) || 0), 0);
    const totalSellSize = m.sells.reduce((s, t) => s + (parseFloat(t.size) || 0), 0);
    
    const hasRedemptions = m.redemptions.length > 0;
    const soldMost = totalBuySize > 0 && totalSellSize / totalBuySize > 0.8;
    const isClosed = hasRedemptions || soldMost;
    
    if (!isClosed) continue;
    if (totalBought < 1) continue; // skip dust
    
    const pnl = (totalSold + totalRedeemed) - totalBought;
    
    // Weighted avg entry price
    let entryPrice = 0;
    if (totalBuySize > 0) {
      entryPrice = m.buys.reduce((s, t) => s + (parseFloat(t.price) || 0) * (parseFloat(t.size) || 0), 0) / totalBuySize;
    }
    
    // Exit price
    let exitPrice = 0;
    if (hasRedemptions) {
      exitPrice = 1.0; // redemption = won at $1
    } else if (totalSellSize > 0) {
      exitPrice = m.sells.reduce((s, t) => s + (parseFloat(t.price) || 0) * (parseFloat(t.size) || 0), 0) / totalSellSize;
    }
    
    // Determine outcome side from buys
    const outcomes = {};
    for (const t of m.buys) {
      const o = t.outcome || 'Unknown';
      outcomes[o] = (outcomes[o] || 0) + (parseFloat(t.usdcSize) || 0);
    }
    const side = Object.entries(outcomes).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown';
    
    // Date = most recent trade
    const dates = m.trades.map(t => t.timestamp).filter(Boolean).map(d => String(d)).sort();
    const date = dates.length > 0 ? (dates[dates.length - 1].includes('T') ? dates[dates.length - 1].split('T')[0] : dates[dates.length - 1].substring(0, 10)) : null;
    
    const outcome = hasRedemptions ? 'Won' : (pnl >= 0 ? 'Profit' : 'Loss');
    
    closedPositions.push({
      market: m.title,
      slug: m.slug || key,
      side,
      pnl: Math.round(pnl * 100) / 100,
      outcome,
      entryPrice: Math.round(entryPrice * 1000) / 1000,
      exitPrice: Math.round(exitPrice * 1000) / 1000,
      date,
      tradeCount: m.trades.length
    });
  }
  
  // Sort by absolute PnL descending
  closedPositions.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  return closedPositions;
}

// Main
async function main() {
  const CONCURRENCY = 10;
  const results = {};
  
  // Process in batches of CONCURRENCY
  for (let i = 0; i < traders.length; i += CONCURRENCY) {
    const batch = traders.slice(i, i + CONCURRENCY);
    console.log(`Batch ${Math.floor(i/CONCURRENCY)+1}/${Math.ceil(traders.length/CONCURRENCY)} (traders ${i+1}-${Math.min(i+CONCURRENCY, traders.length)})`);
    
    const promises = batch.map(async (trader) => {
      const trades = await fetchTrader(trader.address);
      const closed = processTraderTrades(trades);
      results[trader.address] = closed;
    });
    
    await Promise.all(promises);
  }
  
  // Write full trade history
  writeFileSync(join(DATA, 'trade-history-full.json'), JSON.stringify(results, null, 2));
  
  // Stats
  let totalPositions = 0;
  let tradersWithPositions = 0;
  for (const [addr, positions] of Object.entries(results)) {
    totalPositions += positions.length;
    if (positions.length > 0) tradersWithPositions++;
  }
  console.log(`\nDone! ${totalPositions} closed positions across ${tradersWithPositions}/${traders.length} traders`);
  
  // Now update index.html
  console.log('\nUpdating index.html...');
  const indexPath = join(BASE, 'index.html');
  let html = readFileSync(indexPath, 'utf8');
  
  // Build updated TRADERS array
  const updatedTraders = traders.map(t => ({
    ...t,
    closedPositions: results[t.address] || []
  }));
  
  // Find and replace the TRADERS array
  const startMarker = 'const TRADERS = [';
  const endMarker = ';\n\n';
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) {
    console.error('Could not find TRADERS array in index.html!');
    // Try alternative markers
    const alt = html.indexOf('const TRADERS =');
    if (alt === -1) {
      console.error('No TRADERS const found at all!');
      return;
    }
  }
  
  // Find the end of the array - look for ]; followed by newlines and next const/comment
  const afterStart = html.indexOf(startMarker) + startMarker.length - 1; // position of [
  let depth = 0;
  let endIdx = -1;
  for (let j = afterStart; j < html.length; j++) {
    if (html[j] === '[') depth++;
    else if (html[j] === ']') {
      depth--;
      if (depth === 0) { endIdx = j + 1; break; }
    }
  }
  
  if (endIdx === -1) {
    console.error('Could not find end of TRADERS array!');
    return;
  }
  
  const newArray = 'const TRADERS = ' + JSON.stringify(updatedTraders, null, 2);
  html = html.substring(0, html.indexOf(startMarker)) + newArray + html.substring(endIdx);
  
  writeFileSync(indexPath, html);
  console.log('index.html updated successfully!');
}

main().catch(e => { console.error(e); process.exit(1); });
