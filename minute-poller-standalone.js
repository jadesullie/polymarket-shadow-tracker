#!/usr/bin/env node
/**
 * Standalone minute poller — no agent needed.
 * Checks all 151 wallets, buffers trades, posts to Discord hourly via bot API.
 * Run via launchd every minute.
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

const DISCORD_CHANNEL = '1471959848148140052';
// Read discord token from openclaw config
const OPENCLAW_CONFIG = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.openclaw/openclaw.json'), 'utf8'));
const DISCORD_TOKEN = OPENCLAW_CONFIG.channels?.discord?.token;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout')), 10000);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { clearTimeout(timeout); try { resolve(JSON.parse(data)); } catch { resolve([]); } });
    }).on('error', e => { clearTimeout(timeout); reject(e); });
  });
}

function discordSend(channelId, content) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ content });
    const req = https.request({
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages`,
      method: 'POST',
      headers: {
        'Authorization': `Bot ${DISCORD_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const traders = JSON.parse(fs.readFileSync(TRADERS_PATH, 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

  // Load or init poll state
  let pollState;
  if (fs.existsSync(POLL_STATE_PATH)) {
    pollState = JSON.parse(fs.readFileSync(POLL_STATE_PATH, 'utf8'));
  } else {
    pollState = { lastPollTs: Date.now(), pollCount: 0, pendingAlerts: [], lastAlertTs: 0 };
  }
  if (!pollState.pendingAlerts) pollState.pendingAlerts = [];
  if (!pollState.lastAlertTs) pollState.lastAlertTs = 0;

  // Load or init trading state
  let state;
  if (fs.existsSync(STATE_PATH)) {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } else {
    const histData = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8'));
    const traderSharpes = {};
    for (const [addr, positions] of Object.entries(histData)) {
      if (!Array.isArray(positions) || positions.length < 2) continue;
      const returns = positions.filter(p => p.entryPrice > 0 && p.exitPrice > 0)
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
      tradeLog: []
    };
  }

  const traderMap = {};
  for (const t of traders) { if (t.address) traderMap[t.address.toLowerCase()] = t; }

  // Check ALL wallets — batch 15 concurrent to avoid overwhelming API
  const walletsWithAddr = traders.filter(t => t.address);
  const newTrades = [];
  const BASE_SIZE = 1000;

  for (let i = 0; i < walletsWithAddr.length; i += 15) {
    const batch = walletsWithAddr.slice(i, i + 15);
    await Promise.all(batch.map(async (trader) => {
      const addr = trader.address.toLowerCase();
      try {
        const activities = await httpGet(`https://data-api.polymarket.com/activity?user=${addr}&limit=10`);
        if (!Array.isArray(activities)) return;

        for (const a of activities) {
          const hash = `${addr}-${a.transactionHash}`;
          if (state.processedTrades.includes(hash)) continue;
          if (!a.timestamp) continue;

          // Only count trades after our start timestamp (2026-02-14 08:00 SAST)
          const tradeMs = a.timestamp * 1000;
          if (tradeMs < baseline.startTimestamp) continue;
          const tradeDate = new Date(tradeMs).toISOString().substring(0, 10);

          state.processedTrades.push(hash);

          const isNoise = (a.title || '').match(/Up or Down.*\d+:\d+(AM|PM)/i);
          if (isNoise) continue; // Skip 15-min crypto noise entirely
          
          // Track positions we've entered (BUY after start = we're in this position)
          if (!state.trackedPositions) state.trackedPositions = {};
          const posKey = `${addr}-${a.conditionId}`;
          
          // BUY = entry signal — record that we're now in this position
          if (a.type === 'TRADE' && a.side === 'BUY') {
            if (!state.trackedPositions[posKey]) {
              state.trackedPositions[posKey] = { 
                entryPrice: a.price, 
                username: trader.username || addr.substring(0,10),
                market: a.title || 'Unknown',
                date: tradeDate
              };
            }
            newTrades.push({
              type: 'ENTRY', username: trader.username || addr.substring(0, 10),
              market: a.title || 'Unknown', outcome: a.outcome || '?',
              price: a.price, size: a.usdcSize || 0,
              risk: trader.insiderRisk || 'LOW', cluster: trader.cluster || 'mixed'
            });
          }

          // REDEMPTION = position resolved. Only count P&L if we tracked the entry
          if (a.type === 'REDEMPTION' && state.trackedPositions[posKey]) {
            const entry = state.trackedPositions[posKey];
            // Redeemed at $1. Our entry was at entry.entryPrice
            let ret = entry.entryPrice > 0 && entry.entryPrice < 1 ? (1 - entry.entryPrice) / entry.entryPrice : 0;
            ret = Math.max(-0.5, Math.min(5, ret));
            delete state.trackedPositions[posKey]; // position closed
            const sharpe = state.traderSharpes[addr] || 0;

            // Equal weight
            const eqPnl = Math.min(BASE_SIZE, state.equalWeight.capital * 0.25) * ret;
            state.equalWeight.capital += eqPnl; state.equalWeight.trades++;
            if (ret > 0) state.equalWeight.wins++;
            if (state.equalWeight.capital > state.equalWeight.maxCap) state.equalWeight.maxCap = state.equalWeight.capital;

            // Sharpe-weighted — cap weight at 3x, position at 10% of capital or $2500
            const shWeight = Math.min(3, Math.max(0.1, sharpe));
            const shSize = Math.min(BASE_SIZE * shWeight, state.sharpeWeighted.capital * 0.10, 2500);
            state.sharpeWeighted.capital += shSize * ret; state.sharpeWeighted.trades++;
            if (ret > 0) state.sharpeWeighted.wins++;
            if (state.sharpeWeighted.capital > state.sharpeWeighted.maxCap) state.sharpeWeighted.maxCap = state.sharpeWeighted.capital;

            // Optimal — cap at 10% of capital or $3000
            let optW = Math.min(3, Math.max(0.1, sharpe));
            if (trader.insiderRisk === 'HIGH' || trader.insiderRisk === 'EXTREME') optW = Math.min(optW * 1.5, 4);
            if (['iran', 'fed', 'political-economy', 'crypto'].includes(trader.cluster)) optW = Math.min(optW * 1.3, 5);
            if (trader.cluster === 'election2024') optW *= 0.3;
            const optSize = Math.min(BASE_SIZE * optW, state.optimal.capital * 0.10, 3000);
            state.optimal.capital += optSize * ret; state.optimal.trades++;
            if (ret > 0) state.optimal.wins++;
            if (state.optimal.capital > state.optimal.maxCap) state.optimal.maxCap = state.optimal.capital;

            newTrades.push({
              type: 'EXIT', username: trader.username || addr.substring(0, 10),
              market: a.title || 'Unknown', ret,
              risk: trader.insiderRisk || 'LOW', cluster: trader.cluster || 'mixed'
            });

            state.tradeLog.push({ date: tradeDate, username: trader.username, market: (a.title||'').substring(0,60), ret: +ret.toFixed(3) });
          }
          
          // SELL on a tracked position — close it without P&L (we don't know exit value reliably)
          if (a.type === 'TRADE' && a.side === 'SELL' && state.trackedPositions[posKey]) {
            // Could estimate P&L here but safer to just mark as exited
            delete state.trackedPositions[posKey];
          }
        }
      } catch (e) { /* skip */ }
    }));
  }

  // Buffer alerts
  for (const t of newTrades.filter(t => t.type === 'ENTRY' && (t.size || 0) > 500)) {
    pollState.pendingAlerts.push(t);
  }
  for (const t of newTrades.filter(t => t.type === 'EXIT')) {
    pollState.pendingAlerts.push(t);
  }

  // Post to Discord if 1hr+ since last alert AND there are pending alerts
  const hourMs = 60 * 60 * 1000;
  if (pollState.pendingAlerts.length > 0 && (Date.now() - pollState.lastAlertTs) >= hourMs) {
    const entries = pollState.pendingAlerts.filter(t => t.type === 'ENTRY');
    const exits = pollState.pendingAlerts.filter(t => t.type === 'EXIT');

    let msg = '';
    if (entries.length > 0) {
      msg += '🚨 **New Trades Detected (last hour)**\n';
      for (const e of entries.slice(0, 10)) {
        const riskEmoji = e.risk === 'EXTREME' ? '🔴' : e.risk === 'HIGH' ? '🟠' : '🟡';
        msg += `${riskEmoji} **${e.username}** bought **${e.outcome}** on "${e.market.substring(0, 50)}" at ${(e.price * 100).toFixed(0)}¢ ($${(e.size||0).toFixed(0)}) [${e.cluster}]\n`;
      }
      if (entries.length > 10) msg += `...+${entries.length - 10} more entries\n`;
    }
    if (exits.length > 0) {
      msg += '\n📊 **Positions Closed**\n';
      for (const e of exits.slice(0, 5)) {
        const emoji = e.ret > 0 ? '🟢' : '🔴';
        msg += `${emoji} **${e.username}** — ${e.market.substring(0, 50)} (${e.ret > 0 ? '+' : ''}${(e.ret * 100).toFixed(0)}%)\n`;
      }
      if (exits.length > 5) msg += `...+${exits.length - 5} more\n`;
    }

    const fmtPct = (v) => { const p = ((v / 10000 - 1) * 100).toFixed(1); return (p >= 0 ? '+' : '') + p + '%'; };
    msg += `\n**Running P&L (since ${state.startDate})**\n`;
    msg += `Equal: ${fmtPct(state.equalWeight.capital)} | Sharpe: ${fmtPct(state.sharpeWeighted.capital)} | Optimal: ${fmtPct(state.optimal.capital)}`;

    // Write alert to file for agent cron to pick up
    fs.writeFileSync(path.join(DATA_DIR, 'pending-discord-alert.txt'), msg);
    console.log('Alert queued:', entries.length, 'entries,', exits.length, 'exits');

    pollState.pendingAlerts = [];
    pollState.lastAlertTs = Date.now();
  } else {
    console.log(`Poll ${pollState.pollCount}: ${newTrades.length} new, ${pollState.pendingAlerts.length} pending`);
  }

  // Trim processedTrades to last 10K to prevent unbounded growth
  if (state.processedTrades.length > 10000) {
    state.processedTrades = state.processedTrades.slice(-5000);
  }

  pollState.pollCount++;
  pollState.lastPollTs = Date.now();
  fs.writeFileSync(POLL_STATE_PATH, JSON.stringify(pollState));
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
