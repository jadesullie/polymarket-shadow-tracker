# Polymarket Shadow Trading Index

Track the top insider-risk traders on Polymarket, simulate copy-trading strategies, and backtest bet sizing — all in a single-page dashboard.

**Live:** [polymarket-tracker-xi.vercel.app](https://polymarket-tracker-xi.vercel.app)

## What is this?

We identified **151 traders** on Polymarket who consistently trade insider-tradeable categories (politics, geopolitics, Fed policy, tech, crypto, regulatory) — not sports/esports. Each trader is profiled with win rates, Sharpe ratios, cluster analysis, and an insider-risk rating.

The **Shadow Index** simulates what would happen if you copy-traded all of them with equal-weight position sizing.

## Features

- **Dashboard** — Summary cards, sortable/filterable traders table, Shadow Index performance chart with timeframes (YTD, 3M, 6M, 1Y, ALL, Custom)
- **Trader Profiles** — Click any trader to see their full history, positions, categories, and risk rating
- **Positions** — View all tracked positions across all traders
- **Simulation Tab** — Interactive bet size simulator with:
  - Position size slider (0.01% – 10% of portfolio)
  - Fixed $ vs Dynamic % toggle (compounding)
  - Comparison chart and efficiency frontier table
  - **Day Stepper** — Step through any date range day by day, seeing every trade entry/exit, running P&L, cash vs locked capital, worst-case scenarios
- **Live Tracking** — Minute-by-minute poller detects new trades and position resolutions
- **Alerts** — Discord notifications for new entries and P&L updates

## Key findings

| Metric | Value |
|--------|-------|
| Traders tracked | 151 |
| Total positions (ALL) | 742 |
| Win rate | 63.2% |
| Best strategy | Equal Weight (beats Sharpe-weighted and Optimal across all timeframes) |
| Sweet spot bet size | 0.65% of portfolio ($65 on $10K) |
| ALL return (fixed 0.65%) | +367% ($10K → $46.7K) |
| ALL return (dynamic 0.65%) | +1,600% ($10K → $170K) |
| Max drawdown (0.65%) | 1.4% – 1.9% |

## Architecture

```
index.html          — Single-file SPA (all data inlined, no build step)
minute-poller-standalone.js — Local Node.js poller (runs every 60s via launchd)
daily-tracker.js    — Daily summary generator (agent cron, 8am SAST)
build-index.js      — Rebuilds INDEX_DATA from trade history
build-trade-history-v2.js — Extracts entry dates from raw trades
simulate-dynamic.js — Generates dynamic % sizing simulation data
simulate-capital.js — Capital allocation strategy simulator
definitive-simulation.js — Combined entry-date + capital constraint simulation
data/               — All trade data, simulation results, tracker state
data/raw-trades/    — Individual BUY/SELL/REDEMPTION events per wallet (~241MB)
```

## Setup

### 1. Clone and install

```bash
git clone https://github.com/jadesullie/polymarket-shadow-tracker.git
cd polymarket-shadow-tracker
npm install
```

### 2. View the dashboard locally

Just open `index.html` in a browser — it's a single file with all data inlined, no server needed.

```bash
open index.html
```

### 3. Set up the live poller (optional)

The minute poller watches tracked wallets for new trades:

```bash
# Test it
node minute-poller-standalone.js

# Set up as a macOS LaunchAgent for every-minute polling:
cat > ~/Library/LaunchAgents/com.polymarket.poller.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.polymarket.poller</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/polymarket-shadow-tracker/minute-poller-standalone.js</string>
    </array>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/path/to/polymarket-shadow-tracker/data/poller.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/polymarket-shadow-tracker/data/poller-error.log</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.polymarket.poller.plist
```

### 4. Rebuild simulation data (optional)

If you modify the trader list or pull new trade history:

```bash
# Rebuild trade history with entry dates
node build-trade-history-v2.js

# Rebuild index data (per-timeframe simulations)
node build-index.js

# Rebuild dynamic sizing data
node simulate-dynamic.js
```

### 5. Deploy to Vercel

```bash
npm i -g vercel
vercel --prod
```

## Data sources

- **Polymarket API** — Trade history, positions, market data
- **Polymarket Leaderboard** — Initial trader discovery (client-side rendered, requires browser scraping)

## Methodology

- **Entry-date filtering**: Simulations only include positions where the trader's first BUY happened after the window start date (simulates "started copy-trading on date X")
- **REDEMPTION-only P&L**: Only market resolutions count for P&L — SELL trades excluded (entry price unknown)
- **Capital constraint**: Tracks cash vs locked capital, skips trades when insufficient funds
- **15-min noise filtering**: Crypto up/down markets with short expiries are excluded
- **Insider risk rating**: Based on category concentration, timing patterns, and win rate in information-asymmetric markets

## License

MIT
