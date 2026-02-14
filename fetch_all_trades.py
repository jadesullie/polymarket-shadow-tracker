#!/usr/bin/env python3
"""Fetch and aggregate trade history for all tracked Polymarket wallets."""
import json
import urllib.request
import time
import os
from collections import defaultdict

DATA_DIR = "/Users/jadesullie/.openclaw/workspace/polymarket-tracker/data"
TRADERS_DB = "/Users/jadesullie/.openclaw/workspace/memory/polymarket-traders-db.json"
RAW_DIR = os.path.join(DATA_DIR, "raw-trades")
os.makedirs(RAW_DIR, exist_ok=True)

with open(TRADERS_DB) as f:
    traders = json.load(f)

def fetch_trades(address, max_trades=500):
    """Fetch trades for a wallet, paginating."""
    all_trades = []
    offset = 0
    while offset < max_trades:
        url = f"https://data-api.polymarket.com/activity?user={address}&limit=100&offset={offset}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
        except Exception as e:
            print(f"    Error at offset {offset}: {e}")
            break
        
        if not data:
            break
        all_trades.extend(data)
        print(f"    offset={offset}, got {len(data)}")
        if len(data) < 100:
            break
        offset += 100
        time.sleep(0.3)
    return all_trades

def aggregate_trades(raw_trades):
    """Group trades by market slug and compute stats."""
    markets = defaultdict(lambda: {
        "buys": [], "sells": [], "redemptions": [],
        "title": "", "outcome": "", "slug": ""
    })
    
    for t in raw_trades:
        slug = t.get("slug", "") or t.get("conditionId", "unknown")
        outcome = t.get("outcome", "")
        side = t.get("side", "")
        ttype = t.get("type", "TRADE")
        price = float(t.get("price", 0) or 0)
        usdc = float(t.get("usdcSize", 0) or 0)
        size = float(t.get("size", 0) or 0)
        ts = t.get("timestamp", "") or t.get("createdAt", "")
        title = t.get("title", "") or t.get("question", "") or slug
        
        key = f"{slug}|{outcome}"
        m = markets[key]
        m["title"] = title or m["title"]
        m["slug"] = slug
        m["outcome"] = outcome or m["outcome"]
        
        if ttype == "REDEMPTION":
            m["redemptions"].append({"usdc": usdc, "price": price, "size": size, "ts": ts})
        elif side == "BUY":
            m["buys"].append({"usdc": usdc, "price": price, "size": size, "ts": ts})
        elif side == "SELL":
            m["sells"].append({"usdc": usdc, "price": price, "size": size, "ts": ts})
    
    results = []
    for key, m in markets.items():
        buys = m["buys"]
        sells = m["sells"]
        redemptions = m["redemptions"]
        
        total_bought = sum(b["usdc"] for b in buys)
        total_sold = sum(s["usdc"] for s in sells) + sum(r["usdc"] for r in redemptions)
        
        # Avg entry price
        total_buy_size = sum(b["size"] for b in buys)
        avg_entry = sum(b["price"] * b["size"] for b in buys) / total_buy_size if total_buy_size > 0 else 0
        
        # Avg exit price
        exits = sells + redemptions
        total_exit_size = sum(e["size"] for e in exits)
        avg_exit = sum(e["price"] * e["size"] for e in exits) / total_exit_size if total_exit_size > 0 else 0
        
        all_ts = [b["ts"] for b in buys] + [s["ts"] for s in sells] + [r["ts"] for r in redemptions]
        all_ts = [t for t in all_ts if t]
        all_ts.sort()
        
        has_redemption = len(redemptions) > 0
        has_sells = len(sells) > 0
        has_buys = len(buys) > 0
        
        # Status: closed if redeemed, or if total sold >= ~90% of bought size
        buy_size = sum(b["size"] for b in buys)
        sell_size = sum(s["size"] for s in sells)
        redeem_size = sum(r["size"] for r in redemptions)
        
        if has_redemption:
            status = "closed"
        elif sell_size >= buy_size * 0.9 and buy_size > 0:
            status = "closed"
        else:
            status = "open"
        
        pnl = total_sold - total_bought
        
        # Determine if won or lost (for closed positions)
        outcome_result = "Won" if pnl > 0 else "Lost"
        
        results.append({
            "market": m["title"],
            "slug": m["slug"],
            "outcome": m["outcome"],
            "status": status,
            "totalBought": round(total_bought, 2),
            "totalSold": round(total_sold, 2),
            "pnl": round(pnl, 2),
            "avgEntryPrice": round(avg_entry, 4),
            "avgExitPrice": round(avg_exit, 4),
            "firstTrade": all_ts[0] if all_ts else "",
            "lastTrade": all_ts[-1] if all_ts else "",
            "tradeCount": len(buys) + len(sells) + len(redemptions)
        })
    
    # Sort by absolute PnL descending
    results.sort(key=lambda x: abs(x["pnl"]), reverse=True)
    return results

# Main processing
trade_history = {}

for trader in traders:
    username = trader["username"]
    address = trader["address"]
    predictions = trader.get("predictions") or 100
    
    max_trades = min(500, predictions + 200) if predictions < 500 else 500
    
    print(f"\n{'='*60}")
    print(f"Fetching: {username} ({address[:10]}...) - ~{predictions} predictions")
    
    raw = fetch_trades(address, max_trades)
    
    # Save raw
    with open(os.path.join(RAW_DIR, f"{username}.json"), "w") as f:
        json.dump(raw, f)
    
    print(f"  Total raw trades: {len(raw)}")
    
    if not raw:
        trade_history[username] = {
            "address": address,
            "trades": [],
            "summary": {"totalTrades": 0, "closedPositions": 0, "openPositions": 0, "winRate": 0, "totalPnlClosed": 0}
        }
        continue
    
    aggregated = aggregate_trades(raw)
    
    closed = [t for t in aggregated if t["status"] == "closed"]
    opened = [t for t in aggregated if t["status"] == "open"]
    wins = [t for t in closed if t["pnl"] > 0]
    win_rate = len(wins) / len(closed) if closed else 0
    total_pnl_closed = sum(t["pnl"] for t in closed)
    
    trade_history[username] = {
        "address": address,
        "trades": aggregated,
        "summary": {
            "totalTrades": len(raw),
            "closedPositions": len(closed),
            "openPositions": len(opened),
            "winRate": round(win_rate, 4),
            "totalPnlClosed": round(total_pnl_closed, 2)
        }
    }
    
    print(f"  Markets: {len(aggregated)} ({len(closed)} closed, {len(opened)} open)")
    print(f"  Win rate: {win_rate:.1%}, Closed PnL: ${total_pnl_closed:,.0f}")

# Save trade history
output_path = os.path.join(DATA_DIR, "trade-history.json")
with open(output_path, "w") as f:
    json.dump(trade_history, f, indent=2)
print(f"\n\nSaved trade history to {output_path}")

# Update traders.json with closedPositions
traders_json_path = os.path.join(DATA_DIR, "traders.json")
if os.path.exists(traders_json_path):
    with open(traders_json_path) as f:
        traders_data = json.load(f)
else:
    traders_data = []

# Build lookup
th_lookup = {k.lower(): v for k, v in trade_history.items()}

for td in traders_data if isinstance(traders_data, list) else []:
    uname = td.get("username", "").lower() if isinstance(td, dict) else ""
    if uname in th_lookup:
        closed = [t for t in th_lookup[uname]["trades"] if t["status"] == "closed"]
        td["closedPositions"] = [{
            "market": t["market"],
            "side": t["outcome"] or "YES",
            "pnl": t["pnl"],
            "outcome": "Won" if t["pnl"] > 0 else "Lost",
            "entryPrice": t["avgEntryPrice"],
            "exitPrice": t["avgExitPrice"],
            "date": t["lastTrade"][:10] if t["lastTrade"] else ""
        } for t in closed[:20]]  # top 20 by PnL

if isinstance(traders_data, list) and traders_data:
    with open(traders_json_path, "w") as f:
        json.dump(traders_data, f, indent=2)
    print(f"Updated {traders_json_path}")

# Generate closedPositions JS snippet for index.html
print("\n\n=== CLOSED POSITIONS DATA FOR INDEX.HTML ===")
for username, data in trade_history.items():
    closed = [t for t in data["trades"] if t["status"] == "closed"]
    if closed:
        positions = [{
            "market": t["market"][:60],
            "side": t["outcome"] or "YES",
            "pnl": round(t["pnl"]),
            "outcome": "Won" if t["pnl"] > 0 else "Lost",
            "entryPrice": t["avgEntryPrice"],
            "exitPrice": t["avgExitPrice"],
            "date": t["lastTrade"][:10] if t["lastTrade"] else ""
        } for t in closed[:10]]
        print(f"\n// {username}: {len(closed)} closed positions, showing top 10")
        print(f"// {username}_CLOSED = {json.dumps(positions)}")

print("\n\nDone!")
