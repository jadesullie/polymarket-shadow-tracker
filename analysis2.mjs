import { readFileSync } from 'fs';

const traders = JSON.parse(readFileSync('/Users/jadesullie/.openclaw/workspace/polymarket-tracker/data/all-traders.json', 'utf8'));
const tradeHistory = JSON.parse(readFileSync('/Users/jadesullie/.openclaw/workspace/polymarket-tracker/data/trade-history-full.json', 'utf8'));

const traderByAddr = {};
for (const t of traders) traderByAddr[t.address] = t;

// Build full trade list with metadata
const allTrades = [];
for (const [addr, trades] of Object.entries(tradeHistory)) {
  const trader = traderByAddr[addr];
  if (!trader || trades.length === 0) continue;
  for (const trade of trades) {
    allTrades.push({ ...trade, trader: trader.username, cluster: trader.cluster, risk: trader.insiderRisk });
  }
}

// ============================================================
// MORE DETAILED OVERLAP: traders with >1 shared market
// ============================================================
const traderMarkets = {};
for (const [addr, trades] of Object.entries(tradeHistory)) {
  const trader = traderByAddr[addr];
  if (!trader || trades.length === 0) continue;
  traderMarkets[trader.username] = new Set(trades.map(t => t.slug));
}

console.log("=== MULTI-MARKET OVERLAPS ===");
const usernames = Object.keys(traderMarkets);
for (let i = 0; i < usernames.length; i++) {
  for (let j = i + 1; j < usernames.length; j++) {
    const a = traderMarkets[usernames[i]];
    const b = traderMarkets[usernames[j]];
    const intersection = [...a].filter(x => b.has(x));
    if (intersection.length >= 2) {
      console.log(`${usernames[i]} ↔ ${usernames[j]}: ${intersection.length} shared (${intersection.join(', ')})`);
    }
  }
}

// ============================================================
// SAME SIDE ANALYSIS: When traders overlap, do they bet same direction?
// ============================================================
console.log("\n=== SAME SIDE ANALYSIS ===");
const marketTraders = {};
for (const trade of allTrades) {
  const key = trade.slug;
  if (!marketTraders[key]) marketTraders[key] = [];
  marketTraders[key].push({ trader: trade.trader, side: trade.side, pnl: trade.pnl, outcome: trade.outcome });
}

const multiTraderMarkets = Object.entries(marketTraders).filter(([_, trades]) => trades.length > 1);
console.log(`Markets with multiple tracked traders: ${multiTraderMarkets.length}`);
for (const [slug, entries] of multiTraderMarkets.sort((a,b) => b[1].length - a[1].length).slice(0, 20)) {
  const sides = entries.map(e => `${e.trader}(${e.side}, $${e.pnl.toFixed(0)})`).join(', ');
  console.log(`${slug}: ${sides}`);
}

// ============================================================
// MARKET CATEGORY ANALYSIS from trade slugs
// ============================================================
console.log("\n=== MARKET THEMES (keyword analysis) ===");
const keywords = {
  'iran': ['iran', 'khamenei', 'iranian'],
  'fed': ['fed', 'interest-rate', 'federal-reserve'],
  'politics-us': ['trump', 'republican', 'democrat', 'presidential', 'house', 'senate', 'congress'],
  'geopolitics': ['ukraine', 'russia', 'ceasefire', 'israel', 'hamas', 'lebanon', 'venezuela', 'mexico'],
  'crypto': ['bitcoin', 'solana', 'xrp', 'crypto', 'sol', 'btc'],
  'elon': ['elon', 'musk', 'tesla', 'spacex', 'doge'],
  'sports': ['ufc', 'nfl', 'nba', 'super-bowl', 'lakers', 'seahawks', 'patriots', 'bruins', 'lightning', 'premier-league', 'epl', 'lol'],
  'elections-intl': ['portugal', 'thai', 'bangladesh', 'costa-ric', 'seguro', 'ventura'],
  'tech': ['claude', 'openai', 'gpt', 'ai-', 'apple', 'google'],
  'culture': ['grammy', 'oscar', 'academy', 'lady-gaga', 'cardi-b', 'stranger-things', 'sinners']
};

const themeStats = {};
for (const trade of allTrades) {
  const slug = (trade.slug || '').toLowerCase();
  const market = (trade.market || '').toLowerCase();
  const combined = slug + ' ' + market;
  
  for (const [theme, kws] of Object.entries(keywords)) {
    if (kws.some(kw => combined.includes(kw))) {
      if (!themeStats[theme]) themeStats[theme] = { count: 0, wins: 0, totalPnl: 0, traders: new Set() };
      themeStats[theme].count++;
      if (trade.pnl > 0) themeStats[theme].wins++;
      themeStats[theme].totalPnl += trade.pnl;
      themeStats[theme].traders.add(trade.trader);
    }
  }
}

console.log("Theme | Trades | Traders | WinRate | TotalPnL | AvgPnL");
for (const [theme, s] of Object.entries(themeStats).sort((a, b) => b[1].totalPnl - a[1].totalPnl)) {
  console.log(`${theme} | ${s.count} | ${s.traders.size} | ${(s.wins/s.count*100).toFixed(1)}% | $${s.totalPnl.toFixed(0)} | $${(s.totalPnl/s.count).toFixed(0)}`);
}

// ============================================================
// ENTRY PRICE DISTRIBUTION (for copy delay modeling)
// ============================================================
console.log("\n=== ENTRY PRICE DISTRIBUTION ===");
const profitTrades = allTrades.filter(t => t.pnl > 0 && t.entryPrice > 0);
const entryPrices = profitTrades.map(t => t.entryPrice);
const buckets = { '0-0.1': 0, '0.1-0.2': 0, '0.2-0.3': 0, '0.3-0.5': 0, '0.5-0.7': 0, '0.7-0.9': 0, '0.9-1.0': 0 };
for (const p of entryPrices) {
  if (p < 0.1) buckets['0-0.1']++;
  else if (p < 0.2) buckets['0.1-0.2']++;
  else if (p < 0.3) buckets['0.2-0.3']++;
  else if (p < 0.5) buckets['0.3-0.5']++;
  else if (p < 0.7) buckets['0.5-0.7']++;
  else if (p < 0.9) buckets['0.7-0.9']++;
  else buckets['0.9-1.0']++;
}
console.log("Entry Price Range | Count");
for (const [range, count] of Object.entries(buckets)) {
  console.log(`${range} | ${count}`);
}

// Average spread (exit - entry) for profitable trades
const spreads = profitTrades.map(t => t.exitPrice - t.entryPrice);
const avgSpread = spreads.reduce((a,b) => a+b, 0) / spreads.length;
console.log(`\nAvg price spread on winning trades: ${(avgSpread*100).toFixed(1)} cents`);
console.log(`Median spread: ${(spreads.sort((a,b) => a-b)[Math.floor(spreads.length/2)]*100).toFixed(1)} cents`);

// ============================================================
// RISK TIER DETAILED BREAKDOWN
// ============================================================
console.log("\n=== RISK TIER DETAILED ===");
for (const risk of ['EXTREME', 'HIGH', 'MEDIUM', 'LOW']) {
  const riskTraders = traders.filter(t => t.insiderRisk === risk);
  const withTrades = riskTraders.filter(t => {
    const trades = tradeHistory[t.address];
    return trades && trades.length > 0;
  });
  
  console.log(`\n--- ${risk} (${riskTraders.length} total, ${withTrades.length} with trades) ---`);
  for (const t of withTrades) {
    const trades = tradeHistory[t.address];
    const pnl = trades.reduce((s, tr) => s + tr.pnl, 0);
    const wr = trades.filter(tr => tr.pnl > 0).length / trades.length;
    console.log(`  ${t.username} | ${t.cluster} | ${trades.length} trades | PnL: $${pnl.toFixed(0)} | WR: ${(wr*100).toFixed(0)}%`);
  }
}

// ============================================================
// RESOLUTION TIME: use trade dates to estimate holding periods
// ============================================================
console.log("\n=== TRADE DATE DISTRIBUTION ===");
const dates = allTrades.map(t => parseInt(t.date)).filter(d => !isNaN(d) && d > 1700000000);
const minDate = Math.min(...dates);
const maxDate = Math.max(...dates);
console.log(`Earliest trade: ${new Date(minDate * 1000).toISOString()}`);
console.log(`Latest trade: ${new Date(maxDate * 1000).toISOString()}`);
console.log(`Span: ${((maxDate - minDate) / 86400).toFixed(0)} days`);

// Monthly breakdown
const monthStats = {};
for (const trade of allTrades) {
  const d = new Date(parseInt(trade.date) * 1000);
  if (isNaN(d.getTime())) continue;
  const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
  if (!monthStats[key]) monthStats[key] = { count: 0, wins: 0, pnl: 0 };
  monthStats[key].count++;
  if (trade.pnl > 0) monthStats[key].wins++;
  monthStats[key].pnl += trade.pnl;
}

console.log("\nMonth | Trades | Wins | WR | PnL");
for (const [month, s] of Object.entries(monthStats).sort()) {
  console.log(`${month} | ${s.count} | ${s.wins} | ${(s.wins/s.count*100).toFixed(0)}% | $${s.pnl.toFixed(0)}`);
}

// ============================================================
// FULL TRADER ROSTER with all stats (for the report)
// ============================================================
console.log("\n=== FULL TRADER ROSTER ===");
const allStats = [];
for (const t of traders) {
  const trades = tradeHistory[t.address] || [];
  if (trades.length === 0) {
    allStats.push({
      username: t.username, cluster: t.cluster, risk: t.insiderRisk,
      tradeCount: 0, totalPnl: 0, winRate: 0, sharpe: 0,
      profilePnl: t.pnl, activeValue: t.activePositionsValue,
      closedPnl: (t.closedPositions || []).reduce((s, p) => s + p.pnl, 0),
      status: 'NO_TRADE_HISTORY'
    });
    continue;
  }
  
  const pnls = trades.map(tr => tr.pnl);
  const totalPnl = pnls.reduce((a,b) => a+b, 0);
  const avgReturn = totalPnl / trades.length;
  const variance = pnls.reduce((sum, p) => sum + (p - avgReturn) ** 2, 0) / pnls.length;
  const sharpe = Math.sqrt(variance) > 0 ? avgReturn / Math.sqrt(variance) : 0;
  const wr = trades.filter(tr => tr.pnl > 0).length / trades.length;
  
  allStats.push({
    username: t.username, cluster: t.cluster, risk: t.insiderRisk,
    tradeCount: trades.length, totalPnl, winRate: wr, sharpe,
    profilePnl: t.pnl, activeValue: t.activePositionsValue,
    closedPnl: (t.closedPositions || []).reduce((s, p) => s + p.pnl, 0),
    status: totalPnl > 0 ? 'PROFITABLE' : totalPnl < 0 ? 'LOSING' : 'BREAKEVEN'
  });
}

// Summary
const profitable = allStats.filter(s => s.status === 'PROFITABLE');
const losing = allStats.filter(s => s.status === 'LOSING');
const noHistory = allStats.filter(s => s.status === 'NO_TRADE_HISTORY');
console.log(`Profitable: ${profitable.length} | Losing: ${losing.length} | Breakeven: ${allStats.filter(s => s.status === 'BREAKEVEN').length} | No history: ${noHistory.length}`);
console.log(`Total: ${allStats.length}`);

// Active positions value analysis
console.log("\n=== TRADERS WITH LARGE ACTIVE POSITIONS (but no trade history) ===");
for (const t of noHistory.filter(s => s.activeValue > 0).sort((a,b) => b.activeValue - a.activeValue)) {
  console.log(`${t.username} | ${t.cluster} | ${t.risk} | ActiveValue: $${t.activeValue} | ProfilePnL: $${t.profilePnl} | ClosedPnL: $${t.closedPnl}`);
}
