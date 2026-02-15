#!/usr/bin/env node
/**
 * Replay all trades from top performers since baseline through BOTH strategies.
 * Rebuilds live-tracking-state.json (2%) and live-tracking-state-065.json (0.65%).
 */
const fs = require('fs');
const https = require('https');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STATE_A_PATH = path.join(DATA_DIR, 'live-tracking-state.json');
const STATE_B_PATH = path.join(DATA_DIR, 'live-tracking-state-065.json');
const TRADERS_PATH = path.join(DATA_DIR, 'all-traders.json');
const BASELINE_PATH = path.join(DATA_DIR, 'live-tracking-baseline.json');

const STRAT_A = { positionSize: 200, startingCapital: 10000, priceCeiling: 0.90, timeLimitDays: 180, label: '2%' };
const STRAT_B = { positionSize: 65, startingCapital: 10000, priceCeiling: 0.90, timeLimitDays: 180, label: '0.65%' };

const TOP_PERFORMERS = new Set([
  '0x000d257d2dc7616feaef4ae0f14600fdf50a758e','0x01542a212c9696da5b409cae879143b8966115a8',
  '0x0562c423912e325f83fa79df55085979e1f5594f','0x095dcfb123a4bc035ee6b0d624bab0cc964352cf',
  '0x09abc5845c024a4f9a3abff29d95057e6b20e832','0x0c0e270cf879583d6a0142fc817e05b768d0434e',
  '0x0e9b9cb7ee710b57fbcbefdcb518a3a986a16e75','0x128a251f2300694ae6ea9d77e076ea8ea4e097c2',
  '0x16f91db2592924cfed6e03b7e5cb5bb1e32299e3','0x1e1f17412069c0736adfaadf8ee7f46e5612c855',
  '0x1f2dd6d473f3e824cd2f8a89d9c69fb96f6ad0cf','0x226bf1220731af372b1e7d572959414f31b4cad6',
  '0x23786fdad0073692157c6d7dc81f281843a35fcb','0x25e64cd559e8c46a888d8ebfa47d4490e810cc9f',
  '0x29d683970afb6f722ea1f9d4417c7ee7057cd57f','0x2aac99d0ee5b8d95fbd48e16ce37d90bbd7f1b36',
  '0x2bf64b86b64c315d879571b07a3b76629e467cd0','0x31a56e9e690c621ed21de08cb559e9524cdb8ed9',
  '0x3d1ecf16942939b3603c2539a406514a40b504d0','0x448861155279dbf833d041b963e3ac854599e319',
  '0x44c1dfe43260c94ed4f1d00de2e1f80fb113ebc1','0x4a38e6e0330c2463fb5ac2188a620634039abfe8',
  '0x509587cbb541251c74f261df3421f1fcc9fdc97c','0x551e72eda42a5ab39d6d78239a1d9bbb5db6b0e0',
  '0x55be7aa03ecfbe37aa5460db791205f7ac9ddca3','0x56687bf447db6ffa42ffe2204a05edaa20f55839',
  '0x5739ddf8672627ce076eff5f444610a250075f1a','0x5bffcf561bcae83af680ad600cb99f1184d6ffbe',
  '0x629bc4a1e53e1d475beb7ea3d388791e96dd995a','0x68469ab9009f2783e243a1d0957f4cdd8939b797',
  '0x68c24bf4a8ad4d79a6fe4b8eec6f93a02dfd1711','0x6b88b6a431c5ec9b3afdb76e69393d0404909856',
  '0x6f2628a8ac6e3f7bd857657d5316c33822ced136','0x7058c8a7cec79010b1927d05837dcf25f1a53505',
  '0x7177a7f5c216809c577c50c77b12aae81f81ddef','0x71a70f24538d885d1b45f9cea158a2cdf2e56fcf',
  '0x71edffd0d70a1da823ff07a3c6fc81457294d338','0x73f8dd50a114884493dbf4a5ea1503f96f348234',
  '0x751a2b86cab503496efd325c8344e10159349ea1','0x78b9ac44a6d7d7a076c14e0ad518b301b63c6b76',
  '0x79f293c48f651baa31c8086a228102f57b127620','0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b',
  '0x7dc64a570c7b76831cf25e31c526f2337a050fa2','0x80cd8310aa624521e9e1b2b53b568cafb0ef0273',
  '0x8119010a6e589062aa03583bb3f39ca632d9f887','0x863134d00841b2e200492805a01e1e2f5defaa53',
  '0x885783760858e1bd5dd09a3c3f916cfa251ac270','0x889e7f0464c72eb8cda1525ebc12b6aaba9d09e0',
  '0x8a4c788f043023b8b28a762216d037e9f148532b','0x8b5a7da2fdf239b51b9c68a2a1a35bb156d200f2',
  '0x8e5c0cc55cda93d6cae14becb3b738a44dcaa68a','0x96489abcb9f583d6835c8ef95ffc923d05a86825',
  '0x96b59f71f635da5da031e3e93448c54fe226f5e7','0x9d84ce0306f8551e02efef1680475fc0f1dc1344',
  '0xa2f1fecf1cc7db65a46588f764b6691533052d22','0xb74711992caf6d04fa55eecc46b8efc95311b050',
  '0xba664f999a18dce0aac6af698af434924a24f59d','0xbcd6358b674834ec8101c238ec0d52540f0c0790',
  '0xcf0d7f69cf162918b33fc1ea7449583fa537132d','0xd0c042c08f755ff940249f62745e82d356345565',
  '0xd1acd3925d895de9aec98ff95f3a30c5279d08d5','0xd218e474776403a330142299f7796e8ba32eb5c9',
  '0xd42f6a1634a3707e27cbae14ca966068e5d1047d','0xdbade4c82fb72780a0db9a38f821d8671aba9c95',
  '0xdc03d611e5bcc9f1c87edb95edeb91671471804c','0xe25b9180f5687aa85bd94ee309bb72a464320f1b',
  '0xe5c8026239919339b988fdb150a7ef4ea196d3e7','0xe639e41094bbeae18f3e6d1790c17299183f082a',
  '0xe899b5ea69afb161da7a35597b6fe70398860899','0xed2239a9150c3920000d0094d28fa51c7db03dd0',
  '0xee50a31c3f5a7c77824b12a941a54388a2827ed6','0xf743f416caa37f672e8434a9132f681a8fa0ac84',
  '0xf9e60f3fd62105dac25f15643979bd59eefb53ef','0xfeb581080aee6dc26c264a647b30a9cd44d5a393',
  '0xfffadf38a520cd5a0035ff52d7fceb436a08864b','0xfffe4013adfe325c6e02d36dc66e091f5476f52c',
  '0x90ed5bffbffbfc344aa1195572d89719a398b5bc',
]);

const cryptoPriceRe = /Up or Down|price of (Bitcoin|Ethereum|Solana|XRP|SOL|BTC|ETH|Dogecoin|DOGE) (be )?(above|below)|Bitcoin (above|below|dip|reach|hit)|Ethereum (above|below|dip|reach|hit)|Solana (above|below|dip|reach|hit)|XRP (above|below|dip|reach|hit)/i;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout')), 15000);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { clearTimeout(timeout); try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', e => { clearTimeout(timeout); reject(e); });
  });
}

const priceCache = {};
async function fetchMarketPrice(tokenId) {
  if (priceCache[tokenId] !== undefined) return priceCache[tokenId];
  try {
    const data = await httpGet(`https://clob.polymarket.com/price?token_id=${tokenId}&side=sell`);
    const p = data?.price ? parseFloat(data.price) : null;
    priceCache[tokenId] = p;
    return p;
  } catch { priceCache[tokenId] = null; return null; }
}

function initState(baseline, strat) {
  return {
    strategy: `Mega Optimal V2 (${strat.label})`,
    startDate: baseline.startDate, startTimestamp: baseline.startTimestamp,
    cash: strat.startingCapital, startingCapital: strat.startingCapital,
    positions: {}, closedPositions: [], totalRealizedPnl: 0, trades: 0, wins: 0,
    processedTrades: [], tradeLog: [],
  };
}

async function main() {
  const allTraders = JSON.parse(fs.readFileSync(TRADERS_PATH, 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const traders = allTraders.filter(t => t.address && TOP_PERFORMERS.has(t.address.toLowerCase()));

  console.log(`Replaying for ${traders.length} top performers since ${baseline.startDate}`);

  // Fetch all activity
  let allActivities = [];
  for (let i = 0; i < traders.length; i += 10) {
    const batch = traders.slice(i, i + 10);
    const results = await Promise.all(batch.map(async (trader) => {
      const addr = trader.address.toLowerCase();
      const activities = [];
      try {
        // Single call with high limit — baseline is only ~1.5 days ago
        const url = `https://data-api.polymarket.com/activity?user=${addr}&limit=500`;
        const data = await httpGet(url);
        if (!Array.isArray(data)) return activities;
        for (const a of data) {
          const ts = (a.timestamp || 0) * 1000;
          if (ts < baseline.startTimestamp) continue;
          activities.push({ ...a, _addr: addr, _username: trader.username || addr.substring(0, 10) });
        }
      } catch {}
      return activities;
    }));
    for (const acts of results) allActivities.push(...acts);
    process.stdout.write(`  Fetched ${i + batch.length}/${traders.length} (${allActivities.length} activities)\r`);
  }

  allActivities.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  console.log(`\nTotal activities: ${allActivities.length}`);

  const stA = initState(baseline, STRAT_A);
  const stB = initState(baseline, STRAT_B);

  let entriesA = 0, entriesB = 0, exitsA = 0, exitsB = 0;

  for (const a of allActivities) {
    const addr = a._addr;
    const hash = `${addr}-${a.transactionHash}`;
    if (stA.processedTrades.includes(hash)) continue;
    stA.processedTrades.push(hash);

    const tradeMs = (a.timestamp || 0) * 1000;
    const tradeDate = new Date(tradeMs).toISOString().substring(0, 10);
    if (cryptoPriceRe.test(a.title || '')) continue;

    const posKey = `${addr}-${a.conditionId}`;

    if (a.type === 'TRADE' && a.side === 'BUY') {
      const fillPrice = a.price || 0;
      let effectiveEntry = fillPrice;
      const tokenId = a.asset || a.asset_id || a.tokenId;
      // Skip price sanity during replay (only ~5% affected, not worth 1000s of API calls)
      // Live poller handles this going forward

      // Strategy A
      if (!stA.positions[posKey] && stA.cash >= STRAT_A.positionSize) {
        const cost = STRAT_A.positionSize;
        stA.cash -= cost;
        stA.positions[posKey] = {
          entryPrice: fillPrice, effectiveEntry, shares: effectiveEntry > 0 ? cost / effectiveEntry : 0,
          cost, date: tradeDate, dateMs: tradeMs, username: a._username,
          market: a.title || 'Unknown', outcome: a.outcome || '?',
          tokenId: a.asset || a.asset_id || a.tokenId || null, conditionId: a.conditionId, traderAddr: addr,
        };
        entriesA++;
      }
      // Strategy B
      if (!stB.positions[posKey] && stB.cash >= STRAT_B.positionSize) {
        const cost = STRAT_B.positionSize;
        stB.cash -= cost;
        stB.positions[posKey] = {
          entryPrice: fillPrice, effectiveEntry, shares: effectiveEntry > 0 ? cost / effectiveEntry : 0,
          cost, date: tradeDate, dateMs: tradeMs, username: a._username,
          market: a.title || 'Unknown', outcome: a.outcome || '?',
          tokenId: a.asset || a.asset_id || a.tokenId || null, conditionId: a.conditionId, traderAddr: addr,
        };
        entriesB++;
      }
    }

    if (a.type === 'REDEMPTION') {
      for (const [st, label, counter] of [[stA, 'A'], [stB, 'B']]) {
        if (st.positions[posKey]) {
          const pos = st.positions[posKey];
          const proceeds = pos.shares * 1.0;
          const pnl = proceeds - pos.cost;
          st.cash += proceeds; st.totalRealizedPnl += pnl; st.trades++;
          if (pnl > 0) st.wins++;
          st.closedPositions.push({ ...pos, exitPrice: 1.0, exitDate: tradeDate, exitType: 'redemption', pnl: +pnl.toFixed(2) });
          delete st.positions[posKey];
          if (label === 'A') exitsA++; else exitsB++;
        }
      }
    }

    if (a.type === 'TRADE' && a.side === 'SELL') {
      const exitPrice = a.price || 0;
      for (const [st, label] of [[stA, 'A'], [stB, 'B']]) {
        if (st.positions[posKey]) {
          const pos = st.positions[posKey];
          const proceeds = pos.shares * exitPrice;
          const pnl = proceeds - pos.cost;
          st.cash += proceeds; st.totalRealizedPnl += pnl; st.trades++;
          if (pnl > 0) st.wins++;
          st.closedPositions.push({ ...pos, exitPrice, exitDate: tradeDate, exitType: 'trader_sell', pnl: +pnl.toFixed(2) });
          delete st.positions[posKey];
          if (label === 'A') exitsA++; else exitsB++;
        }
      }
    }
  }

  const openA = Object.keys(stA.positions).length;
  const openB = Object.keys(stB.positions).length;

  console.log(`\n=== Strategy A (2% / $200) ===`);
  console.log(`Entries: ${entriesA} | Exits: ${exitsA} | Open: ${openA}`);
  console.log(`Cash: $${stA.cash.toFixed(2)} | P&L: $${stA.totalRealizedPnl.toFixed(2)} | ${stA.trades}t ${stA.trades > 0 ? (stA.wins/stA.trades*100).toFixed(1) : 0}% WR`);

  console.log(`\n=== Strategy B (0.65% / $65) ===`);
  console.log(`Entries: ${entriesB} | Exits: ${exitsB} | Open: ${openB}`);
  console.log(`Cash: $${stB.cash.toFixed(2)} | P&L: $${stB.totalRealizedPnl.toFixed(2)} | ${stB.trades}t ${stB.trades > 0 ? (stB.wins/stB.trades*100).toFixed(1) : 0}% WR`);

  fs.writeFileSync(STATE_A_PATH, JSON.stringify(stA, null, 2));
  fs.writeFileSync(STATE_B_PATH, JSON.stringify(stB, null, 2));
  console.log('\nBoth states saved.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
