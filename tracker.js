#!/usr/bin/env node
// Polymarket Shadow Tracker — polls wallet positions, saves snapshots, calculates P&L
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRADERS_PATH = join(__dirname, 'data', 'traders.json');
const SNAPSHOTS_DIR = join(__dirname, 'data', 'snapshots');

if (!existsSync(SNAPSHOTS_DIR)) mkdirSync(SNAPSHOTS_DIR, { recursive: true });

const traders = JSON.parse(readFileSync(TRADERS_PATH, 'utf8'));

const ENDPOINTS = [
  addr => `https://data-api.polymarket.com/positions?user=${addr}`,
  addr => `https://gamma-api.polymarket.com/positions?user=${addr}`,
  addr => `https://clob.polymarket.com/positions?user=${addr}`,
];

async function fetchPositions(address) {
  for (const mkUrl of ENDPOINTS) {
    const url = mkUrl(address);
    try {
      const r = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'PolymarketTracker/1.0' },
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) {
        const data = await r.json();
        if (data && (Array.isArray(data) ? data.length > 0 : Object.keys(data).length > 0)) {
          return { source: url, positions: data };
        }
      }
    } catch (_) { /* next */ }
  }
  return null;
}

async function run() {
  const today = new Date().toISOString().slice(0, 10);
  const prevFile = findPreviousSnapshot(today);
  const prevData = prevFile ? JSON.parse(readFileSync(prevFile, 'utf8')) : null;

  const snapshot = { date: today, timestamp: Date.now(), traders: [], alerts: [], summary: {} };
  let totalValue = 0, totalPnl = 0;
  const allPositions = [];

  console.log(`\n🔮 Polymarket Shadow Tracker — ${today}`);
  console.log(`   Tracking ${traders.length} wallets...\n`);

  for (const trader of traders) {
    process.stdout.write(`  📡 ${trader.username}... `);
    const result = await fetchPositions(trader.address);

    const traderSnap = {
      username: trader.username,
      address: trader.address,
      cluster: trader.cluster,
      insiderRisk: trader.insiderRisk,
      pnl: trader.pnl,
      activePositionsValue: trader.activePositionsValue,
      positions: trader.activePositions, // fallback to DB data
      livePositions: result ? result.positions : null,
      fetchedFrom: result ? result.source : 'database-fallback',
    };

    // Detect new trades by comparing with previous snapshot
    if (prevData) {
      const prevTrader = prevData.traders.find(t => t.address === trader.address);
      if (prevTrader && prevTrader.positions) {
        const prevMarkets = new Set(prevTrader.positions.map(p => p.market));
        const newTrades = (trader.activePositions || []).filter(p => !prevMarkets.has(p.market));
        for (const t of newTrades) {
          const alert = `${trader.username} opened ${t.side} on ${t.market} — $${(t.size || 0).toLocaleString()}`;
          snapshot.alerts.push(alert);
          console.log(`\n    🚨 NEW: ${alert}`);
        }
      }
    }

    totalValue += trader.activePositionsValue || 0;
    totalPnl += trader.pnl || 0;
    trader.activePositions?.forEach(p => allPositions.push({ ...p, trader: trader.username }));
    snapshot.traders.push(traderSnap);
    console.log(result ? `✅ (${Array.isArray(result.positions) ? result.positions.length : '?'} positions)` : '⚠️ fallback');

    // Rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  snapshot.summary = {
    totalTraders: traders.length,
    totalActiveValue: totalValue,
    totalPnl: totalPnl,
    positionsCount: allPositions.length,
    alertsCount: snapshot.alerts.length,
  };

  // Save snapshot
  const outPath = join(SNAPSHOTS_DIR, `${today}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`\n📁 Snapshot saved: ${outPath}`);

  // Summary
  console.log(`\n📊 Summary:`);
  console.log(`   Traders: ${snapshot.summary.totalTraders}`);
  console.log(`   Combined Value: $${totalValue.toLocaleString()}`);
  console.log(`   Combined P&L: $${totalPnl.toLocaleString()}`);
  console.log(`   Active Positions: ${allPositions.length}`);
  console.log(`   New Alerts: ${snapshot.alerts.length}`);

  if (snapshot.alerts.length > 0) {
    console.log(`\n🚨 Alerts for Discord:`);
    snapshot.alerts.forEach(a => console.log(`   • ${a}`));
  }
}

function findPreviousSnapshot(today) {
  try {
    const files = require('fs').readdirSync(SNAPSHOTS_DIR)
      .filter(f => f.endsWith('.json') && f.replace('.json', '') < today)
      .sort()
      .reverse();
    return files.length > 0 ? join(SNAPSHOTS_DIR, files[0]) : null;
  } catch { return null; }
}

run().catch(e => { console.error('❌ Tracker error:', e); process.exit(1); });
