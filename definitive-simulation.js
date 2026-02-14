#!/usr/bin/env node
// Definitive Shadow Index Simulation v2
// Full range of per-trade amounts + confidence tiers + compound

const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname);
const trades = JSON.parse(fs.readFileSync(path.join(BASE, 'data/trade-history-v2.json'), 'utf8'));
const weights = JSON.parse(fs.readFileSync(path.join(BASE, 'data/trader-weights-v2.json'), 'utf8'));

const STARTING_CAPITAL = 10000;
const CRYPTO_NOISE = /Up or Down.*\d+:\d+\s*(AM|PM)/i;

// Build flat position list
const allPositions = [];
for (const [addr, posList] of Object.entries(trades)) {
  const w = weights[addr];
  const tier = w ? w.tier : 'C';
  const username = w ? w.username : addr.slice(0, 10);
  for (const pos of posList) {
    if (CRYPTO_NOISE.test(pos.market)) continue;
    allPositions.push({
      ...pos, addr, tier, username,
      entryTs: pos.entryDate,
      exitTs: parseInt(pos.date),
    });
  }
}
console.log(`Total positions after crypto filter: ${allPositions.length}`);

function getStartDate(tf) {
  switch (tf) {
    case '1W': return new Date('2026-02-07');
    case '1M': return new Date('2026-01-15');
    case '3M': return new Date('2025-11-16');
    case '6M': return new Date('2025-08-18');
    case '1Y': return new Date('2025-02-14');
    case 'YTD': return new Date('2026-01-01');
    case 'ALL': return new Date('2020-01-01');
  }
}
function dateStr(d) { return d.toISOString().slice(0, 10); }

// Strategy definitions
const FIXED_AMOUNTS = [10, 25, 50, 100, 250, 500, 1000, 2000, 5000];

const CONFIDENCE_TIERS = {
  conservative: { S: 500, A: 300, B: 200, C: 100, D: 50 },
  moderate:     { S: 2000, A: 1500, B: 1000, C: 500, D: 250 },
  aggressive:   { S: 5000, A: 3000, B: 2000, C: 1000, D: 500 },
};

function runSim(tf, getAlloc) {
  const startDate = getStartDate(tf);
  const startTs = startDate.getTime() / 1000;
  const eligible = allPositions.filter(p => p.entryTs >= startTs);

  const events = [];
  for (const p of eligible) {
    events.push({ type: 'ENTRY', ts: p.entryTs, pos: p });
    events.push({ type: 'EXIT', ts: p.exitTs, pos: p });
  }
  events.sort((a, b) => a.ts - b.ts || (a.type === 'EXIT' ? -1 : 1));

  let cash = STARTING_CAPITAL;
  const openPositions = new Map();
  let entered = 0, skipped = 0, wins = 0, losses = 0, totalPositionSize = 0;
  let peakValue = STARTING_CAPITAL, maxDrawdown = 0;
  const dailyValues = new Map();
  const dailyReturns = [];
  let prevPortValue = STARTING_CAPITAL;
  let idleCashSum = 0, snapshots = 0;

  // For compound strategy state
  const state = { doublingThreshold: STARTING_CAPITAL * 2, compoundBase: 1000 };

  function portfolioValue() {
    let ov = 0;
    for (const [, op] of openPositions) ov += op.amount;
    return cash + ov;
  }

  function recordDay(ts) {
    const d = dateStr(new Date(ts * 1000));
    const pv = portfolioValue();
    dailyValues.set(d, { value: pv, cash, openCount: openPositions.size });
  }

  for (const evt of events) {
    if (evt.type === 'EXIT') {
      const key = `${evt.pos.addr}:${evt.pos.slug}:${evt.pos.entryTs}`;
      const op = openPositions.get(key);
      if (!op) continue;
      const returnPct = (evt.pos.exitPrice - evt.pos.entryPrice) / evt.pos.entryPrice;
      const pnl = op.amount * returnPct;
      cash += op.amount + pnl;
      if (pnl >= 0) wins++; else losses++;
      openPositions.delete(key);
      recordDay(evt.ts);
    } else {
      const pv = portfolioValue();
      const amount = getAlloc(evt.pos, cash, pv, state);
      if (amount <= 0 || amount > cash) { skipped++; continue; }
      const key = `${evt.pos.addr}:${evt.pos.slug}:${evt.pos.entryTs}`;
      cash -= amount;
      openPositions.set(key, { amount });
      entered++;
      totalPositionSize += amount;
      recordDay(evt.ts);
    }
  }

  // Build curve
  const sortedDays = [...dailyValues.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const startStr = dateStr(startDate);
  const curve = [];
  if (sortedDays.length === 0 || sortedDays[0][0] > startStr) {
    curve.push({ date: startStr, value: 100 });
  }
  for (const [d, info] of sortedDays) {
    const norm = (info.value / STARTING_CAPITAL) * 100;
    curve.push({ date: d, value: Math.round(norm * 10) / 10 });
    if (info.value > peakValue) peakValue = info.value;
    const dd = (peakValue - info.value) / peakValue * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
    const dr = (info.value - prevPortValue) / prevPortValue;
    if (info.value !== prevPortValue) dailyReturns.push(dr);
    prevPortValue = info.value;
    snapshots++;
    idleCashSum += info.cash / info.value;
  }

  let sharpe = 0;
  if (dailyReturns.length > 1) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (dailyReturns.length - 1);
    sharpe = Math.sqrt(variance) > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : 0;
  }

  const finalValue = portfolioValue();
  const totalTrades = wins + losses;
  return {
    curve,
    stats: {
      totalReturn: Math.round(((finalValue / STARTING_CAPITAL) - 1) * 1000) / 10,
      maxDrawdown: Math.round(maxDrawdown * 10) / 10,
      sharpe: Math.round(sharpe * 100) / 100,
      entered, skipped,
      avgPositionSize: entered > 0 ? Math.round(totalPositionSize / entered) : 0,
      avgIdleCashPct: snapshots > 0 ? Math.round(idleCashSum / snapshots * 100) : 0,
      winRate: totalTrades > 0 ? Math.round(wins / totalTrades * 1000) / 10 : 0,
      trades: totalTrades, wins, losses,
      finalValue: Math.round(finalValue),
    }
  };
}

const timeframes = ['1W', '1M', '3M', '6M', '1Y', 'YTD', 'ALL'];
const output = {};

for (const tf of timeframes) {
  console.log(`\n=== ${tf} ===`);
  const tfResult = {};

  // Fixed amounts
  for (const amt of FIXED_AMOUNTS) {
    const key = `fixed_${amt}`;
    tfResult[key] = runSim(tf, (pos, cash) => cash >= amt ? amt : 0);
    const s = tfResult[key].stats;
    console.log(`  $${amt}: ${s.totalReturn}% | ${s.entered}/${s.entered+s.skipped} entered | DD:${s.maxDrawdown}% | Sharpe:${s.sharpe} | Idle:${s.avgIdleCashPct}%`);
  }

  // Confidence tiers
  for (const [label, tiers] of Object.entries(CONFIDENCE_TIERS)) {
    const key = `conf_${label}`;
    tfResult[key] = runSim(tf, (pos, cash) => {
      const amt = tiers[pos.tier] || tiers.C;
      return cash >= amt ? amt : 0;
    });
    const s = tfResult[key].stats;
    console.log(`  conf_${label}: ${s.totalReturn}% | ${s.entered}/${s.entered+s.skipped} entered | DD:${s.maxDrawdown}%`);
  }

  // Compound (start $1K, +50% at each doubling)
  tfResult.compound = runSim(tf, (pos, cash, pv, state) => {
    if (pv >= state.doublingThreshold) {
      state.compoundBase = state.compoundBase * 1.5;
      state.doublingThreshold = state.doublingThreshold * 2;
    }
    return cash >= state.compoundBase ? state.compoundBase : 0;
  });
  const cs = tfResult.compound.stats;
  console.log(`  compound: ${cs.totalReturn}% | ${cs.entered}/${cs.entered+cs.skipped} entered | DD:${cs.maxDrawdown}%`);

  output[tf] = tfResult;
}

// Write full output
fs.writeFileSync(path.join(BASE, 'data/definitive-simulation.json'), JSON.stringify(output, null, 2));
console.log('\nWrote data/definitive-simulation.json');

// Build INDEX_DATA for dashboard
// Chart shows: fixed_1000 (grey), conf_moderate (purple), compound (green)
// Plus we include the full fixed-amount sweep for a secondary chart
const indexData = {};
for (const tf of timeframes) {
  const tfR = output[tf];
  // Primary 3 lines
  const primary = ['fixed_1000', 'conf_moderate', 'compound'];
  const dateMap = new Map();
  for (const strat of primary) {
    for (const pt of tfR[strat].curve) {
      if (!dateMap.has(pt.date)) dateMap.set(pt.date, { date: pt.date });
      const keyMap = { fixed_1000: 'fixedK', conf_moderate: 'confidence', compound: 'compound' };
      dateMap.get(pt.date)[keyMap[strat]] = pt.value;
    }
  }
  const mergedCurve = [...dateMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  let last = { fixedK: 100, confidence: 100, compound: 100 };
  for (const pt of mergedCurve) {
    for (const s of ['fixedK', 'confidence', 'compound']) {
      if (pt[s] == null) pt[s] = last[s]; else last[s] = pt[s];
    }
  }

  // Fixed amount sweep data (for table/secondary view)
  const fixedSweep = {};
  for (const amt of FIXED_AMOUNTS) {
    const s = tfR[`fixed_${amt}`].stats;
    fixedSweep[amt] = {
      totalReturn: s.totalReturn, maxDrawdown: s.maxDrawdown, sharpe: s.sharpe,
      entered: s.entered, skipped: s.skipped, avgIdleCashPct: s.avgIdleCashPct,
      winRate: s.winRate, finalValue: s.finalValue,
    };
  }

  // Confidence tier sweep
  const confSweep = {};
  for (const label of ['conservative', 'moderate', 'aggressive']) {
    const s = tfR[`conf_${label}`].stats;
    confSweep[label] = {
      totalReturn: s.totalReturn, maxDrawdown: s.maxDrawdown, sharpe: s.sharpe,
      entered: s.entered, skipped: s.skipped, avgIdleCashPct: s.avgIdleCashPct,
      winRate: s.winRate, finalValue: s.finalValue,
    };
  }

  indexData[tf] = {
    curve: mergedCurve,
    stats: {
      totalReturn: {
        fixedK: tfR.fixed_1000.stats.totalReturn,
        confidence: tfR.conf_moderate.stats.totalReturn,
        compound: tfR.compound.stats.totalReturn,
      },
      trades: tfR.fixed_1000.stats.trades,
      winRate: tfR.fixed_1000.stats.winRate,
    },
    fixedSweep,
    confSweep,
    compoundStats: {
      totalReturn: tfR.compound.stats.totalReturn,
      maxDrawdown: tfR.compound.stats.maxDrawdown,
      sharpe: tfR.compound.stats.sharpe,
      entered: tfR.compound.stats.entered,
      skipped: tfR.compound.stats.skipped,
      finalValue: tfR.compound.stats.finalValue,
    },
  };
}

const indexDataStr = JSON.stringify(indexData);
fs.writeFileSync(path.join(BASE, 'data/index-data-definitive.json'), indexDataStr);
console.log('Wrote data/index-data-definitive.json (' + (indexDataStr.length / 1024).toFixed(1) + ' KB)');
