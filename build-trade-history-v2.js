#!/usr/bin/env node
// Augments trade-history-full.json with entry dates from raw-trades
const fs = require('fs');
const path = require('path');

const rawDir = path.join(__dirname, 'data/raw-trades');
const files = fs.readdirSync(rawDir).filter(f => f.endsWith('.json'));
const oldData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/trade-history-full.json'), 'utf8'));

// Build a map: wallet → slug → first BUY timestamp
const entryDates = {}; // wallet → slug → earliest BUY timestamp
for (const file of files) {
  const activities = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8'));
  const wallet = activities[0]?.proxyWallet?.toLowerCase();
  if (!wallet) continue;
  
  entryDates[wallet] = {};
  for (const a of activities) {
    if (a.type !== 'TRADE' || a.side !== 'BUY') continue;
    if (!a.slug) continue;
    const key = a.slug;
    if (!entryDates[wallet][key] || a.timestamp < entryDates[wallet][key]) {
      entryDates[wallet][key] = a.timestamp;
    }
  }
}

// Augment old data with entry dates
const result = {};
let matched = 0, unmatched = 0;

for (const [addr, positions] of Object.entries(oldData)) {
  if (!positions || positions.length === 0) continue;
  const walletEntries = entryDates[addr.toLowerCase()] || {};
  
  result[addr] = positions.map(p => {
    const entryDate = walletEntries[p.slug];
    if (entryDate) {
      matched++;
      return { ...p, entryDate };
    } else {
      unmatched++;
      // Fallback: estimate entry as exitDate - 30 days
      const exitTs = Number(p.date);
      return { ...p, entryDate: exitTs - 30 * 86400 };
    }
  });
}

console.log(`Matched entry dates: ${matched}, unmatched (estimated): ${unmatched}`);

const totalPositions = Object.values(result).reduce((s, p) => s + p.length, 0);
console.log(`Total positions: ${totalPositions}`);

fs.writeFileSync(path.join(__dirname, 'data/trade-history-v2.json'), JSON.stringify(result, null, 2));
console.log('Written to data/trade-history-v2.json');
