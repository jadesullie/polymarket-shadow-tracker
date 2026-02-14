const fs = require('fs');
const { execSync } = require('child_process');

const batch2 = JSON.parse(fs.readFileSync('/Users/jadesullie/.openclaw/workspace/memory/polymarket-traders-batch2.json', 'utf8'));
const existing = JSON.parse(fs.readFileSync('data/traders.json', 'utf8'));

// Normalize batch2 traders
const normalized = batch2.map(t => ({
  username: t.username || '',
  address: t.address || '',
  profileUrl: t.profileUrl || `https://polymarket.com/@${t.username}`,
  twitter: t.twitter || null,
  pnl: t.pnl || 0,
  volume: t.volume || 0,
  activePositionsValue: t.activePositionsValue || 0,
  predictions: t.predictions || 0,
  joinDate: t.joinDate || '',
  categories: t.categories || [],
  activePositions: t.activePositions || [],
  insiderRisk: t.insiderRisk || 'MEDIUM',
  edgeThesis: t.edgeThesis || '',
  cluster: t.cluster || 'mixed',
  closedPositions: t.closedPositions || [],
  source: t.source || ''
}));

// Merge - no overlap found, just concat
const allTraders = [...existing, ...normalized];
console.log(`Merged: ${existing.length} existing + ${normalized.length} new = ${allTraders.length} total`);

// Pull history for new traders in batches
const BATCH_SIZE = 10;
const newWithAddr = normalized.filter(t => t.address);
console.log(`Pulling history for ${newWithAddr.length} new traders...`);

async function pullBatch(traders) {
  const results = {};
  const cmds = traders.map(t => {
    const addr = t.address.toLowerCase();
    return `curl -s "https://data-api.polymarket.com/activity?user=${addr}&limit=100" > /tmp/poly_${addr.slice(0,10)}.json 2>/dev/null &`;
  });
  execSync(cmds.join('\n') + '\nwait', { shell: '/bin/bash', timeout: 30000 });
  
  for (const t of traders) {
    const addr = t.address.toLowerCase();
    const file = `/tmp/poly_${addr.slice(0,10)}.json`;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      results[addr] = data;
    } catch(e) {
      results[addr] = [];
    }
    try { fs.unlinkSync(file); } catch(e) {}
  }
  return results;
}

function aggregatePositions(activities) {
  if (!Array.isArray(activities) || activities.length === 0) return [];
  
  const markets = {};
  for (const a of activities) {
    const slug = a.slug || a.market_slug || a.title || 'unknown';
    if (!markets[slug]) markets[slug] = { bought: 0, sold: 0, redeemed: 0, title: a.title || slug };
    
    const amount = Math.abs(parseFloat(a.usd_amount || a.amount || 0));
    const type = (a.type || a.transaction_type || '').toUpperCase();
    
    if (type === 'BUY' || type === 'TRADE' && parseFloat(a.usd_amount || 0) < 0) {
      markets[slug].bought += amount;
    } else if (type === 'SELL') {
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
        status: isClosed ? 'closed' : 'partial'
      });
    }
  }
  
  return closed.sort((a, b) => b.pnl - a.pnl);
}

(async () => {
  for (let i = 0; i < newWithAddr.length; i += BATCH_SIZE) {
    const batch = newWithAddr.slice(i, i + BATCH_SIZE);
    console.log(`  Batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(newWithAddr.length/BATCH_SIZE)} (${batch.length} traders)...`);
    
    const results = await pullBatch(batch);
    
    for (const t of batch) {
      const addr = t.address.toLowerCase();
      const activities = results[addr] || [];
      const trader = allTraders.find(at => at.address === t.address);
      if (trader) {
        trader.closedPositions = aggregatePositions(activities);
      }
    }
  }
  
  // Save merged data
  fs.writeFileSync('data/all-traders.json', JSON.stringify(allTraders, null, 2));
  console.log(`Saved ${allTraders.length} traders to data/all-traders.json`);
  
  // Update index.html
  const html = fs.readFileSync('index.html', 'utf8');
  const start = html.indexOf('const TRADERS = [');
  const end = html.indexOf('// Replace at build');
  
  if (start === -1) {
    console.error('Could not find "const TRADERS = [" in index.html');
    // Try alternative marker
    const alt = html.indexOf('const TRADERS =');
    if (alt === -1) {
      console.error('Could not find TRADERS array at all!');
      process.exit(1);
    }
  }
  
  if (end === -1) {
    console.error('Could not find "// Replace at build" marker');
    // Find end of array - look for ]; after the TRADERS start
    const afterStart = html.indexOf('];', start);
    if (afterStart === -1) {
      console.error('Could not find end of TRADERS array');
      process.exit(1);
    }
    const newHtml = html.substring(0, start) + 'const TRADERS = ' + JSON.stringify(allTraders, null, 2) + ';\n\n' + html.substring(afterStart + 2);
    fs.writeFileSync('index.html', newHtml);
  } else {
    const newHtml = html.substring(0, start) + 'const TRADERS = ' + JSON.stringify(allTraders, null, 2) + ';\n\n' + html.substring(end);
    fs.writeFileSync('index.html', newHtml);
  }
  
  console.log('Updated index.html with merged traders');
})();
