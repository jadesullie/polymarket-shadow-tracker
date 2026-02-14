#!/usr/bin/env node
/**
 * Dynamic % of Portfolio Bet Size Simulation
 * Instead of fixed $X per trade, bet = current_portfolio_value × percentage
 * This compounds: wins → bigger bets, losses → smaller bets
 */
const fs = require('fs');

const history = JSON.parse(fs.readFileSync('data/trade-history-v3.json', 'utf8'));
const noise = /Up or Down.*\d+.*(?:AM|PM)/i;
const cryptoPrice = /\b(Bitcoin|BTC|Ethereum|ETH|Solana|SOL|XRP|Dogecoin|DOGE)\b.*(above|below)\s*\$|FDV above/i;

// Flatten all trades, filter noise, sort by entry date
const allTrades = [];
for (const [wallet, trades] of Object.entries(history)) {
  for (const t of trades) {
    if (noise.test(t.market) || cryptoPrice.test(t.market)) continue;
    allTrades.push({
      wallet,
      market: t.market,
      entryDate: parseInt(t.entryDate),
      exitDate: parseInt(t.date),
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      outcome: t.outcome,
      // For shadow trading: we buy at entryPrice, position resolves
      // Return per $1 invested: exitPrice / entryPrice
      returnRatio: t.exitPrice / t.entryPrice
    });
  }
}
allTrades.sort((a, b) => a.entryDate - b.entryDate);

const today = new Date('2026-02-14');
const todayTs = Math.floor(today.getTime() / 1000);

// Timeframe cutoffs
const tfCutoffs = {
  'YTD': Math.floor(new Date('2026-01-01').getTime() / 1000),
  '3M': todayTs - 90 * 86400,
  '6M': todayTs - 180 * 86400,
  '1Y': todayTs - 365 * 86400,
  'ALL': 0
};

// Percentages to test (of portfolio)
const pctLevels = [0.01, 0.05, 0.1, 0.25, 0.5, 0.65, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];
// Dollar keys to match existing structure
const dollarKeys = [1, 5, 10, 25, 50, 65, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000];

const STARTING_CAPITAL = 10000;
const DAY = 86400;

function simulate(trades, pctOfPortfolio) {
  let cash = STARTING_CAPITAL;
  const openPositions = []; // {cost, entryTs, exitTs, returnRatio}
  let entered = 0, skipped = 0, wins = 0;
  let maxPortfolioValue = STARTING_CAPITAL;
  let maxDD = 0;
  let peakConcurrent = 0;
  let cashSamples = 0, cashSum = 0;

  // Build event timeline
  const events = [];
  for (const t of trades) {
    events.push({ type: 'enter', ts: t.entryDate, trade: t });
    events.push({ type: 'exit', ts: t.exitDate, trade: t });
  }
  events.sort((a, b) => a.ts - b.ts || (a.type === 'exit' ? -1 : 1));

  // Track which positions are open (by index)
  const openMap = new Map(); // tradeRef → {cost, returnRatio}
  let tradeIdx = 0;

  for (const e of events) {
    if (e.type === 'exit') {
      const key = `${e.trade.wallet}|${e.trade.market}|${e.trade.entryDate}`;
      const pos = openMap.get(key);
      if (pos) {
        // Position resolves: get back cost * returnRatio
        cash += pos.cost * pos.returnRatio;
        openMap.delete(key);
      }
    } else {
      // Entry: calculate bet size as % of current portfolio value
      const openInvested = [...openMap.values()].reduce((s, p) => s + p.cost, 0);
      const portfolioValue = cash + openInvested;
      const betSize = portfolioValue * (pctOfPortfolio / 100);

      if (betSize <= cash && betSize >= 0.01) {
        cash -= betSize;
        const key = `${e.trade.wallet}|${e.trade.market}|${e.trade.entryDate}`;
        openMap.set(key, { cost: betSize, returnRatio: e.trade.returnRatio });
        entered++;
        if (e.trade.outcome === 'Profit') wins++;

        if (openMap.size > peakConcurrent) peakConcurrent = openMap.size;
      } else {
        skipped++;
      }

      // Track portfolio value for drawdown
      const openInvested2 = [...openMap.values()].reduce((s, p) => s + p.cost, 0);
      const pv = cash + openInvested2;
      if (pv > maxPortfolioValue) maxPortfolioValue = pv;
      const dd = (maxPortfolioValue - pv) / maxPortfolioValue;
      if (dd > maxDD) maxDD = dd;

      // Track idle cash
      cashSamples++;
      cashSum += cash / pv;
    }
  }

  // Final value: cash + resolve all remaining open positions at cost (conservative)
  const openInvested = [...openMap.values()].reduce((s, p) => s + p.cost, 0);
  const finalValue = cash + openInvested;
  // Actually for resolved trades we already handled them; remaining open ones use cost
  
  const total = entered + skipped;
  const totalReturn = ((finalValue - STARTING_CAPITAL) / STARTING_CAPITAL) * 100;
  const hitRate = total > 0 ? (entered / total) * 100 : 0;
  const winRate = entered > 0 ? (wins / entered) * 100 : 0;
  const avgIdleCash = cashSamples > 0 ? (cashSum / cashSamples) * 100 : 100;

  return {
    finalValue: Math.round(finalValue),
    totalReturn: totalReturn.toFixed(1),
    entered,
    skipped,
    total,
    hitRate: hitRate.toFixed(1),
    winRate: winRate.toFixed(1),
    peakConcurrent,
    maxDD: (maxDD * 100).toFixed(1),
    avgIdleCash: avgIdleCash.toFixed(1)
  };
}

const result = {};

for (const [tf, cutoff] of Object.entries(tfCutoffs)) {
  const tfTrades = allTrades.filter(t => t.entryDate >= cutoff);
  result[tf] = {};

  for (let i = 0; i < pctLevels.length; i++) {
    const pct = pctLevels[i];
    const dollarKey = dollarKeys[i];
    const sim = simulate(tfTrades, pct);
    result[tf][String(dollarKey)] = {
      betSize: dollarKey,
      pctOfPortfolio: pct.toString(),
      ...sim
    };
    
    if (tf === 'ALL') {
      console.log(`${pct}% → Final: $${sim.finalValue.toLocaleString()} (${sim.totalReturn}%) | ${sim.entered}/${sim.total} trades | Win: ${sim.winRate}% | DD: ${sim.maxDD}%`);
    }
  }
}

fs.writeFileSync('data/bet-size-dynamic.json', JSON.stringify(result, null, 2));
console.log('\nSaved to data/bet-size-dynamic.json');
