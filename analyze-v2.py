#!/usr/bin/env python3
"""
Polymarket Shadow Index - Per-Timeframe Reanalysis
New methodology: only positions where exit date >= window start
(exit date used as proxy since entry dates aren't in the data)
"""
import json, re, time, math, sys
from datetime import datetime, timedelta
from collections import defaultdict

# ── Load data ──
with open('data/trade-history-full.json') as f:
    trade_history = json.load(f)

with open('index.html') as f:
    html = f.read()

match = re.search(r'const TRADERS = (\[.*?\]);\s*\n', html, re.DOTALL)
TRADERS = json.loads(match.group(1))
trader_by_addr = {t['address'].lower(): t for t in TRADERS}

# ── Filters ──
noise_re = re.compile(r'Up or Down.*\d+:\d+(AM|PM)', re.I)

# ── Collect positions ──
all_positions = []
for addr, positions in trade_history.items():
    trader = trader_by_addr.get(addr.lower())
    for p in positions:
        if noise_re.search(p['market']):
            continue
        exit_ts = int(p['date'])
        exit_date = datetime.utcfromtimestamp(exit_ts)
        ret = (p['exitPrice'] - p['entryPrice']) / p['entryPrice'] if p['entryPrice'] > 0 else 0
        all_positions.append({
            **p,
            'address': addr.lower(),
            'exit_ts': exit_ts,
            'exit_date': exit_date,
            'exit_date_str': exit_date.strftime('%Y-%m-%d'),
            'return': ret,
            'insiderRisk': trader['insiderRisk'] if trader else 'LOW',
            'cluster': trader['cluster'] if trader else 'other',
            'username': trader['username'] if trader else addr[:10],
        })

all_positions.sort(key=lambda p: p['exit_ts'])
print(f"Total positions after noise filter: {len(all_positions)}")

# ── Timeframes ──
NOW = datetime(2026, 2, 14)
timeframes = {
    '3M': NOW - timedelta(days=90),
    '6M': NOW - timedelta(days=180),
    '1Y': NOW - timedelta(days=365),
    'YTD': datetime(2026, 1, 1),
    'ALL': datetime(2020, 1, 1),
}

# ── Per-trader, per-timeframe stats ──
def calc_stats(returns, pnls):
    if not returns:
        return {'trades': 0, 'winRate': 0, 'avgReturn': 0, 'volatility': 0, 'sharpe': 0, 'totalPnl': 0}
    n = len(returns)
    wins = sum(1 for r in returns if r > 0)
    mean = sum(returns) / n
    if n > 1:
        var = sum((r - mean)**2 for r in returns) / n
        std = math.sqrt(var)
    else:
        std = 0
    sharpe = mean / std if std > 0 else (1.0 if mean > 0 else 0)
    return {
        'trades': n,
        'winRate': round(wins / n * 100, 1),
        'avgReturn': round(mean * 100, 2),
        'volatility': round(std * 100, 2),
        'sharpe': round(sharpe, 3),
        'totalPnl': round(sum(pnls), 2),
    }

# Build per-trader per-timeframe data
trader_stats = {}  # {addr: {tf: stats}}
for addr in set(p['address'] for p in all_positions):
    trader_positions = [p for p in all_positions if p['address'] == addr]
    trader_stats[addr] = {}
    for tf, start in timeframes.items():
        tf_pos = [p for p in trader_positions if p['exit_date'] >= start]
        returns = [p['return'] for p in tf_pos]
        pnls = [p['pnl'] for p in tf_pos]
        trader_stats[addr][tf] = calc_stats(returns, pnls)

# ── Strategy simulation ──
STARTING_CAPITAL = 10000
BASE_POSITION = 1000

ACTIVE_CLUSTERS = {'iran', 'fed', 'geopolitics', 'politics', 'crypto', 'tech', 'sports', 'ufc', 'mma'}
PLAYED_OUT = {'election-2024', 'election'}

def cluster_boost(cluster):
    if not cluster: return 1
    c = cluster.lower()
    if c in PLAYED_OUT: return 0.3
    if c in ACTIVE_CLUSTERS: return 1.5
    return 1

def insider_mult(risk):
    return {'HIGH': 2, 'EXTREME': 2.5, 'MEDIUM': 1, 'LOW': 0.5}.get(risk, 0.5)

strategy_results = {}

for tf, start in timeframes.items():
    tf_positions = [p for p in all_positions if p['exit_date'] >= start]
    if not tf_positions:
        strategy_results[tf] = {'equal': 0, 'sharpe': 0, 'optimal': 0, 'trades': 0, 'winRate': 0}
        continue
    
    # Compute NEW per-timeframe Sharpe for each trader
    tf_sharpe = {}
    for addr in set(p['address'] for p in tf_positions):
        s = trader_stats[addr].get(tf, {})
        tf_sharpe[addr] = max(0.1, s.get('sharpe', 0)) if s.get('sharpe', 0) > 0 else 0.1

    eq_cap = STARTING_CAPITAL
    sh_cap = STARTING_CAPITAL
    opt_cap = STARTING_CAPITAL
    wins = 0
    
    for p in tf_positions:
        ret = p['return']
        if p['pnl'] > 0: wins += 1
        
        # Equal weight
        eq_cap += BASE_POSITION * ret
        
        # Sharpe weighted (NEW per-tf sharpe)
        sw = min(tf_sharpe.get(p['address'], 1), 3)
        sh_cap += BASE_POSITION * sw * ret
        
        # Optimal
        ow = sw * insider_mult(p['insiderRisk']) * cluster_boost(p['cluster'])
        opt_size = min(BASE_POSITION * ow, opt_cap * 0.1)
        opt_cap += opt_size * ret
    
    n = len(tf_positions)
    strategy_results[tf] = {
        'equal': round((eq_cap / STARTING_CAPITAL - 1) * 100, 1),
        'sharpe': round((sh_cap / STARTING_CAPITAL - 1) * 100, 1),
        'optimal': round((opt_cap / STARTING_CAPITAL - 1) * 100, 1),
        'trades': n,
        'winRate': round(wins / n * 100, 1),
    }
    print(f"{tf}: {n} trades, EQ={strategy_results[tf]['equal']}%, SH={strategy_results[tf]['sharpe']}%, OPT={strategy_results[tf]['optimal']}%")

# ── Top/Bottom traders by Sharpe ──
def get_ranked(tf, n=20):
    items = []
    for addr, stats in trader_stats.items():
        s = stats.get(tf, {})
        if s.get('trades', 0) < 3: continue  # minimum trades
        trader = trader_by_addr.get(addr, {})
        items.append({
            'username': trader.get('username', addr[:10]),
            'address': addr,
            'sharpe': s['sharpe'],
            'trades': s['trades'],
            'winRate': s['winRate'],
            'avgReturn': s['avgReturn'],
            'totalPnl': s['totalPnl'],
            'insiderRisk': trader.get('insiderRisk', 'LOW'),
            'cluster': trader.get('cluster', 'other'),
        })
    items.sort(key=lambda x: x['sharpe'], reverse=True)
    return items[:n], items[-n:] if len(items) >= n else (items, [])

# ── Generate trader weights v2 ──
weights = {}
for addr in set(p['address'] for p in all_positions):
    trader = trader_by_addr.get(addr, {})
    s3m = trader_stats[addr].get('3M', {}).get('sharpe', 0)
    s6m = trader_stats[addr].get('6M', {}).get('sharpe', 0)
    s1y = trader_stats[addr].get('1Y', {}).get('sharpe', 0)
    
    # Recommended weight: 50% 3M + 30% 6M + 20% 1Y (recency bias)
    blended = 0.5 * s3m + 0.3 * s6m + 0.2 * s1y
    
    # Tier based on blended sharpe
    if blended >= 1.5: tier = 'S'
    elif blended >= 1.0: tier = 'A'
    elif blended >= 0.5: tier = 'B'
    elif blended >= 0.0: tier = 'C'
    else: tier = 'D'
    
    rec_weight = round(max(0.1, min(3.0, blended)) * insider_mult(trader.get('insiderRisk', 'LOW')) * cluster_boost(trader.get('cluster', 'other')), 3)
    
    weights[addr] = {
        'username': trader.get('username', addr[:10]),
        'sharpe3m': round(s3m, 3),
        'sharpe6m': round(s6m, 3),
        'sharpe1y': round(s1y, 3),
        'recommendedWeight': rec_weight,
        'tier': tier,
    }

with open('data/trader-weights-v2.json', 'w') as f:
    json.dump(weights, f, indent=2)
print(f"\nWrote trader-weights-v2.json with {len(weights)} traders")

# ── Comparison: old vs new methodology ──
# Old = ALL-time sharpe used for all windows. New = per-window sharpe
# Let's also sim with recency-biased weights
for tf, start in timeframes.items():
    tf_positions = [p for p in all_positions if p['exit_date'] >= start]
    if not tf_positions: continue
    
    # Recency-biased optimal
    rb_cap = STARTING_CAPITAL
    for p in tf_positions:
        ret = p['return']
        addr = p['address']
        w = weights.get(addr, {}).get('recommendedWeight', 1)
        rb_size = min(BASE_POSITION * w, rb_cap * 0.1)
        rb_cap += rb_size * ret
    
    strategy_results[tf]['recencyOptimal'] = round((rb_cap / STARTING_CAPITAL - 1) * 100, 1)
    print(f"{tf} Recency-Optimal: {strategy_results[tf]['recencyOptimal']}%")

# ── Divergence analysis: traders good historically but bad recently ──
divergence = []
for addr in set(p['address'] for p in all_positions):
    all_s = trader_stats[addr].get('ALL', {}).get('sharpe', 0)
    m3_s = trader_stats[addr].get('3M', {}).get('sharpe', 0)
    if trader_stats[addr].get('ALL', {}).get('trades', 0) >= 5:
        trader = trader_by_addr.get(addr, {})
        divergence.append({
            'username': trader.get('username', addr[:10]),
            'allTimeSharpe': all_s,
            'sharpe3m': m3_s,
            'delta': round(m3_s - all_s, 3),
            'trades3m': trader_stats[addr].get('3M', {}).get('trades', 0),
        })
divergence.sort(key=lambda x: x['delta'])

# ── Write markdown report ──
top3m, bot3m = get_ranked('3M')
top6m, bot6m = get_ranked('6M')

report = f"""# Polymarket Shadow Index - Strategy Reanalysis (New Per-Timeframe Methodology)
**Date:** 2026-02-14  
**Positions analyzed:** {len(all_positions)} (after noise filter)  
**Traders with closed positions:** {len(set(p['address'] for p in all_positions))}

## Executive Summary

The new per-timeframe methodology recalculates Sharpe ratios using only positions that closed within each window, simulating "if you started copy-trading on date X." Key findings:

| Timeframe | Equal Weight | Sharpe-Weighted | Optimal | Recency-Optimal | Trades | Win Rate |
|-----------|-------------|-----------------|---------|-----------------|--------|----------|
"""

for tf in ['3M', '6M', '1Y', 'YTD', 'ALL']:
    s = strategy_results.get(tf, {})
    report += f"| {tf} | {s.get('equal',0)}% | {s.get('sharpe',0)}% | {s.get('optimal',0)}% | {s.get('recencyOptimal',0)}% | {s.get('trades',0)} | {s.get('winRate',0)}% |\n"

# Determine best strategy
best_3m = max(['equal','sharpe','optimal','recencyOptimal'], key=lambda k: strategy_results.get('3M',{}).get(k,0))
best_6m = max(['equal','sharpe','optimal','recencyOptimal'], key=lambda k: strategy_results.get('6M',{}).get(k,0))

report += f"""
### Key Insights
- **Best 3M strategy:** {best_3m} ({strategy_results.get('3M',{}).get(best_3m,0)}%)
- **Best 6M strategy:** {best_6m} ({strategy_results.get('6M',{}).get(best_6m,0)}%)
- The recency-optimal strategy (50% 3M + 30% 6M + 20% 1Y weighted Sharpe × insider × cluster) {"outperforms" if strategy_results.get('3M',{}).get('recencyOptimal',0) > strategy_results.get('3M',{}).get('optimal',0) else "underperforms vs"} the original optimal in the 3M window.

## Top 20 Traders by Sharpe (3M Window)

| # | Username | Sharpe | Trades | Win Rate | Avg Return | P&L | Insider | Cluster |
|---|----------|--------|--------|----------|------------|-----|---------|---------|
"""
for i, t in enumerate(top3m):
    report += f"| {i+1} | {t['username']} | {t['sharpe']} | {t['trades']} | {t['winRate']}% | {t['avgReturn']}% | ${t['totalPnl']:,.0f} | {t['insiderRisk']} | {t['cluster']} |\n"

report += f"""
## Top 20 Traders by Sharpe (6M Window)

| # | Username | Sharpe | Trades | Win Rate | Avg Return | P&L | Insider | Cluster |
|---|----------|--------|--------|----------|------------|-----|---------|---------|
"""
for i, t in enumerate(top6m):
    report += f"| {i+1} | {t['username']} | {t['sharpe']} | {t['trades']} | {t['winRate']}% | {t['avgReturn']}% | ${t['totalPnl']:,.0f} | {t['insiderRisk']} | {t['cluster']} |\n"

report += f"""
## Bottom 20 Traders (3M Window)

| # | Username | Sharpe | Trades | Win Rate | Avg Return | P&L |
|---|----------|--------|--------|----------|------------|-----|
"""
for i, t in enumerate(reversed(bot3m)):
    report += f"| {i+1} | {t['username']} | {t['sharpe']} | {t['trades']} | {t['winRate']}% | {t['avgReturn']}% | ${t['totalPnl']:,.0f} |\n"

report += f"""
## Divergence Analysis: Historical vs Recent Performance

Traders with biggest DROP in Sharpe (good historically, poor recently):

| Username | All-Time Sharpe | 3M Sharpe | Delta | 3M Trades |
|----------|----------------|-----------|-------|-----------|
"""
for t in divergence[:10]:
    report += f"| {t['username']} | {t['allTimeSharpe']} | {t['sharpe3m']} | {t['delta']} | {t['trades3m']} |\n"

report += f"""
Traders with biggest IMPROVEMENT (poor historically, good recently):

| Username | All-Time Sharpe | 3M Sharpe | Delta | 3M Trades |
|----------|----------------|-----------|-------|-----------|
"""
for t in divergence[-10:]:
    report += f"| {t['username']} | {t['allTimeSharpe']} | {t['sharpe3m']} | {t['delta']} | {t['trades3m']} |\n"

report += f"""
## Recommended Strategy Changes

### 1. Add Recency Bias to Weights
Instead of using all-time Sharpe, use a blended score: **50% × 3M Sharpe + 30% × 6M Sharpe + 20% × 1Y Sharpe**.
This captures recent performance while still valuing consistency.

### 2. Updated Optimal Formula
```
weight = blendedSharpe × insiderMult × clusterBoost
blendedSharpe = 0.5 × sharpe3m + 0.3 × sharpe6m + 0.2 × sharpe1y
positionSize = min(BASE × weight, capital × 0.10)
```

### 3. Tier System
- **S tier** (blended ≥ 1.5): Maximum conviction, full weight
- **A tier** (1.0-1.5): Strong, standard weight  
- **B tier** (0.5-1.0): Moderate, reduced weight
- **C tier** (0.0-0.5): Marginal, minimal exposure
- **D tier** (< 0): Negative edge, exclude or fade

### 4. Tier Distribution
"""

tier_counts = defaultdict(int)
for w in weights.values():
    tier_counts[w['tier']] += 1
for tier in 'SABCD':
    report += f"- **{tier}**: {tier_counts[tier]} traders\n"

report += f"""
### 5. Insider Risk Multipliers (unchanged)
- EXTREME: 2.5× | HIGH: 2× | MEDIUM: 1× | LOW: 0.5×

### 6. Cluster Boosts
Active clusters (1.5×): {', '.join(sorted(ACTIVE_CLUSTERS))}
Played-out (0.3×): {', '.join(sorted(PLAYED_OUT))}
"""

with open('/Users/jadesullie/.openclaw/workspace/memory/polymarket-strategy-reanalysis.md', 'w') as f:
    f.write(report)
print(f"\nWrote reanalysis report")

# Print summary
print("\n=== STRATEGY COMPARISON ===")
for tf in ['3M', '6M', '1Y', 'YTD', 'ALL']:
    s = strategy_results.get(tf, {})
    print(f"{tf}: EQ={s.get('equal',0)}% | SH={s.get('sharpe',0)}% | OPT={s.get('optimal',0)}% | REC-OPT={s.get('recencyOptimal',0)}% | {s.get('trades',0)} trades")
