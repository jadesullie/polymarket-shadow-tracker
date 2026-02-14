#!/usr/bin/env node
/**
 * Daily Shadow Index Tracker
 * Pulls new trades since baseline, calculates returns for 3 strategies,
 * outputs a Discord-ready summary.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const BASELINE_PATH = path.join(DATA_DIR, 'live-tracking-baseline.json');
const STATE_PATH = path.join(DATA_DIR, 'live-tracking-state.json');
const TRADERS_PATH = path.join(DATA_DIR, 'all-traders.json');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve([]); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // Load baseline and current state
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const traders = JSON.parse(fs.readFileSync(TRADERS_PATH, 'utf8'));
  
  // Load or init running state
  let state;
  if (fs.existsSync(STATE_PATH)) {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } else {
    state = {
      startDate: baseline.startDate,
      equalWeight: { capital: 10000, trades: 0, wins: 0, maxCap: 10000 },
      sharpeWeighted: { capital: 10000, trades: 0, wins: 0, maxCap: 10000 },
      optimal: { capital: 10000, trades: 0, wins: 0, maxCap: 10000 },
      processedTrades: [], // trade hashes to avoid double counting
      traderSharpes: {},
      dailyLog: []
    };
  }

  // Build trader lookup
  const traderMap = {};
  for (const t of traders) {
    if (t.address) traderMap[t.address.toLowerCase()] = t;
  }

  // Calculate per-trader Sharpe from historical data (only once)
  if (Object.keys(state.traderSharpes).length === 0) {
    const histData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'trade-history-full.json'), 'utf8'));
    for (const [addr, positions] of Object.entries(histData)) {
      if (!Array.isArray(positions) || positions.length < 2) continue;
      const returns = positions
        .filter(p => p.entryPrice > 0 && p.exitPrice > 0)
        .map(p => (p.exitPrice - p.entryPrice) / p.entryPrice);
      if (returns.length < 2) continue;
      const avg = returns.reduce((s, r) => s + r, 0) / returns.length;
      const std = Math.sqrt(returns.reduce((s, r) => s + (r - avg) ** 2, 0) / returns.length);
      state.traderSharpes[addr.toLowerCase()] = std > 0 ? avg / std : 0;
    }
  }

  // Fetch recent trades for all tracked wallets
  const newTrades = [];
  const addresses = traders.filter(t => t.address).map(t => t.address.toLowerCase());
  
  console.log(`Checking ${addresses.length} wallets for new trades...`);
  
  // Process in batches of 10
  for (let i = 0; i < addresses.length; i += 10) {
    const batch = addresses.slice(i, i + 10);
    const promises = batch.map(async (addr) => {
      try {
        const activities = await fetch(`https://data-api.polymarket.com/activity?user=${addr}&limit=50`);
        if (!Array.isArray(activities)) return;
        
        const trader = traderMap[addr];
        const knownSlugs = baseline.traders[addr]?.closedSlugs || [];
        
        for (const a of activities) {
          // Only count REDEMPTION (won) and SELL trades that close positions
          if (a.type !== 'REDEMPTION' && !(a.type === 'TRADE' && a.side === 'SELL')) continue;
          
          // Only trades after our start date
          const tradeDate = new Date(a.timestamp * 1000).toISOString().substring(0, 10);
          if (tradeDate < baseline.startDate) continue;
          
          // Dedup
          const hash = `${addr}-${a.transactionHash}-${a.conditionId}`;
          if (state.processedTrades.includes(hash)) continue;
          
          // For REDEMPTION: they won. For SELL: need to estimate return
          let ret = 0;
          if (a.type === 'REDEMPTION') {
            // Won at $1. Entry was at a.price (if available) or estimate
            ret = a.price > 0 ? (1 - a.price) / a.price : 0.5;
          } else if (a.type === 'TRADE' && a.side === 'SELL') {
            // Sold at a.price. Need to know entry, estimate from market
            ret = a.price > 0.5 ? (a.price - 0.5) / 0.5 : -0.3; // rough estimate
          }
          
          newTrades.push({
            hash,
            addr,
            username: trader?.username || addr.substring(0, 10),
            cluster: trader?.cluster || 'mixed',
            risk: trader?.insiderRisk || 'LOW',
            market: a.title || 'Unknown',
            side: a.outcome || a.side,
            type: a.type,
            price: a.price,
            size: a.usdcSize,
            ret: Math.max(-1, Math.min(5, ret)),
            date: tradeDate,
            sharpe: state.traderSharpes[addr] || 0
          });
        }
      } catch (e) {
        // Skip failed fetches
      }
    });
    await Promise.all(promises);
    if (i + 10 < addresses.length) await sleep(200);
  }

  console.log(`Found ${newTrades.length} new trades since ${baseline.startDate}`);

  // Apply trades to all 3 strategies
  const BASE_SIZE = 1000;
  let todayPnl = { eq: 0, sh: 0, opt: 0 };
  
  for (const trade of newTrades) {
    state.processedTrades.push(trade.hash);
    
    // Equal weight
    const eqSize = Math.min(BASE_SIZE, state.equalWeight.capital * 0.25);
    const eqPnl = eqSize * trade.ret;
    state.equalWeight.capital += eqPnl;
    state.equalWeight.trades++;
    if (trade.ret > 0) state.equalWeight.wins++;
    if (state.equalWeight.capital > state.equalWeight.maxCap) state.equalWeight.maxCap = state.equalWeight.capital;
    todayPnl.eq += eqPnl;
    
    // Sharpe-weighted
    const shWeight = Math.max(0.1, trade.sharpe);
    const shSize = Math.min(BASE_SIZE * shWeight, state.sharpeWeighted.capital * 0.25);
    const shPnl = shSize * trade.ret;
    state.sharpeWeighted.capital += shPnl;
    state.sharpeWeighted.trades++;
    if (trade.ret > 0) state.sharpeWeighted.wins++;
    if (state.sharpeWeighted.capital > state.sharpeWeighted.maxCap) state.sharpeWeighted.maxCap = state.sharpeWeighted.capital;
    todayPnl.sh += shPnl;
    
    // Optimal
    let optWeight = Math.max(0.1, trade.sharpe);
    if (trade.risk === 'HIGH' || trade.risk === 'EXTREME') optWeight *= 1.5;
    if (['iran', 'fed', 'political-economy', 'crypto'].includes(trade.cluster)) optWeight *= 1.3;
    if (trade.cluster === 'election2024') optWeight *= 0.3;
    const optSize = Math.min(BASE_SIZE * optWeight, state.optimal.capital * 0.25);
    const optPnl = optSize * trade.ret;
    state.optimal.capital += optPnl;
    state.optimal.trades++;
    if (trade.ret > 0) state.optimal.wins++;
    if (state.optimal.capital > state.optimal.maxCap) state.optimal.maxCap = state.optimal.capital;
    todayPnl.opt += optPnl;
  }

  // Calculate drawdowns
  const eqDD = ((state.equalWeight.maxCap - state.equalWeight.capital) / state.equalWeight.maxCap * 100);
  const shDD = ((state.sharpeWeighted.maxCap - state.sharpeWeighted.capital) / state.sharpeWeighted.maxCap * 100);
  const optDD = ((state.optimal.maxCap - state.optimal.capital) / state.optimal.maxCap * 100);

  // Days since start
  const daysSinceStart = Math.floor((Date.now() - new Date(baseline.startDate).getTime()) / 86400000);

  // Build Discord message
  const fmtPct = (v) => { const p = ((v / 10000 - 1) * 100).toFixed(1); return (p >= 0 ? '+' : '') + p + '%'; };
  const fmtUsd = (v) => { const d = v - 10000; return (d >= 0 ? '+' : '') + '$' + Math.abs(d).toFixed(0); };
  const fmtWR = (w, t) => t > 0 ? ((w / t) * 100).toFixed(0) + '%' : 'N/A';

  let msg = `## 📊 Shadow Index — Day ${daysSinceStart} (since ${baseline.startDate})\n\n`;
  
  if (newTrades.length > 0) {
    msg += `**${newTrades.length} new trade(s) today**\n`;
    for (const t of newTrades.slice(0, 5)) {
      const emoji = t.ret > 0 ? '🟢' : '🔴';
      msg += `${emoji} **${t.username}** ${t.type === 'REDEMPTION' ? 'won' : 'sold'}: ${t.market.substring(0, 50)}${t.market.length > 50 ? '...' : ''}\n`;
    }
    if (newTrades.length > 5) msg += `...and ${newTrades.length - 5} more\n`;
    msg += '\n';
  } else {
    msg += `No new closed trades today.\n\n`;
  }

  msg += `**Strategy Performance ($10K start)**\n`;
  msg += `- **Equal Weight:** ${fmtPct(state.equalWeight.capital)} (${fmtUsd(state.equalWeight.capital)}) | ${state.equalWeight.trades} trades | ${fmtWR(state.equalWeight.wins, state.equalWeight.trades)} WR | DD: ${eqDD.toFixed(1)}%\n`;
  msg += `- **Sharpe-Weighted:** ${fmtPct(state.sharpeWeighted.capital)} (${fmtUsd(state.sharpeWeighted.capital)}) | ${state.sharpeWeighted.trades} trades | ${fmtWR(state.sharpeWeighted.wins, state.sharpeWeighted.trades)} WR | DD: ${shDD.toFixed(1)}%\n`;
  msg += `- **Optimal:** ${fmtPct(state.optimal.capital)} (${fmtUsd(state.optimal.capital)}) | ${state.optimal.trades} trades | ${fmtWR(state.optimal.wins, state.optimal.trades)} WR | DD: ${optDD.toFixed(1)}%\n`;

  // Log daily entry
  state.dailyLog.push({
    date: new Date().toISOString().substring(0, 10),
    newTrades: newTrades.length,
    eq: state.equalWeight.capital,
    sh: state.sharpeWeighted.capital,
    opt: state.optimal.capital
  });

  // Save state
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  
  // Output message for cron to pick up
  console.log(msg);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
