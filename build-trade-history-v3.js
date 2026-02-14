#!/usr/bin/env node
/**
 * Build trade history v3: includes both SELL exits and REDEEM exits
 * For each wallet, group trades by conditionId+outcome, match BUYs with SELLs/REDEEMs
 */
const fs = require('fs');
const path = require('path');

const tradersDb = JSON.parse(fs.readFileSync('../memory/polymarket-traders-db.json', 'utf8'));
const traderNames = {};
tradersDb.forEach(t => { traderNames[t.address.toLowerCase()] = t.name; });

const dir = 'data/raw-trades';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

const noise = /Up or Down.*\d+.*(?:AM|PM)/i;
const cryptoPrice = /\b(Bitcoin|BTC|Ethereum|ETH|Solana|SOL|XRP|Dogecoin|DOGE)\b.*(above|below)\s*\$|FDV above/i;

const allPositions = {};
let totalMatched = 0, sellExits = 0, redeemExits = 0, unmatched = 0;

for (const f of files) {
  const wallet = f.replace('.json', '').toLowerCase();
  const name = traderNames[wallet] || wallet.substring(0, 10);
  const trades = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  
  // Group by conditionId + outcome (Yes/No side)
  const positions = {};
  
  for (const t of trades) {
    if (t.type === 'TRADE' || t.type === 'REDEEM') {
      const key = t.conditionId + '_' + (t.outcome || 'unknown');
      if (!positions[key]) positions[key] = { buys: [], sells: [], redeems: [], conditionId: t.conditionId, outcome: t.outcome, market: t.title || '' };
      
      if (t.type === 'TRADE' && t.side === 'BUY') {
        positions[key].buys.push({ price: t.price || (t.usdcSize / t.size), size: t.usdcSize || t.size, ts: t.timestamp, market: t.title || positions[key].title });
      } else if (t.type === 'TRADE' && t.side === 'SELL') {
        positions[key].sells.push({ price: t.price || (t.usdcSize / t.size), size: t.usdcSize || t.size, ts: t.timestamp });
      } else if (t.type === 'REDEEM') {
        positions[key].redeems.push({ size: t.usdcSize || t.size, ts: t.timestamp });
      }
      
      if (t.title) positions[key].title = t.title;
    }
  }
  
  // For each position group, calculate entry and exit
  const walletPositions = [];
  
  for (const [key, pos] of Object.entries(positions)) {
    if (!pos.buys.length) continue;
    if (!pos.title) continue;
    if (noise.test(pos.title) || cryptoPrice.test(pos.title)) continue;
    
    // Weighted average entry price
    let totalCost = 0, totalSize = 0;
    let firstBuyTs = Infinity;
    for (const b of pos.buys) {
      totalCost += b.size;
      totalSize += b.size / b.price;
      if (b.ts < firstBuyTs) firstBuyTs = b.ts;
    }
    const avgEntryPrice = totalCost / totalSize;
    
    if (pos.redeems.length > 0) {
      // REDEEM exit: market resolved. Price is $1 for winning side, $0 for losing
      const redeemTotal = pos.redeems.reduce((s, r) => s + r.size, 0);
      const lastRedeemTs = Math.max(...pos.redeems.map(r => r.ts));
      // If redeemed, the exit price is effectively 1.0 (you get $1 per share)
      const exitPrice = redeemTotal / totalSize;
      const pnl = redeemTotal - totalCost;
      
      walletPositions.push({
        trader: name,
        market: pos.title,
        side: pos.outcome || 'Yes',
        entryPrice: avgEntryPrice,
        exitPrice: Math.min(exitPrice, 1),
        entryDate: firstBuyTs,
        exitDate: lastRedeemTs,
        exitType: 'REDEEM',
        outcome: pnl >= 0 ? 'Profit' : 'Loss',
        pnl: pnl,
        costBasis: totalCost
      });
      redeemExits++;
      totalMatched++;
    } else if (pos.sells.length > 0) {
      // SELL exit: trader closed position
      let sellRevenue = 0;
      let lastSellTs = 0;
      for (const s of pos.sells) {
        sellRevenue += s.size;
        if (s.ts > lastSellTs) lastSellTs = s.ts;
      }
      const avgExitPrice = sellRevenue / (sellRevenue / (pos.sells.reduce((s, x) => s + x.size, 0) / pos.sells.reduce((s, x) => s + x.size / x.price, 0)));
      const pnl = sellRevenue - totalCost;
      
      walletPositions.push({
        trader: name,
        market: pos.title,
        side: pos.outcome || 'Yes',
        entryPrice: avgEntryPrice,
        exitPrice: sellRevenue / totalSize,
        entryDate: firstBuyTs,
        exitDate: lastSellTs,
        exitType: 'SELL',
        outcome: pnl >= 0 ? 'Profit' : 'Loss',
        pnl: pnl,
        costBasis: totalCost
      });
      sellExits++;
      totalMatched++;
    } else {
      unmatched++; // Still open or no exit
    }
  }
  
  if (walletPositions.length) {
    allPositions[wallet] = walletPositions;
  }
}

// Flatten for stats
const all = Object.values(allPositions).flat();
const redeems = all.filter(p => p.exitType === 'REDEEM');
const sells = all.filter(p => p.exitType === 'SELL');

console.log(`Total matched positions: ${totalMatched}`);
console.log(`  REDEEM exits: ${redeemExits} (WR: ${(redeems.filter(p=>p.outcome==='Profit').length/redeems.length*100).toFixed(1)}%)`);
console.log(`  SELL exits: ${sellExits} (WR: ${(sells.filter(p=>p.outcome==='Profit').length/sells.length*100).toFixed(1)}%)`);
console.log(`  Unmatched (still open): ${unmatched}`);
console.log(`  Total PnL (REDEEM): $${redeems.reduce((s,p)=>s+p.pnl,0).toFixed(0)}`);
console.log(`  Total PnL (SELL): $${sells.reduce((s,p)=>s+p.pnl,0).toFixed(0)}`);
console.log(`  Combined PnL: $${all.reduce((s,p)=>s+p.pnl,0).toFixed(0)}`);

fs.writeFileSync('data/trade-history-v3.json', JSON.stringify(allPositions, null, 2));
console.log('Written to data/trade-history-v3.json');
