#!/usr/bin/env python3
"""Aggregate already-fetched raw trades and update index.html."""
import json, os, re
from collections import defaultdict
from datetime import datetime

DATA_DIR = "/Users/jadesullie/.openclaw/workspace/polymarket-tracker/data"
RAW_DIR = os.path.join(DATA_DIR, "raw-trades")
TRADERS_DB = "/Users/jadesullie/.openclaw/workspace/memory/polymarket-traders-db.json"

with open(TRADERS_DB) as f:
    traders = json.load(f)

def ts_to_iso(ts):
    if not ts: return ""
    if isinstance(ts, (int, float)):
        return datetime.utcfromtimestamp(ts).strftime("%Y-%m-%dT%H:%M:%SZ")
    return str(ts)

def ts_to_date(ts):
    if not ts: return ""
    if isinstance(ts, (int, float)):
        return datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d")
    return str(ts)[:10]

def aggregate_trades(raw_trades):
    markets = defaultdict(lambda: {"buys": [], "sells": [], "redemptions": [], "title": "", "outcome": "", "slug": ""})
    
    for t in raw_trades:
        slug = t.get("slug", "") or "unknown"
        outcome = t.get("outcome", "")
        side = t.get("side", "")
        ttype = t.get("type", "TRADE")
        price = float(t.get("price", 0) or 0)
        usdc = float(t.get("usdcSize", 0) or 0)
        size = float(t.get("size", 0) or 0)
        ts = t.get("timestamp", 0)
        title = t.get("title", "") or slug
        
        key = f"{slug}|{outcome}"
        m = markets[key]
        m["title"] = title or m["title"]
        m["slug"] = slug
        m["outcome"] = outcome or m["outcome"]
        
        entry = {"usdc": usdc, "price": price, "size": size, "ts": ts}
        if ttype == "REDEMPTION":
            m["redemptions"].append(entry)
        elif side == "BUY":
            m["buys"].append(entry)
        elif side == "SELL":
            m["sells"].append(entry)
    
    results = []
    for key, m in markets.items():
        buys, sells, redemptions = m["buys"], m["sells"], m["redemptions"]
        
        total_bought = sum(b["usdc"] for b in buys)
        total_sold = sum(s["usdc"] for s in sells) + sum(r["usdc"] for r in redemptions)
        
        total_buy_size = sum(b["size"] for b in buys)
        avg_entry = sum(b["price"] * b["size"] for b in buys) / total_buy_size if total_buy_size > 0 else 0
        
        exits = sells + redemptions
        total_exit_size = sum(e["size"] for e in exits)
        avg_exit = sum(e["price"] * e["size"] for e in exits) / total_exit_size if total_exit_size > 0 else 0
        
        all_ts = [x["ts"] for x in buys + sells + redemptions if x["ts"]]
        all_ts.sort()
        
        buy_size = sum(b["size"] for b in buys)
        sell_size = sum(s["size"] for s in sells)
        
        if redemptions:
            status = "closed"
        elif sell_size >= buy_size * 0.9 and buy_size > 0:
            status = "closed"
        else:
            status = "open"
        
        pnl = total_sold - total_bought
        
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
            "firstTrade": ts_to_iso(all_ts[0]) if all_ts else "",
            "lastTrade": ts_to_iso(all_ts[-1]) if all_ts else "",
            "tradeCount": len(buys) + len(sells) + len(redemptions)
        })
    
    results.sort(key=lambda x: abs(x["pnl"]), reverse=True)
    return results

# Process all traders
trade_history = {}

for trader in traders:
    username = trader["username"]
    address = trader["address"]
    raw_file = os.path.join(RAW_DIR, f"{username}.json")
    
    if not os.path.exists(raw_file):
        print(f"No raw data for {username}")
        trade_history[username] = {"address": address, "trades": [], "summary": {"totalTrades": 0, "closedPositions": 0, "openPositions": 0, "winRate": 0, "totalPnlClosed": 0}}
        continue
    
    with open(raw_file) as f:
        raw = json.load(f)
    
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
    print(f"{username}: {len(closed)} closed, {len(opened)} open, WR={win_rate:.0%}, PnL=${total_pnl_closed:,.0f}")

# Save trade history
with open(os.path.join(DATA_DIR, "trade-history.json"), "w") as f:
    json.dump(trade_history, f, indent=2)

# Update traders.json
traders_json_path = os.path.join(DATA_DIR, "traders.json")
if os.path.exists(traders_json_path):
    with open(traders_json_path) as f:
        traders_data = json.load(f)
    
    for td in (traders_data if isinstance(traders_data, list) else []):
        if not isinstance(td, dict):
            continue
        uname = td.get("username", "")
        if uname in trade_history:
            closed = [t for t in trade_history[uname]["trades"] if t["status"] == "closed"]
            td["closedPositions"] = [{
                "market": t["market"],
                "side": t["outcome"] or "YES",
                "pnl": round(t["pnl"]),
                "outcome": "Won" if t["pnl"] > 0 else "Lost",
                "entryPrice": t["avgEntryPrice"],
                "exitPrice": t["avgExitPrice"],
                "date": ts_to_date(t["lastTrade"])
            } for t in closed[:20]]
    
    with open(traders_json_path, "w") as f:
        json.dump(traders_data, f, indent=2)
    print(f"\nUpdated {traders_json_path}")

# Now update index.html
index_path = "/Users/jadesullie/.openclaw/workspace/polymarket-tracker/index.html"
with open(index_path, "r") as f:
    html = f.read()

# Build closedPositions data per trader for JS injection
def build_closed_js(username):
    if username not in trade_history:
        return "[]"
    closed = [t for t in trade_history[username]["trades"] if t["status"] == "closed"]
    positions = [{
        "market": t["market"][:80],
        "side": t["outcome"] or "YES",
        "pnl": round(t["pnl"]),
        "outcome": "Won" if t["pnl"] > 0 else "Lost",
        "entryPrice": t["avgEntryPrice"],
        "exitPrice": t["avgExitPrice"],
        "date": ts_to_date(t["lastTrade"])
    } for t in closed[:15]]
    return json.dumps(positions)

# Find the TRADERS array in the HTML and update closedPositions
# Strategy: find each trader object by username and replace its closedPositions

for username, data in trade_history.items():
    closed = [t for t in data["trades"] if t["status"] == "closed"]
    if not closed:
        continue
    
    positions_js = build_closed_js(username)
    
    # Find pattern: username: "XXX", ... closedPositions: [...]
    # Use regex to find the closedPositions array for this trader
    # Look for the username in the JS, then find the next closedPositions
    pattern = rf'(username:\s*["\']' + re.escape(username) + r'["\'].*?closedPositions:\s*)\[.*?\]'
    
    match = re.search(pattern, html, re.DOTALL)
    if match:
        html = html[:match.start(1)] + match.group(1) + positions_js + html[match.end():]
        print(f"Updated closedPositions for {username} ({len(closed)} positions)")
    else:
        print(f"Could not find closedPositions pattern for {username}")

with open(index_path, "w") as f:
    f.write(html)

print(f"\nUpdated {index_path}")
print("Done!")
