#!/usr/bin/env node
const fs = require('fs');

const history = JSON.parse(fs.readFileSync('data/trade-history-v3.json', 'utf8'));
const noise = /Up or Down/i;
const cryptoPrice = /\b(Bitcoin|BTC|Ethereum|ETH|Solana|SOL|XRP|Dogecoin|DOGE)\b.*(above|below|dip|reach|less than|between|price of|hit \$|FDV)/i;

const allTrades = [];
for (const [wallet, trades] of Object.entries(history)) {
  for (const t of trades) {
    if (noise.test(t.market) || cryptoPrice.test(t.market)) continue;
    allTrades.push({
      wallet, market: t.market,
      entryDate: parseInt(t.entryDate), exitDate: parseInt(t.date),
      entryPrice: t.entryPrice, exitPrice: t.exitPrice, outcome: t.outcome,
      returnRatio: t.exitPrice / t.entryPrice
    });
  }
}
allTrades.sort((a, b) => a.entryDate - b.entryDate);

const todayTs = Math.floor(new Date('2026-02-14').getTime() / 1000);
const tfCutoffs = {
  'YTD': Math.floor(new Date('2026-01-01').getTime() / 1000),
  '3M': todayTs - 90 * 86400,
  '6M': todayTs - 180 * 86400,
  '1Y': todayTs - 365 * 86400,
  'ALL': 0
};

const dollarKeys = [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 65, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000];
const START = 10000;
const result = {};

for (const [tf, cutoff] of Object.entries(tfCutoffs)) {
  result[tf] = {};
  const tfTrades = allTrades.filter(t => t.entryDate >= cutoff);
  
  for (const betSize of dollarKeys) {
    let portfolio = START, locked = 0, peak = START, maxDD = 0;
    let entered = 0, skipped = 0, wins = 0, peakConc = 0;
    const events = [];
    tfTrades.forEach(t => {
      events.push({type:'entry', date: t.entryDate, trade: t});
      events.push({type:'exit', date: t.exitDate, trade: t});
    });
    events.sort((a,b) => a.date - b.date || (a.type === 'exit' ? -1 : 1));
    const open = new Map();
    
    for (const ev of events) {
      if (ev.type === 'entry') {
        if (betSize <= portfolio - locked) {
          open.set(ev.trade, betSize);
          locked += betSize;
          entered++;
          if (open.size > peakConc) peakConc = open.size;
        } else { skipped++; }
      } else {
        const bs = open.get(ev.trade);
        if (bs !== undefined) {
          const pnl = bs * (ev.trade.returnRatio - 1);
          portfolio += pnl;
          locked -= bs;
          open.delete(ev.trade);
          if (ev.trade.outcome === 'Profit') wins++;
          if (portfolio > peak) peak = portfolio;
          const dd = (peak - portfolio) / peak * 100;
          if (dd > maxDD) maxDD = dd;
        }
      }
    }
    
    const total = tfTrades.length;
    result[tf][betSize] = {
      betSize, pctOfPortfolio: (betSize/START*100).toFixed(1),
      finalValue: Math.round(portfolio), totalReturn: ((portfolio-START)/START*100).toFixed(1),
      entered, skipped, total, hitRate: (entered/total*100).toFixed(1),
      winRate: entered > 0 ? (wins/entered*100).toFixed(1) : '0.0',
      peakConcurrent: peakConc, maxDD: maxDD.toFixed(1),
      avgIdleCash: ((START - locked) / START * 100).toFixed(1)
    };
  }
  const s = result[tf][65];
  console.log(`${tf}: ${s.entered}/${s.total} trades, $${s.finalValue} (${s.totalReturn}%), WR ${s.winRate}%, DD ${s.maxDD}%`);
}

fs.writeFileSync('data/bet-size-analysis.json', JSON.stringify(result, null, 2));
console.log('Saved data/bet-size-analysis.json');
