#!/usr/bin/env node
/**
 * Realistic Strategy Simulator
 * Same logic as the Journal tab's applyEventsToSim / initSimState / computeBetSize
 * With capital constraints, first-buy dedup, cash tracking
 * Now supports: trailing stops, price ceiling/floor, time limits, trader filter
 */

const fs = require('fs');
const path = require('path');

const journalData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/journal-daily.json'), 'utf8'));
const strategyLib = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/strategy-library.json'), 'utf8'));

// Load price history and token mapping for exit rules
const priceHistory = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/price-history.json'), 'utf8'));
const marketSideToToken = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/market-side-to-token.json'), 'utf8'));
const topPerformers = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'data/top-performers.json'), 'utf8')));

const STARTING_CAPITAL = 10000;
const allDates = Object.keys(journalData).sort();

function initSimState() {
  return { cash: STARTING_CAPITAL, positions: new Map(), cumPnl: 0, dayPnl: 0, _closedKeys: new Set() };
}

function computeBetSize(strategy, portfolioValue) {
  const pct = strategy.sizePct / 100;
  if (strategy.sizing === 'fixed') {
    return STARTING_CAPITAL * pct;
  }
  return portfolioValue * pct;
}

function getPortfolioValue(state) {
  let locked = 0;
  for (const p of state.positions.values()) locked += p.cost;
  return state.cash + locked;
}

function getTokenForPosition(market, side) {
  return marketSideToToken[market + '|' + side] || null;
}

function getPriceForDate(tokenId, date) {
  if (!tokenId || !priceHistory[tokenId]) return null;
  return priceHistory[tokenId][date] ?? null;
}

function daysBetween(d1, d2) {
  return (new Date(d2 + 'T00:00:00Z') - new Date(d1 + 'T00:00:00Z')) / 86400000;
}

function applyExitRules(state, strategy, currentDate) {
  // Check trailing stop, price ceiling/floor, time limit
  if (strategy.exitRule !== 'trailing-stop-price') return;

  const toDelete = [];
  for (const [key, pos] of state.positions) {
    const tokenId = pos.tokenId || getTokenForPosition(pos._market, pos._side);
    const currentPrice = tokenId ? getPriceForDate(tokenId, currentDate) : null;

    if (currentPrice != null) {
      // Update peak price
      if (currentPrice > (pos.peakPrice || 0)) {
        pos.peakPrice = currentPrice;
      }

      let exitReason = null;

      // Trailing stop: price dropped >X% from peak
      if (strategy.trailingStopPct && pos.peakPrice > 0) {
        const dropPct = ((pos.peakPrice - currentPrice) / pos.peakPrice) * 100;
        if (dropPct >= strategy.trailingStopPct) {
          exitReason = 'trailing-stop';
        }
      }

      // Price ceiling
      if (!exitReason && strategy.priceCeiling && currentPrice > strategy.priceCeiling) {
        exitReason = 'price-ceiling';
      }

      // Price floor
      if (!exitReason && strategy.priceFloor && currentPrice < strategy.priceFloor) {
        exitReason = 'price-floor';
      }

      // Time limit
      if (!exitReason && strategy.timeLimitDays && pos.entryDate) {
        const held = daysBetween(pos.entryDate, currentDate);
        if (held >= strategy.timeLimitDays) {
          exitReason = 'time-limit';
        }
      }

      if (exitReason) {
        const proceeds = pos.shares * currentPrice;
        const pnl = proceeds - pos.cost;
        state.cash += proceeds;
        state.dayPnl += pnl;
        state.cumPnl += pnl;
        toDelete.push(key);
      }
    } else {
      // No price available — still check time limit with cost-based exit
      if (strategy.timeLimitDays && pos.entryDate) {
        const held = daysBetween(pos.entryDate, currentDate);
        if (held >= strategy.timeLimitDays) {
          // Exit at cost (wash) since we don't know price
          state.cash += pos.cost;
          toDelete.push(key);
        }
      }
    }
  }
  for (const k of toDelete) { state.positions.delete(k); if (state._closedKeys) state._closedKeys.add(k); }
}

function applyEventsToSim(state, events, strategy) {
  state.dayPnl = 0;

  // Apply exit rules FIRST (before processing new events)
  applyExitRules(state, strategy, state._currentDate);

  for (const ev of events) {
    // Market filter
    if (ev.t === 'B' && strategy.marketFilter === 'high-conviction' && ev.sz < 1000) continue;

    // Trader filter
    if (ev.t === 'B' && strategy.traderFilter === 'top-performers') {
      if (!topPerformers.has(ev.tr)) continue;
    }

    const key = `${ev.tr}|${ev.m}|${ev.s}`;

    if (ev.t === 'B') {
      // Entry ceiling: skip entries where effective price >= $0.90
      const effectivePrice = ev.mp || ev.p;
      if (effectivePrice >= 0.90) continue;

      // Entry rule
      if (strategy.entryRule === 'first-buy') {
        if (state.positions.has(key)) continue;
      }

      // No re-entry after exit: once a posKey is closed, don't re-enter
      if (state._closedKeys && state._closedKeys.has(key)) continue;

      const posKey = strategy.entryRule === 'every-buy' ? `${key}|${Date.now()}|${Math.random()}` : key;

      const portVal = getPortfolioValue(state);
      let betSize;
      if (strategy.sizing === 'proportional') {
        const maxBet = portVal * (strategy.sizePct / 100);
        betSize = Math.min(ev.sz, maxBet);
      } else {
        betSize = computeBetSize(strategy, portVal);
      }
      // Only cap at trader's liquidity when it's a stale-price snipe
      const maxLiquidity = ev.mp ? (ev.sz > 0 ? ev.sz : Infinity) : Infinity;
      const cost = Math.min(betSize, state.cash, maxLiquidity);
      if (cost <= 0) continue;
      const shares = cost / effectivePrice;
      const tokenId = getTokenForPosition(ev.m, ev.s);
      state.positions.set(posKey, {
        cost, shares,
        buyDate: state._currentDate,
        entryDate: state._currentDate,
        peakPrice: effectivePrice,
        tokenId: tokenId,
        _market: ev.m,
        _side: ev.s
      });
      state.cash -= cost;
    } else if (ev.t === 'S') {
      if (strategy.entryRule === 'every-buy') {
        const matchingKeys = [];
        for (const [k] of state.positions) {
          if (k.startsWith(key + '|') || k === key) matchingKeys.push(k);
        }
        for (const mk of matchingKeys) {
          const pos = state.positions.get(mk);
          if (!pos) continue;
          const sellRatio = Math.min(1, ev.sz / pos.cost);
          const soldCost = pos.cost * sellRatio;
          const soldShares = pos.shares * sellRatio;
          const proceeds = soldShares * ev.p;
          const pnl = proceeds - soldCost;
          state.cash += proceeds;
          state.dayPnl += pnl;
          state.cumPnl += pnl;
          if (sellRatio >= 0.999) { state.positions.delete(mk); if (state._closedKeys) state._closedKeys.add(mk.split("|").slice(0,3).join("|")); }
          else { pos.cost -= soldCost; pos.shares -= soldShares; }
        }
      } else {
        const pos = state.positions.get(key);
        if (!pos) continue;
        const sellRatio = Math.min(1, ev.sz / pos.cost);
        const soldCost = pos.cost * sellRatio;
        const soldShares = pos.shares * sellRatio;
        const proceeds = soldShares * ev.p;
        const pnl = proceeds - soldCost;
        state.cash += proceeds;
        state.dayPnl += pnl;
        state.cumPnl += pnl;
        if (sellRatio >= 0.999) { state.positions.delete(key); if (state._closedKeys) state._closedKeys.add(key); }
        else { pos.cost -= soldCost; pos.shares -= soldShares; }
      }
    } else if (ev.t === 'R') {
      if (strategy.entryRule === 'every-buy') {
        const matchingKeys = [];
        for (const [k] of state.positions) {
          if (k.startsWith(key + '|') || k === key) matchingKeys.push(k);
        }
        for (const mk of matchingKeys) {
          const pos = state.positions.get(mk);
          if (!pos) continue;
          const proceeds = pos.shares * 1.0;
          const pnl = proceeds - pos.cost;
          state.cash += proceeds;
          state.dayPnl += pnl;
          state.cumPnl += pnl;
          state.positions.delete(mk);
          if (state._closedKeys) state._closedKeys.add(mk.split('|').slice(0,3).join('|'));
        }
      } else {
        const pos = state.positions.get(key);
        if (!pos) continue;
        const proceeds = pos.shares * 1.0;
        const pnl = proceeds - pos.cost;
        state.cash += proceeds;
        state.dayPnl += pnl;
        state.cumPnl += pnl;
        state.positions.delete(key);
        if (state._closedKeys) state._closedKeys.add(key);
      }
    }
  }

  // Legacy stop-loss: force-sell positions held > 30 days
  if (strategy.exitRule === 'stop-loss-30d') {
    const toDelete = [];
    for (const [k, pos] of state.positions) {
      if (!pos.buyDate) continue;
      const daysHeld = daysBetween(pos.buyDate, state._currentDate);
      if (daysHeld >= 30) {
        state.cash += pos.cost;
        toDelete.push(k);
      }
    }
    for (const k of toDelete) { state.positions.delete(k); if (state._closedKeys) state._closedKeys.add(k); }
  }

  return state;
}

function simulateStrategy(strategy) {
  const state = initSimState();
  const curve = [];
  const dailyReturns = [];
  let prevValue = STARTING_CAPITAL;
  let peak = STARTING_CAPITAL;
  let maxDD = 0;
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let totalHoldDays = 0;
  let closedTrades = 0;

  const openPositions = new Map();

  for (const date of allDates) {
    state._currentDate = date;
    const events = journalData[date] || [];

    const posBefore = new Set(state.positions.keys());

    applyEventsToSim(state, events, strategy);

    for (const k of state.positions.keys()) {
      if (!posBefore.has(k) && !openPositions.has(k)) {
        openPositions.set(k, date);
        totalTrades++;
      }
    }

    for (const k of posBefore) {
      if (!state.positions.has(k)) {
        closedTrades++;
        const buyDate = openPositions.get(k);
        if (buyDate) {
          const hold = daysBetween(buyDate, date);
          totalHoldDays += hold;
        }
        openPositions.delete(k);
      }
    }

    if (state.dayPnl > 0) wins++;
    else if (state.dayPnl < 0) losses++;

    const portVal = getPortfolioValue(state);
    curve.push({ date, value: Math.round(portVal * 100) / 100 });

    const dailyRet = prevValue > 0 ? (portVal - prevValue) / prevValue : 0;
    dailyReturns.push(dailyRet);
    prevValue = portVal;

    if (portVal > peak) peak = portVal;
    const dd = peak > 0 ? ((peak - portVal) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const finalValue = getPortfolioValue(state);
  const totalReturn = ((finalValue / STARTING_CAPITAL) - 1) * 100;

  const meanReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((a, r) => a + (r - meanReturn) ** 2, 0) / dailyReturns.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(365) : 0;

  const tradingDays = dailyReturns.filter(r => r !== 0).length;
  const winDays = dailyReturns.filter(r => r > 0).length;
  const winRate = tradingDays > 0 ? (winDays / tradingDays) * 100 : 0;

  const avgHold = closedTrades > 0 ? totalHoldDays / closedTrades : 0;

  return {
    curve,
    stats: {
      finalValue: Math.round(finalValue),
      return: Math.round(totalReturn * 100) / 100,
      sharpe: Math.round(sharpe * 100) / 100,
      maxDD: Math.round(maxDD * 100) / 100,
      winRate: Math.round(winRate * 100) / 100,
      trades: totalTrades,
      avgHold: Math.round(avgHold * 10) / 10
    }
  };
}

function filterCurveByTimeframe(curve, tf) {
  if (tf === 'ALL') return curve;
  const lastDate = curve[curve.length - 1].date;
  const lastTs = new Date(lastDate + 'T00:00:00Z');
  let cutoff;
  if (tf === 'YTD') {
    cutoff = new Date(lastTs.getFullYear() + '-01-01T00:00:00Z');
  } else if (tf === '1Y') {
    cutoff = new Date(lastTs); cutoff.setFullYear(cutoff.getFullYear() - 1);
  } else if (tf === '6M') {
    cutoff = new Date(lastTs); cutoff.setMonth(cutoff.getMonth() - 6);
  } else if (tf === '3M') {
    cutoff = new Date(lastTs); cutoff.setMonth(cutoff.getMonth() - 3);
  }
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return curve.filter(p => p.date >= cutoffStr);
}

function computeStatsForCurve(curve) {
  if (curve.length < 2) return null;
  const startVal = curve[0].value;
  const endVal = curve[curve.length - 1].value;
  const totalReturn = ((endVal / startVal) - 1) * 100;
  
  let peak = startVal, maxDD = 0;
  const dailyReturns = [];
  for (let i = 1; i < curve.length; i++) {
    const r = curve[i - 1].value > 0 ? (curve[i].value - curve[i - 1].value) / curve[i - 1].value : 0;
    dailyReturns.push(r);
    if (curve[i].value > peak) peak = curve[i].value;
    const dd = peak > 0 ? ((peak - curve[i].value) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const std = Math.sqrt(dailyReturns.reduce((a, r) => a + (r - mean) ** 2, 0) / dailyReturns.length);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;
  const winDays = dailyReturns.filter(r => r > 0).length;
  const tradeDays = dailyReturns.filter(r => r !== 0).length;

  return {
    finalValue: Math.round(endVal),
    return: Math.round(totalReturn * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    maxDD: Math.round(maxDD * 100) / 100,
    winRate: tradeDays > 0 ? Math.round((winDays / tradeDays) * 10000) / 100 : 0,
    trades: '—',
    avgHold: '—'
  };
}

// Run all strategies
const results = {};
const timeframes = ['ALL', '1Y', 'YTD'];

for (const strat of strategyLib.strategies) {
  console.log(`Simulating ${strat.name}...`);
  const sim = simulateStrategy(strat);
  results[strat.id] = {};

  for (const tf of timeframes) {
    if (tf === 'ALL') {
      const step = Math.max(1, Math.floor(sim.curve.length / 400));
      const sampled = sim.curve.filter((_, i) => i % step === 0 || i === sim.curve.length - 1);
      results[strat.id].ALL = { curve: sampled, stats: sim.stats };
    } else {
      const filtered = filterCurveByTimeframe(sim.curve, tf);
      const step = Math.max(1, Math.floor(filtered.length / 400));
      const sampled = filtered.filter((_, i) => i % step === 0 || i === filtered.length - 1);
      const stats = computeStatsForCurve(filtered);
      if (stats) {
        stats.trades = sim.stats.trades;
        stats.avgHold = sim.stats.avgHold;
        results[strat.id][tf] = { curve: sampled, stats };
      }
    }
  }

  console.log(`  → Final: $${sim.stats.finalValue.toLocaleString()}, Return: ${sim.stats.return}%, Trades: ${sim.stats.trades}, Sharpe: ${sim.stats.sharpe}`);
}

fs.writeFileSync(path.join(__dirname, 'data/strategy-results-realistic.json'), JSON.stringify(results));
fs.writeFileSync(path.join(__dirname, 'data/strategy-results.json'), JSON.stringify(results));
console.log('\nDone! Results written to data/strategy-results.json');
