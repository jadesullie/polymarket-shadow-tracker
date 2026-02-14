#!/usr/bin/env node
/**
 * Minute Poller — checks tracked wallets for NEW trades since last poll.
 * Outputs alerts for new trades found. Designed to run via cron every minute.
 * Only checks top-tier traders to keep API calls manageable.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const POLL_STATE_PATH = path.join(DATA_DIR, 'poll-state.json');
const TRADERS_PATH = path.join(DATA_DIR, 'all-traders.json');
const BASELINE_PATH = path.join(DATA_DIR, 'live-tracking-baseline.json');
const STATE_PATH = path.join(DATA_DIR, 'live-tracking-state.json');
const HIST_PATH = path.join(DATA_DIR, 'trade-history-full.json');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout')), 8000);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        clearTimeout(timeout);
        try { resolve(JSON.parse(data)); } catch { resolve([]); }
      });
    }).on('error', e => { clearTimeout(timeout); reject(e); });
  });
}

async function main() {
  const traders = JSON.parse(fs.readFileSync(TRADERS_PATH, 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  
  // Load poll state (tracks last seen transaction per wallet)
  let pollState;
  if (fs.existsSync(POLL_STATE_PATH)) {
    pollState = JSON.parse(fs.readFileSync(POLL_STATE_PATH, 'utf8'));
  } else {
    pollState = { lastPollTs: Date.now(), lastSeenTx: {}, pollCount: 0 };
  }

  // Load trading state
  let state;
  if (fs.existsSync(STATE_PATH)) {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } else {
    // Load historical sharpes
    const histData = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8'));
    const traderSharpes = {};
    for (const [addr, positions] of Object.entries(histData)) {
      if (!Array.isArray(positions) || positions.length < 2) continue;
      const returns = positions
        .filter(p => p.entryPrice > 0 && p.exitPrice > 0)
        .map(p => (p.exitPrice - p.entryPrice) / p.entryPrice);
      if (returns.length < 2) continue;
      const avg = returns.reduce((s, r) => s + r, 0) / returns.length;
      const std = Math.sqrt(returns.reduce((s, r) => s + (r - avg) ** 2, 0) / returns.length);
      traderSharpes[addr.toLowerCase()] = std > 0 ? avg / std : 0;
    }
    state = {
      startDate: baseline.startDate,
      equalWeight: { capital: 10000, trades: 0, wins: 0, maxCap: 10000 },
      sharpeWeighted: { capital: 10000, trades: 0, wins: 0, maxCap: 10000 },
      optimal: { capital: 10000, trades: 0, wins: 0, maxCap: 10000 },
      processedTrades: [],
      traderSharpes,
      dailyLog: [],
      tradeLog: []
    };
  }

  // Check ALL wallets every run
  const walletsWithAddr = traders.filter(t => t.address);
  const batch = walletsWithAddr;
  
  pollState.pollCount++;

  const newTrades = [];
  const BASE_SIZE = 1000;

  await Promise.all(batch.map(async (trader) => {
    const addr = trader.address.toLowerCase();
    try {
      const activities = await fetch(`https://data-api.polymarket.com/activity?user=${addr}&limit=10`);
      if (!Array.isArray(activities)) return;

      for (const a of activities) {
        // Only BUY trades (these are the entry signals we'd copy)
        // and REDEMPTION/SELL for P&L tracking
        const hash = `${addr}-${a.transactionHash}`;
        
        if (state.processedTrades.includes(hash)) continue;
        if (!a.timestamp) continue;
        
        const tradeDate = new Date(a.timestamp * 1000).toISOString().substring(0, 10);
        if (tradeDate < baseline.startDate) continue;

        // New trade found!
        state.processedTrades.push(hash);

        // For BUY trades: this is an entry signal (alert worthy)
        if (a.type === 'TRADE' && a.side === 'BUY') {
          newTrades.push({
            type: 'ENTRY',
            username: trader.username || addr.substring(0, 10),
            market: a.title || 'Unknown',
            outcome: a.outcome || '?',
            price: a.price,
            size: a.usdcSize,
            risk: trader.insiderRisk || 'LOW',
            cluster: trader.cluster || 'mixed',
            date: tradeDate,
            time: new Date(a.timestamp * 1000).toISOString().substring(11, 16)
          });
        }

        // For REDEMPTION or SELL: position closed, update P&L
        if (a.type === 'REDEMPTION' || (a.type === 'TRADE' && a.side === 'SELL')) {
          let ret = 0;
          if (a.type === 'REDEMPTION') {
            ret = a.price > 0 ? (1 - a.price) / a.price : 0.5;
          } else {
            ret = a.price > 0.5 ? (a.price - 0.5) / 0.5 : -0.3;
          }
          ret = Math.max(-1, Math.min(5, ret));
          const sharpe = state.traderSharpes[addr] || 0;

          // Equal weight
          const eqPnl = Math.min(BASE_SIZE, state.equalWeight.capital * 0.25) * ret;
          state.equalWeight.capital += eqPnl;
          state.equalWeight.trades++;
          if (ret > 0) state.equalWeight.wins++;
          if (state.equalWeight.capital > state.equalWeight.maxCap) state.equalWeight.maxCap = state.equalWeight.capital;

          // Sharpe-weighted
          const shSize = Math.min(BASE_SIZE * Math.max(0.1, sharpe), state.sharpeWeighted.capital * 0.25);
          state.sharpeWeighted.capital += shSize * ret;
          state.sharpeWeighted.trades++;
          if (ret > 0) state.sharpeWeighted.wins++;
          if (state.sharpeWeighted.capital > state.sharpeWeighted.maxCap) state.sharpeWeighted.maxCap = state.sharpeWeighted.capital;

          // Optimal
          let optW = Math.max(0.1, sharpe);
          if (trader.insiderRisk === 'HIGH' || trader.insiderRisk === 'EXTREME') optW *= 1.5;
          if (['iran', 'fed', 'political-economy', 'crypto'].includes(trader.cluster)) optW *= 1.3;
          if (trader.cluster === 'election2024') optW *= 0.3;
          const optSize = Math.min(BASE_SIZE * optW, state.optimal.capital * 0.25);
          state.optimal.capital += optSize * ret;
          state.optimal.trades++;
          if (ret > 0) state.optimal.wins++;
          if (state.optimal.capital > state.optimal.maxCap) state.optimal.maxCap = state.optimal.capital;

          newTrades.push({
            type: 'EXIT',
            username: trader.username || addr.substring(0, 10),
            market: a.title || 'Unknown',
            outcome: a.outcome || '?',
            ret,
            size: a.usdcSize,
            risk: trader.insiderRisk || 'LOW',
            cluster: trader.cluster || 'mixed'
          });

          state.tradeLog.push({
            date: tradeDate,
            username: trader.username,
            market: (a.title || '').substring(0, 60),
            ret: +ret.toFixed(3),
            type: a.type
          });
        }
      }
    } catch (e) {
      // Skip
    }
  }));

  // Save state
  pollState.lastPollTs = Date.now();
  fs.writeFileSync(POLL_STATE_PATH, JSON.stringify(pollState));
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

  // Buffer new trades into pending alerts
  if (!pollState.pendingAlerts) pollState.pendingAlerts = [];
  if (!pollState.lastAlertTs) pollState.lastAlertTs = 0;
  
  const entries = newTrades.filter(t => t.type === 'ENTRY' && t.size > 500);
  const exits = newTrades.filter(t => t.type === 'EXIT');
  
  for (const e of entries) pollState.pendingAlerts.push(e);
  for (const e of exits) pollState.pendingAlerts.push(e);
  
  // Only output if: there are pending alerts AND 1hr+ since last alert
  const hourMs = 60 * 60 * 1000;
  const timeSinceLastAlert = Date.now() - pollState.lastAlertTs;
  
  if (pollState.pendingAlerts.length > 0 && timeSinceLastAlert >= hourMs) {
    const pendingEntries = pollState.pendingAlerts.filter(t => t.type === 'ENTRY');
    const pendingExits = pollState.pendingAlerts.filter(t => t.type === 'EXIT');
    
    let msg = '';
    if (pendingEntries.length > 0) {
      msg += '🚨 **New Trades Detected (last hour)**\n';
      for (const e of pendingEntries.slice(0, 10)) {
        const riskEmoji = e.risk === 'EXTREME' ? '🔴' : e.risk === 'HIGH' ? '🟠' : '🟡';
        msg += `${riskEmoji} **${e.username}** bought **${e.outcome}** on "${e.market.substring(0, 50)}" at ${(e.price * 100).toFixed(0)}¢ ($${e.size.toFixed(0)}) [${e.cluster}]\n`;
      }
      if (pendingEntries.length > 10) msg += `...+${pendingEntries.length - 10} more entries\n`;
    }
    
    if (pendingExits.length > 0) {
      msg += '\n📊 **Positions Closed**\n';
      for (const e of pendingExits.slice(0, 5)) {
        const emoji = e.ret > 0 ? '🟢' : '🔴';
        msg += `${emoji} **${e.username}** — ${e.market.substring(0, 50)} (${e.ret > 0 ? '+' : ''}${(e.ret * 100).toFixed(0)}%)\n`;
      }
      if (pendingExits.length > 5) msg += `...+${pendingExits.length - 5} more\n`;
    }
    
    // Add running strategy totals
    const fmtPct = (v) => { const p = ((v / 10000 - 1) * 100).toFixed(1); return (p >= 0 ? '+' : '') + p + '%'; };
    msg += `\n**Running P&L (since ${state.startDate})**\n`;
    msg += `Equal: ${fmtPct(state.equalWeight.capital)} | Sharpe: ${fmtPct(state.sharpeWeighted.capital)} | Optimal: ${fmtPct(state.optimal.capital)}`;
    
    console.log(msg.trim());
    pollState.pendingAlerts = [];
    pollState.lastAlertTs = Date.now();
  } else {
    console.log('NO_NEW_TRADES');
  }
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
