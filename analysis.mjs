import { readFileSync, writeFileSync } from 'fs';

const traders = JSON.parse(readFileSync('/Users/jadesullie/.openclaw/workspace/polymarket-tracker/data/all-traders.json', 'utf8'));
const tradeHistory = JSON.parse(readFileSync('/Users/jadesullie/.openclaw/workspace/polymarket-tracker/data/trade-history-full.json', 'utf8'));

// Build address->trader lookup
const traderByAddr = {};
for (const t of traders) {
  traderByAddr[t.address] = t;
}

// ============================================================
// 1. PER-TRADER ANALYSIS
// ============================================================
const traderStats = [];

for (const [addr, trades] of Object.entries(tradeHistory)) {
  const trader = traderByAddr[addr];
  if (!trader) continue;
  if (trades.length === 0) continue;

  const pnls = trades.map(t => t.pnl);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = wins.length / trades.length;
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const avgReturn = totalPnl / trades.length;
  
  // Std dev
  const mean = avgReturn;
  const variance = pnls.reduce((sum, p) => sum + (p - mean) ** 2, 0) / pnls.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? avgReturn / stdDev : 0;

  // Max drawdown (cumulative PnL)
  let cumPnl = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const p of pnls) {
    cumPnl += p;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Consistency: what % of PnL comes from top trade?
  const sortedPnls = [...pnls].sort((a, b) => b - a);
  const topTradePnl = sortedPnls[0] || 0;
  const topTradeConcentration = totalPnl > 0 ? topTradePnl / totalPnl : 0;
  
  // Top 3 trades concentration
  const top3Pnl = sortedPnls.slice(0, 3).reduce((a, b) => a + b, 0);
  const top3Concentration = totalPnl > 0 ? top3Pnl / totalPnl : 0;

  // Closed positions PnL vs active positions value
  const closedPnl = (trader.closedPositions || []).reduce((s, p) => s + p.pnl, 0);
  const activeValue = trader.activePositionsValue || 0;

  // Timing data
  const dates = trades.map(t => parseInt(t.date)).filter(d => !isNaN(d));
  
  // Entry/exit price analysis for copy delay
  const priceReturns = trades.map(t => {
    if (t.side === 'Yes' || t.side === 'No') {
      return (t.exitPrice - t.entryPrice) / t.entryPrice;
    }
    return t.pnl; // fallback
  });

  traderStats.push({
    username: trader.username,
    address: addr,
    cluster: trader.cluster,
    insiderRisk: trader.insiderRisk,
    tradeCount: trades.length,
    winRate,
    totalPnl,
    avgReturn,
    stdDev,
    sharpe,
    maxDrawdown,
    topTradeConcentration,
    top3Concentration,
    closedPnl,
    activeValue,
    profilePnl: trader.pnl,
    categories: trader.categories,
    trades
  });
}

// Sort by sharpe
const bySharpe = [...traderStats].sort((a, b) => b.sharpe - a.sharpe);
const byTotalPnl = [...traderStats].sort((a, b) => b.totalPnl - a.totalPnl);

console.log("=== TRADER COUNT ===");
console.log(`Total traders: ${traders.length}`);
console.log(`Traders with trade history: ${traderStats.length}`);
console.log(`Traders with 0 trades in history: ${Object.entries(tradeHistory).filter(([_,t]) => t.length === 0).length}`);

console.log("\n=== TOP 10 BY RISK-ADJUSTED RETURNS (SHARPE, min 3 trades) ===");
const top10Sharpe = bySharpe.filter(t => t.tradeCount >= 3).slice(0, 10);
console.log("Username | Cluster | Risk | Trades | WinRate | TotalPnL | AvgReturn | Sharpe | MaxDD | Top1Conc");
for (const t of top10Sharpe) {
  console.log(`${t.username} | ${t.cluster} | ${t.insiderRisk} | ${t.tradeCount} | ${(t.winRate*100).toFixed(1)}% | $${t.totalPnl.toFixed(0)} | $${t.avgReturn.toFixed(0)} | ${t.sharpe.toFixed(3)} | $${t.maxDrawdown.toFixed(0)} | ${(t.topTradeConcentration*100).toFixed(0)}%`);
}

console.log("\n=== BOTTOM 10 BY RISK-ADJUSTED RETURNS (min 3 trades) ===");
const bottom10Sharpe = bySharpe.filter(t => t.tradeCount >= 3).slice(-10).reverse();
for (const t of bottom10Sharpe) {
  console.log(`${t.username} | ${t.cluster} | ${t.insiderRisk} | ${t.tradeCount} | ${(t.winRate*100).toFixed(1)}% | $${t.totalPnl.toFixed(0)} | $${t.avgReturn.toFixed(0)} | ${t.sharpe.toFixed(3)} | $${t.maxDrawdown.toFixed(0)} | ${(t.topTradeConcentration*100).toFixed(0)}%`);
}

console.log("\n=== TOP 10 BY TOTAL PNL ===");
for (const t of byTotalPnl.slice(0, 10)) {
  console.log(`${t.username} | ${t.cluster} | ${t.insiderRisk} | ${t.tradeCount} trades | $${t.totalPnl.toFixed(0)} total | Sharpe ${t.sharpe.toFixed(3)} | WR ${(t.winRate*100).toFixed(1)}% | Top1: ${(t.topTradeConcentration*100).toFixed(0)}%`);
}

console.log("\n=== BOTTOM 10 BY TOTAL PNL ===");
for (const t of byTotalPnl.slice(-10)) {
  console.log(`${t.username} | ${t.cluster} | ${t.insiderRisk} | ${t.tradeCount} trades | $${t.totalPnl.toFixed(0)} total | Sharpe ${t.sharpe.toFixed(3)} | WR ${(t.winRate*100).toFixed(1)}% | Top1: ${(t.topTradeConcentration*100).toFixed(0)}%`);
}

// Consistency check
console.log("\n=== CONSISTENCY: Traders where top trade > 80% of PnL (lucky one-hitters) ===");
const luckyOnes = traderStats.filter(t => t.totalPnl > 0 && t.topTradeConcentration > 0.8 && t.tradeCount >= 2);
for (const t of luckyOnes) {
  console.log(`${t.username} | ${t.tradeCount} trades | Top1 = ${(t.topTradeConcentration*100).toFixed(0)}% of PnL`);
}

console.log("\n=== CONSISTENT PERFORMERS: 5+ trades, WR > 60%, positive Sharpe ===");
const consistent = traderStats.filter(t => t.tradeCount >= 5 && t.winRate > 0.6 && t.sharpe > 0);
for (const t of consistent.sort((a,b) => b.sharpe - a.sharpe)) {
  console.log(`${t.username} | ${t.cluster} | ${t.tradeCount} trades | WR ${(t.winRate*100).toFixed(1)}% | Sharpe ${t.sharpe.toFixed(3)} | PnL $${t.totalPnl.toFixed(0)} | Top1: ${(t.topTradeConcentration*100).toFixed(0)}%`);
}

// Closed position vs active value analysis
console.log("\n=== CLOSED PNL vs ACTIVE POSITIONS VALUE ===");
for (const t of byTotalPnl.slice(0, 15)) {
  const closedPnlDisplay = t.closedPnl;
  console.log(`${t.username} | ClosedPnL: $${closedPnlDisplay.toFixed(0)} | ActiveValue: $${t.activeValue} | ProfilePnL: $${t.profilePnl}`);
}

// ============================================================
// 2. PER-CLUSTER ANALYSIS
// ============================================================
console.log("\n\n=== CLUSTER ANALYSIS ===");
const clusterMap = {};
for (const t of traderStats) {
  const c = t.cluster || 'unknown';
  if (!clusterMap[c]) clusterMap[c] = { traders: [], allTrades: [], totalPnl: 0 };
  clusterMap[c].traders.push(t);
  clusterMap[c].allTrades.push(...t.trades);
  clusterMap[c].totalPnl += t.totalPnl;
}

console.log("Cluster | Traders | Trades | TotalPnL | AvgPnL/Trade | WinRate | AvgSharpe");
for (const [cluster, data] of Object.entries(clusterMap).sort((a, b) => b[1].totalPnl - a[1].totalPnl)) {
  const wins = data.allTrades.filter(t => t.pnl > 0).length;
  const wr = data.allTrades.length > 0 ? wins / data.allTrades.length : 0;
  const avgPnl = data.allTrades.length > 0 ? data.totalPnl / data.allTrades.length : 0;
  const avgSharpe = data.traders.reduce((s, t) => s + t.sharpe, 0) / data.traders.length;
  console.log(`${cluster} | ${data.traders.length} | ${data.allTrades.length} | $${data.totalPnl.toFixed(0)} | $${avgPnl.toFixed(0)} | ${(wr*100).toFixed(1)}% | ${avgSharpe.toFixed(3)}`);
}

// ============================================================
// 3. PER-RISK-TIER ANALYSIS
// ============================================================
console.log("\n\n=== RISK TIER ANALYSIS ===");
const riskMap = {};
for (const t of traderStats) {
  const r = t.insiderRisk || 'UNKNOWN';
  if (!riskMap[r]) riskMap[r] = { traders: [], allTrades: [], totalPnl: 0 };
  riskMap[r].traders.push(t);
  riskMap[r].allTrades.push(...t.trades);
  riskMap[r].totalPnl += t.totalPnl;
}

console.log("Risk | Traders | Trades | TotalPnL | AvgPnL/Trader | WinRate | AvgSharpe | MedianSharpe");
for (const [risk, data] of [['EXTREME', riskMap['EXTREME']], ['HIGH', riskMap['HIGH']], ['MEDIUM', riskMap['MEDIUM']], ['LOW', riskMap['LOW']]]) {
  if (!data) continue;
  const wins = data.allTrades.filter(t => t.pnl > 0).length;
  const wr = data.allTrades.length > 0 ? wins / data.allTrades.length : 0;
  const avgPnlTrader = data.totalPnl / data.traders.length;
  const avgSharpe = data.traders.reduce((s, t) => s + t.sharpe, 0) / data.traders.length;
  const sharpes = data.traders.map(t => t.sharpe).sort((a, b) => a - b);
  const medianSharpe = sharpes[Math.floor(sharpes.length / 2)];
  console.log(`${risk} | ${data.traders.length} | ${data.allTrades.length} | $${data.totalPnl.toFixed(0)} | $${avgPnlTrader.toFixed(0)} | ${(wr*100).toFixed(1)}% | ${avgSharpe.toFixed(3)} | ${medianSharpe.toFixed(3)}`);
}

// ============================================================
// 4. POSITION SIZING / KELLY CRITERION
// ============================================================
console.log("\n\n=== POSITION SIZING ANALYSIS ===");

// Simulate equal weight, pnl-weighted, wr-weighted, risk-tier weighted
const allTrades = [];
for (const t of traderStats) {
  for (const trade of t.trades) {
    allTrades.push({
      ...trade,
      traderUsername: t.username,
      cluster: t.cluster,
      insiderRisk: t.insiderRisk,
      traderWinRate: t.winRate,
      traderSharpe: t.sharpe,
      traderTotalPnl: t.totalPnl
    });
  }
}

// Sort all trades by date
allTrades.sort((a, b) => parseInt(a.date) - parseInt(b.date));

console.log(`Total trades across all traders: ${allTrades.length}`);

// Equal weight simulation - normalize pnl as return %
// Use entry/exit price to compute return
function computeReturn(trade) {
  if (trade.entryPrice > 0) {
    return (trade.exitPrice - trade.entryPrice) / trade.entryPrice;
  }
  return 0;
}

// Kelly criterion for each trader
console.log("\n=== KELLY CRITERION PER TRADER (min 5 trades) ===");
for (const t of traderStats.filter(ts => ts.tradeCount >= 5).sort((a,b) => b.sharpe - a.sharpe).slice(0, 15)) {
  const returns = t.trades.map(computeReturn);
  const winReturns = returns.filter(r => r > 0);
  const lossReturns = returns.filter(r => r <= 0);
  
  const p = winReturns.length / returns.length; // win prob
  const avgWin = winReturns.length > 0 ? winReturns.reduce((a,b) => a+b, 0) / winReturns.length : 0;
  const avgLoss = lossReturns.length > 0 ? Math.abs(lossReturns.reduce((a,b) => a+b, 0) / lossReturns.length) : 0.01;
  
  // Kelly: f = p/b_loss - q/b_win where b is odds
  // Simple Kelly: f = p - q/(avgWin/avgLoss)
  const q = 1 - p;
  const wlRatio = avgLoss > 0 ? avgWin / avgLoss : 10;
  const kelly = p - (q / wlRatio);
  const halfKelly = kelly / 2;
  
  console.log(`${t.username} | WR: ${(p*100).toFixed(0)}% | AvgWin: ${(avgWin*100).toFixed(1)}% | AvgLoss: ${(avgLoss*100).toFixed(1)}% | W/L: ${wlRatio.toFixed(2)} | Kelly: ${(kelly*100).toFixed(1)}% | HalfKelly: ${(halfKelly*100).toFixed(1)}%`);
}

// ============================================================
// 5. TIMING ANALYSIS
// ============================================================
console.log("\n\n=== TIMING ANALYSIS ===");

// Day of week analysis
const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayStats = Array(7).fill(null).map(() => ({ count: 0, wins: 0, totalPnl: 0 }));

for (const trade of allTrades) {
  const d = new Date(parseInt(trade.date) * 1000);
  if (isNaN(d.getTime())) continue;
  const day = d.getUTCDay();
  dayStats[day].count++;
  if (trade.pnl > 0) dayStats[day].wins++;
  dayStats[day].totalPnl += trade.pnl;
}

console.log("Day | Trades | Wins | WinRate | TotalPnL | AvgPnL");
for (let i = 0; i < 7; i++) {
  const s = dayStats[i];
  if (s.count === 0) continue;
  console.log(`${dayNames[i]} | ${s.count} | ${s.wins} | ${(s.wins/s.count*100).toFixed(1)}% | $${s.totalPnl.toFixed(0)} | $${(s.totalPnl/s.count).toFixed(0)}`);
}

// Copy delay analysis - for trades with entry/exit prices
console.log("\n=== COPY DELAY ANALYSIS ===");
// If you enter at a higher price (worse entry), how much alpha do you lose?
// Simulate: entry at entryPrice + X% of (exitPrice-entryPrice) spread
const delays = [0, 0.05, 0.1, 0.2, 0.3, 0.5]; // 0%, 5%, 10%, 20%, 30%, 50% of move already happened
const profitableTrades = allTrades.filter(t => t.pnl > 0 && t.entryPrice > 0 && t.exitPrice > 0);

console.log("Delay% | AvgReturn% | ReturnRetained%");
for (const delay of delays) {
  let totalReturn = 0;
  let count = 0;
  for (const t of profitableTrades) {
    const spread = t.exitPrice - t.entryPrice;
    const delayedEntry = t.entryPrice + (spread * delay);
    if (delayedEntry >= t.exitPrice) continue; // missed trade
    const ret = (t.exitPrice - delayedEntry) / delayedEntry;
    totalReturn += ret;
    count++;
  }
  const avgRet = count > 0 ? totalReturn / count : 0;
  const baseReturn = delays[0] === delay ? avgRet : null;
  console.log(`${(delay*100).toFixed(0)}% | ${(avgRet*100).toFixed(1)}% | ${count} trades`);
}

// Compute base return for retained calculation
{
  let baseTotal = 0;
  for (const t of profitableTrades) {
    const ret = (t.exitPrice - t.entryPrice) / t.entryPrice;
    baseTotal += ret;
  }
  const baseAvg = baseTotal / profitableTrades.length;
  
  console.log("\nCopy delay alpha retention:");
  for (const delay of delays) {
    let totalReturn = 0;
    let count = 0;
    for (const t of profitableTrades) {
      const spread = t.exitPrice - t.entryPrice;
      const delayedEntry = t.entryPrice + (spread * delay);
      if (delayedEntry >= t.exitPrice) { count++; continue; }
      const ret = (t.exitPrice - delayedEntry) / delayedEntry;
      totalReturn += ret;
      count++;
    }
    const avgRet = totalReturn / profitableTrades.length;
    const retained = (avgRet / baseAvg * 100).toFixed(1);
    console.log(`${(delay*100).toFixed(0)}% move captured → ${retained}% alpha retained | avg return: ${(avgRet*100).toFixed(2)}%`);
  }
}

// ============================================================
// 6. CONCENTRATION ANALYSIS
// ============================================================
console.log("\n\n=== CONCENTRATION ANALYSIS ===");

// 80/20 rule
const sortedByPnl = [...traderStats].filter(t => t.totalPnl > 0).sort((a, b) => b.totalPnl - a.totalPnl);
const totalPositivePnl = sortedByPnl.reduce((s, t) => s + t.totalPnl, 0);

let cumPnl = 0;
let countFor80 = 0;
for (const t of sortedByPnl) {
  cumPnl += t.totalPnl;
  countFor80++;
  if (cumPnl >= totalPositivePnl * 0.8) break;
}
console.log(`${countFor80} of ${sortedByPnl.length} profitable traders (${(countFor80/sortedByPnl.length*100).toFixed(0)}%) generate 80% of total positive PnL ($${(totalPositivePnl*0.8).toFixed(0)} of $${totalPositivePnl.toFixed(0)})`);

// Top N traders share
for (const n of [1, 3, 5, 10]) {
  const topN = sortedByPnl.slice(0, n);
  const topNPnl = topN.reduce((s, t) => s + t.totalPnl, 0);
  console.log(`Top ${n} traders: $${topNPnl.toFixed(0)} (${(topNPnl/totalPositivePnl*100).toFixed(1)}% of total positive PnL)`);
}

// Correlation: do traders bet on the same markets?
console.log("\n=== MARKET OVERLAP ===");
const traderMarkets = {};
for (const [addr, trades] of Object.entries(tradeHistory)) {
  if (trades.length === 0) continue;
  const trader = traderByAddr[addr];
  if (!trader) continue;
  traderMarkets[trader.username] = new Set(trades.map(t => t.slug));
}

const usernames = Object.keys(traderMarkets);
const overlapMatrix = [];
for (let i = 0; i < usernames.length; i++) {
  for (let j = i + 1; j < usernames.length; j++) {
    const a = traderMarkets[usernames[i]];
    const b = traderMarkets[usernames[j]];
    const intersection = [...a].filter(x => b.has(x));
    const union = new Set([...a, ...b]);
    const jaccard = intersection.length / union.size;
    if (intersection.length > 0) {
      overlapMatrix.push({
        t1: usernames[i],
        t2: usernames[j],
        overlap: intersection.length,
        jaccard,
        markets: intersection
      });
    }
  }
}

overlapMatrix.sort((a, b) => b.jaccard - a.jaccard);
console.log("\nTop market overlaps (Jaccard similarity):");
for (const o of overlapMatrix.slice(0, 15)) {
  console.log(`${o.t1} ↔ ${o.t2}: ${o.overlap} shared markets, Jaccard=${o.jaccard.toFixed(3)}`);
}

// Unique markets per trader
console.log("\n=== DIVERSIFICATION: Markets per trader ===");
for (const t of traderStats.sort((a,b) => b.totalPnl - a.totalPnl).slice(0, 15)) {
  const uniqueMarkets = new Set(t.trades.map(tr => tr.slug)).size;
  console.log(`${t.username}: ${uniqueMarkets} unique markets across ${t.tradeCount} trades`);
}

// ============================================================
// 7. WEIGHTING STRATEGY BACKTEST
// ============================================================
console.log("\n\n=== WEIGHTING STRATEGY COMPARISON ===");

// For each strategy, compute portfolio return if you followed all trades
// with different weightings

const strategies = {
  'Equal Weight': (t) => 1,
  'PnL-Weighted': (t) => Math.max(0, t.traderTotalPnl) + 1,
  'WinRate-Weighted': (t) => t.traderWinRate,
  'Sharpe-Weighted': (t) => Math.max(0, t.traderSharpe),
  'Risk-Tier (EXTREME=4, HIGH=3, MED=2, LOW=1)': (t) => {
    const map = { 'EXTREME': 4, 'HIGH': 3, 'MEDIUM': 2, 'LOW': 1 };
    return map[t.insiderRisk] || 1;
  }
};

for (const [name, weightFn] of Object.entries(strategies)) {
  let totalWeightedReturn = 0;
  let totalWeight = 0;
  let wins = 0;
  let total = 0;
  
  for (const trade of allTrades) {
    const w = weightFn(trade);
    const ret = computeReturn(trade);
    totalWeightedReturn += ret * w;
    totalWeight += w;
    if (trade.pnl > 0) wins++;
    total++;
  }
  
  const weightedAvg = totalWeight > 0 ? totalWeightedReturn / totalWeight : 0;
  console.log(`${name}: Weighted Avg Return = ${(weightedAvg*100).toFixed(2)}% | Trades: ${total} | WR: ${(wins/total*100).toFixed(1)}%`);
}

// ============================================================
// COMPREHENSIVE OUTPUT
// ============================================================

// Prepare all data for the markdown report
const output = { traderStats, clusterMap: {}, riskMap: {}, allTrades: allTrades.length };

// Serialize key stats
writeFileSync('/Users/jadesullie/.openclaw/workspace/polymarket-tracker/analysis-output.json', JSON.stringify({
  traderCount: traders.length,
  tradersWithHistory: traderStats.length,
  totalTrades: allTrades.length,
  topBySharpe: top10Sharpe.map(t => ({
    username: t.username, cluster: t.cluster, risk: t.insiderRisk,
    trades: t.tradeCount, winRate: t.winRate, totalPnl: t.totalPnl,
    avgReturn: t.avgReturn, sharpe: t.sharpe, maxDrawdown: t.maxDrawdown,
    topTradeConc: t.topTradeConcentration
  })),
  bottomBySharpe: bottom10Sharpe.map(t => ({
    username: t.username, cluster: t.cluster, risk: t.insiderRisk,
    trades: t.tradeCount, winRate: t.winRate, totalPnl: t.totalPnl,
    avgReturn: t.avgReturn, sharpe: t.sharpe, maxDrawdown: t.maxDrawdown
  })),
  topByPnl: byTotalPnl.slice(0, 10).map(t => ({
    username: t.username, cluster: t.cluster, risk: t.insiderRisk,
    trades: t.tradeCount, totalPnl: t.totalPnl, sharpe: t.sharpe,
    winRate: t.winRate, topTradeConc: t.topTradeConcentration
  })),
  allTraderStats: traderStats.map(t => ({
    username: t.username, cluster: t.cluster, risk: t.insiderRisk,
    trades: t.tradeCount, winRate: t.winRate, totalPnl: t.totalPnl,
    sharpe: t.sharpe, closedPnl: t.closedPnl, activeValue: t.activeValue,
    profilePnl: t.profilePnl, topTradeConc: t.topTradeConcentration,
    top3Conc: t.top3Concentration, maxDrawdown: t.maxDrawdown
  }))
}, null, 2));

console.log("\n\nAnalysis complete. Output saved.");
