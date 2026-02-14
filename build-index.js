#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// ── Load data ──
const tradeHistory = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/trade-history-v3.json'), 'utf8'));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const start = html.indexOf('const TRADERS = [');
let depth = 0, i = html.indexOf('[', start);
for (; i < html.length; i++) {
  if (html[i]==='[') depth++;
  if (html[i]===']') { depth--; if(depth===0) break; }
}
const TRADERS = eval(html.slice(start+16, i+1));

// ── Build trader lookup by address ──
const traderByAddr = {};
TRADERS.forEach(t => { traderByAddr[t.address.toLowerCase()] = t; });

// ── Crypto noise filter (15-min up/down + all crypto price direction bets) ──
const noiseRe = /Up or Down/i;
const cryptoPriceRe = /\b(Bitcoin|BTC|Ethereum|ETH|Solana|SOL|XRP|Dogecoin|DOGE)\b.*(above|below|dip|reach|less than|between|price of|hit \$|FDV)/i;

// ── Collect all positions with trader metadata ──
const allPositions = [];
for (const [addr, positions] of Object.entries(tradeHistory)) {
  const trader = traderByAddr[addr.toLowerCase()];
  for (const p of positions) {
    if (noiseRe.test(p.market) || cryptoPriceRe.test(p.market)) continue;
    allPositions.push({
      ...p,
      address: addr.toLowerCase(),
      // Use date (exit) for curve plotting (when P&L is realized)
      exitTs: Number(p.date || p.exitDate),
      exitDateObj: new Date(Number(p.date || p.exitDate) * 1000),
      exitDateStr: new Date(Number(p.date || p.exitDate) * 1000).toISOString().substring(0, 10),
      // Use entryDate for filtering (when trader ENTERED the position)
      entryTs: Number(p.entryDate),
      entryDateObj: new Date(Number(p.entryDate) * 1000),
      trader,
      insiderRisk: trader ? trader.insiderRisk : 'LOW',
      cluster: trader ? trader.cluster : 'other',
    });
  }
}

// Sort by exit date (for curve building)
allPositions.sort((a, b) => a.exitTs - b.exitTs);
console.log(`Total positions after filtering: ${allPositions.length}`);

// ── Compute per-trader Sharpe ratios ──
function computeSharpe(returns) {
  if (returns.length < 2) return returns.length === 1 && returns[0] > 0 ? 1 : 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  return std > 0 ? mean / std : (mean > 0 ? 1 : 0);
}

// Load v2 weights for recency-biased strategy
let traderWeightsV2 = {};
try {
  traderWeightsV2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/trader-weights-v2.json'), 'utf8'));
} catch(e) { console.log('No trader-weights-v2.json, using defaults'); }

// ── Cluster boost mapping ──
const ACTIVE_CLUSTERS = new Set(['iran', 'fed', 'geopolitics', 'politics', 'crypto', 'tech', 'sports', 'ufc', 'mma']);
const PLAYED_OUT_CLUSTERS = new Set(['election-2024', 'election']);

function clusterBoost(cluster) {
  if (!cluster) return 1;
  const c = cluster.toLowerCase();
  if (PLAYED_OUT_CLUSTERS.has(c)) return 0.3;
  if (ACTIVE_CLUSTERS.has(c)) return 1.5;
  return 1;
}

function insiderMult(risk) {
  if (risk === 'HIGH') return 2;
  if (risk === 'MEDIUM') return 1;
  return 0.5;
}

// ── Timeframe definitions ──
const NOW = new Date('2026-02-14T00:00:00Z');
const timeframes = {
  '1W': new Date(NOW - 7 * 86400000),
  '1M': new Date(NOW - 30 * 86400000),
  '3M': new Date(NOW - 90 * 86400000),
  '6M': new Date(NOW - 180 * 86400000),
  '1Y': new Date(NOW - 365 * 86400000),
  'YTD': new Date('2026-01-01T00:00:00Z'),
  'ALL': new Date('2020-01-01T00:00:00Z'),
};

// ── Build index for each timeframe ──
const STARTING_CAPITAL = 10000;
const BASE_POSITION = 1000;

const result = {};

for (const [tf, startDate] of Object.entries(timeframes)) {
  // KEY CHANGE: Filter by ENTRY date, not exit date
  // Only include positions where the trader ENTERED after the timeframe start
  const startTs = startDate.getTime() / 1000;
  const tfPositions = allPositions.filter(p => p.entryTs >= startTs);
  
  if (tfPositions.length === 0) {
    result[tf] = { curve: [{ date: startDate.toISOString().substring(0,10), equal: 100, sharpe: 100, optimal: 100, recencyOpt: 100 }], stats: { totalReturn: {equal:0,sharpe:0,optimal:0,recencyOpt:0}, trades: 0, winRate: 0 } };
    continue;
  }

  // Group by exit date (for curve building)
  const byDate = {};
  for (const p of tfPositions) {
    if (!byDate[p.exitDateStr]) byDate[p.exitDateStr] = [];
    byDate[p.exitDateStr].push(p);
  }
  
  const dates = Object.keys(byDate).sort();
  
  // Compute per-timeframe Sharpe for each trader
  const tfTraderReturns = {};
  for (const p of tfPositions) {
    if (!tfTraderReturns[p.address]) tfTraderReturns[p.address] = [];
    if (p.entryPrice > 0) {
      tfTraderReturns[p.address].push((p.exitPrice - p.entryPrice) / p.entryPrice);
    }
  }
  const tfSharpe = {};
  for (const [addr, rets] of Object.entries(tfTraderReturns)) {
    tfSharpe[addr] = Math.max(0.1, computeSharpe(rets));
  }

  // Track cumulative P&L for each strategy
  let eqCapital = STARTING_CAPITAL;
  let shCapital = STARTING_CAPITAL;
  let optCapital = STARTING_CAPITAL;
  let recCapital = STARTING_CAPITAL;
  let wins = 0, total = 0;
  
  const curve = [];
  curve.push({ date: startDate.toISOString().substring(0,10), equal: 100, sharpe: 100, optimal: 100, recencyOpt: 100 });
  
  for (const date of dates) {
    const positions = byDate[date];
    
    for (const p of positions) {
      if (p.entryPrice <= 0) continue;
      total++;
      const ret = (p.exitPrice - p.entryPrice) / p.entryPrice;
      if (p.outcome === 'Profit') wins++;
      
      // Equal weight: $1K per position
      eqCapital += BASE_POSITION * ret;
      
      // Sharpe-weighted (per-timeframe Sharpe)
      const sharpe = tfSharpe[p.address] || 1;
      const sharpeWeight = Math.min(sharpe, 3);
      shCapital += BASE_POSITION * sharpeWeight * ret;
      
      // Optimal: per-tf sharpe × insiderRisk × cluster, capped at 10%
      let optWeight = sharpeWeight * insiderMult(p.insiderRisk) * clusterBoost(p.cluster);
      const optPositionSize = Math.min(BASE_POSITION * optWeight, optCapital * 0.1);
      optCapital += optPositionSize * ret;
      
      // Recency-optimal: uses v2 blended weights
      const v2w = traderWeightsV2[p.address];
      const recWeight = v2w ? v2w.recommendedWeight : 1;
      const recPositionSize = Math.min(BASE_POSITION * recWeight, recCapital * 0.1);
      recCapital += recPositionSize * ret;
    }
    
    curve.push({
      date,
      equal: Math.round((eqCapital / STARTING_CAPITAL) * 1000) / 10,
      sharpe: Math.round((shCapital / STARTING_CAPITAL) * 1000) / 10,
      optimal: Math.round((optCapital / STARTING_CAPITAL) * 1000) / 10,
      recencyOpt: Math.round((recCapital / STARTING_CAPITAL) * 1000) / 10,
      n: positions.length,
    });
  }
  
  result[tf] = {
    curve,
    stats: {
      totalReturn: {
        equal: Math.round((eqCapital / STARTING_CAPITAL - 1) * 1000) / 10,
        sharpe: Math.round((shCapital / STARTING_CAPITAL - 1) * 1000) / 10,
        optimal: Math.round((optCapital / STARTING_CAPITAL - 1) * 1000) / 10,
        recencyOpt: Math.round((recCapital / STARTING_CAPITAL - 1) * 1000) / 10,
      },
      trades: total,
      winRate: total > 0 ? Math.round((wins / total) * 1000) / 10 : 0,
    },
  };
  
  console.log(`${tf}: ${tfPositions.length} positions (entry-filtered), ${dates.length} days, EQ=${result[tf].stats.totalReturn.equal}%, SH=${result[tf].stats.totalReturn.sharpe}%, OPT=${result[tf].stats.totalReturn.optimal}%, REC=${result[tf].stats.totalReturn.recencyOpt}%`);
}

fs.writeFileSync(path.join(__dirname, 'data/index-by-timeframe.json'), JSON.stringify(result, null, 2));
console.log('\nWritten to data/index-by-timeframe.json');

// ── Comparison with old values ──
console.log('\n=== COMPARISON (old exit-filtered → new entry-filtered) ===');
const oldReturns = { '1W': 1077.8, '1M': 1391.7, '3M': 1954.2, '6M': 2435.7, '1Y': 3950.3, 'YTD': 1551.6, 'ALL': 5643.2 };
for (const tf of Object.keys(timeframes)) {
  const newR = result[tf].stats.totalReturn.equal;
  const oldR = oldReturns[tf] || '?';
  console.log(`${tf}: EQ ${oldR}% → ${newR}% (${newR < oldR ? '↓' : '↑'})`);
}
