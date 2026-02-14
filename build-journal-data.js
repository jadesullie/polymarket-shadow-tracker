#!/usr/bin/env node
/**
 * Build Journal data from RAW trade events (BUY, SELL, REDEEM independently)
 * No matching — every event is its own row
 */
const fs = require('fs');
const path = require('path');

const tradersDb = JSON.parse(fs.readFileSync('../memory/polymarket-traders-db.json', 'utf8'));
const traderNames = {};
tradersDb.forEach(t => { traderNames[t.address.toLowerCase()] = t.name; });

const dir = 'data/raw-trades';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

const noise = /Up or Down/i;
const cryptoPrice = /\b(Bitcoin|BTC|Ethereum|ETH|Solana|SOL|XRP|Dogecoin|DOGE)\b.*(above|below|dip|reach|less than|between|price of|hit \$|FDV)/i;

const events = [];

for (const f of files) {
  const wallet = f.replace('.json', '').toLowerCase();
  const name = traderNames[wallet] || wallet.substring(0, 12);
  const trades = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  
  for (const t of trades) {
    const title = t.title || '';
    if (!title) continue;
    if (noise.test(title) || cryptoPrice.test(title)) continue;
    
    // Only BUY, SELL, REDEEM
    if (t.type === 'TRADE' && (t.side === 'BUY' || t.side === 'SELL')) {
      events.push({
        ts: t.timestamp,
        type: t.side, // BUY or SELL
        trader: name,
        market: title,
        side: t.outcome || 'Yes',
        price: t.price || 0,
        size: t.usdcSize || 0, // dollar amount
        shares: t.size || 0
      });
    } else if (t.type === 'REDEEM') {
      events.push({
        ts: t.timestamp,
        type: 'REDEEM',
        trader: name,
        market: title,
        side: t.outcome || '',
        price: 0,
        size: t.usdcSize || 0,
        shares: t.size || 0
      });
    }
  }
}

// Sort by timestamp
events.sort((a, b) => a.ts - b.ts);

// Stats
const buys = events.filter(e => e.type === 'BUY');
const sells = events.filter(e => e.type === 'SELL');
const redeems = events.filter(e => e.type === 'REDEEM');

console.log(`Total events: ${events.length}`);
console.log(`  BUY: ${buys.length} ($${(buys.reduce((s,e)=>s+e.size,0)/1e6).toFixed(1)}M)`);
console.log(`  SELL: ${sells.length} ($${(sells.reduce((s,e)=>s+e.size,0)/1e6).toFixed(1)}M)`);
console.log(`  REDEEM: ${redeems.length} ($${(redeems.reduce((s,e)=>s+e.size,0)/1e6).toFixed(1)}M)`);

// Date range
const first = new Date(events[0].ts * 1000).toISOString().substring(0,10);
const last = new Date(events[events.length-1].ts * 1000).toISOString().substring(0,10);
console.log(`Date range: ${first} to ${last}`);

// Unique traders
const traders = new Set(events.map(e => e.trader));
console.log(`Unique traders: ${traders.size}`);

// Sample day
const jan2 = events.filter(e => {
  const d = new Date(e.ts * 1000).toISOString().substring(0,10);
  return d === '2026-01-02';
});
console.log(`\nJan 2 2026: ${jan2.length} events (${jan2.filter(e=>e.type==='BUY').length} buys, ${jan2.filter(e=>e.type==='SELL').length} sells, ${jan2.filter(e=>e.type==='REDEEM').length} redeems)`);

fs.writeFileSync('data/journal-events.json', JSON.stringify(events));
console.log(`\nWritten to data/journal-events.json (${(fs.statSync('data/journal-events.json').size/1024/1024).toFixed(1)}MB)`);
