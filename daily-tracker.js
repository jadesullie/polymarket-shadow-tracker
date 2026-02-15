#!/usr/bin/env node
/**
 * Daily Shadow Index Tracker — Dual Strategy Comparison.
 * Reads both live-tracking-state.json (2% strategy) and
 * live-tracking-state-065.json (0.65% strategy), outputs a
 * Discord-ready daily summary comparing both strategies.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STATE_2PCT = path.join(DATA_DIR, 'live-tracking-state.json');
const STATE_065 = path.join(DATA_DIR, 'live-tracking-state-065.json');

function loadState(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function summarize(state) {
  if (!state) return null;
  const today = new Date().toISOString().substring(0, 10);
  const daysSinceStart = Math.floor((Date.now() - new Date(state.startDate).getTime()) / 86400000);

  const todayLog = (state.tradeLog || []).filter(t => t.date === today);
  const todayEntries = Object.values(state.positions || {}).filter(p => p.date === today);
  const todayExits = todayLog.filter(t => t.exitType);
  const todayPnl = todayExits.reduce((s, t) => s + (t.pnl || 0), 0);

  const openPositions = Object.values(state.positions || {});
  const openCount = openPositions.length;
  const positionsAtCost = openPositions.reduce((s, p) => s + p.cost, 0);
  const totalValue = state.cash + positionsAtCost;
  const roi = ((totalValue / (state.startingCapital || 10000) - 1) * 100).toFixed(2);
  const wr = state.trades > 0 ? ((state.wins / state.trades) * 100).toFixed(0) + '%' : 'N/A';

  const exitCounts = {};
  for (const cp of (state.closedPositions || [])) {
    exitCounts[cp.exitType] = (exitCounts[cp.exitType] || 0) + 1;
  }

  return {
    strategy: state.strategy || 'Unknown',
    daysSinceStart, today,
    todayEntries: todayEntries.length,
    todayExits: todayExits.length,
    todayPnl,
    cash: state.cash,
    openCount, positionsAtCost, totalValue,
    realizedPnl: state.totalRealizedPnl || 0,
    roi, trades: state.trades || 0, wr,
    exitCounts,
    topEntries: Object.values(state.positions || {}).filter(p => p.date === today).slice(0, 5),
    topExits: todayExits.slice(0, 5),
  };
}

function fmtDollar(n) {
  return (n >= 0 ? '+' : '') + '$' + Math.abs(n).toFixed(0);
}

function main() {
  const s2 = loadState(STATE_2PCT);
  const s065 = loadState(STATE_065);

  if (!s2 && !s065) {
    console.log('No tracking state found. Waiting for minute poller to initialize.');
    return;
  }

  const a = summarize(s2);
  const b = summarize(s065);
  const today = (a || b).today;
  const days = (a || b).daysSinceStart;

  let msg = `## 📊 Shadow Index — Day ${days} (${today})\n`;
  msg += `### Dual Strategy Comparison\n\n`;

  // Side-by-side comparison
  msg += `**Strategy** │ **2% per trade** │ **0.65% per trade**\n`;

  if (a && b) {
    msg += `📥 Entries today │ ${a.todayEntries} │ ${b.todayEntries}\n`;
    msg += `📤 Exits today │ ${a.todayExits} (${fmtDollar(a.todayPnl)}) │ ${b.todayExits} (${fmtDollar(b.todayPnl)})\n`;
    msg += `💵 Cash │ $${a.cash.toFixed(0)} │ $${b.cash.toFixed(0)}\n`;
    msg += `📂 Open positions │ ${a.openCount} ($${a.positionsAtCost.toFixed(0)}) │ ${b.openCount} ($${b.positionsAtCost.toFixed(0)})\n`;
    msg += `💰 Portfolio value │ ~$${a.totalValue.toFixed(0)} │ ~$${b.totalValue.toFixed(0)}\n`;
    msg += `📈 Realized P&L │ ${fmtDollar(a.realizedPnl)} │ ${fmtDollar(b.realizedPnl)}\n`;
    msg += `🎯 ROI │ ${a.roi}% │ ${b.roi}%\n`;
    msg += `🔄 Trades │ ${a.trades} (${a.wr} WR) │ ${b.trades} (${b.wr} WR)\n`;
  }

  msg += `\n`;

  // Today's notable activity (combined, just show a few highlights)
  const entries = [
    ...((s2 ? Object.values(s2.positions || {}) : []).filter(p => p.date === today).map(e => ({ ...e, strat: '2%' }))),
    ...((s065 ? Object.values(s065.positions || {}) : []).filter(p => p.date === today).map(e => ({ ...e, strat: '0.65%' }))),
  ];

  // Deduplicate entries by market (they share the same trades, just different sizing)
  const seenMarkets = new Set();
  const uniqueEntries = [];
  for (const e of entries) {
    const key = e.username + '|' + e.conditionId;
    if (!seenMarkets.has(key)) {
      seenMarkets.add(key);
      uniqueEntries.push(e);
    }
  }

  if (uniqueEntries.length > 0) {
    msg += `**📥 New Entries Today** (${uniqueEntries.length} unique trades)\n`;
    for (const e of uniqueEntries.slice(0, 8)) {
      msg += `▸ **${e.username}** → "${(e.market || '').substring(0, 50)}" (${e.outcome}) at ${(e.effectiveEntry * 100).toFixed(0)}¢\n`;
    }
    if (uniqueEntries.length > 8) msg += `  ...+${uniqueEntries.length - 8} more\n`;
    msg += '\n';
  }

  // Exit breakdown (all-time, combined view)
  if (a && b) {
    const allExitTypes = new Set([...Object.keys(a.exitCounts), ...Object.keys(b.exitCounts)]);
    if (allExitTypes.size > 0) {
      const labels = { redemption: '✅ Redemption', trader_sell: '📤 Trader Sell', price_ceiling: '🔝 Price Ceiling', time_limit: '⏰ Time Limit' };
      msg += `**Exit Breakdown (all-time)**\n`;
      for (const type of allExitTypes) {
        const label = labels[type] || type;
        msg += `- ${label}: ${a.exitCounts[type] || 0} / ${b.exitCounts[type] || 0}\n`;
      }
    }
  }

  console.log(msg);
}

main();
