#!/usr/bin/env python3
"""Update index.html TRADERS array closedPositions with real API data."""
import json, re, os
from datetime import datetime

DATA_DIR = "/Users/jadesullie/.openclaw/workspace/polymarket-tracker/data"
INDEX_PATH = "/Users/jadesullie/.openclaw/workspace/polymarket-tracker/index.html"

with open(os.path.join(DATA_DIR, "trade-history.json")) as f:
    trade_history = json.load(f)

with open(INDEX_PATH) as f:
    html = f.read()

# Extract the TRADERS array from HTML
match = re.search(r'const TRADERS = (\[.*?\]);\s*\n', html, re.DOTALL)
if not match:
    print("Could not find TRADERS array!")
    exit(1)

traders_js = match.group(1)
traders_data = json.loads(traders_js)

def ts_to_date(ts):
    if not ts: return ""
    if isinstance(ts, (int, float)):
        return datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d")
    return str(ts)[:10]

# Update each trader's closedPositions
for td in traders_data:
    username = td.get("username", "")
    if username in trade_history:
        closed = [t for t in trade_history[username]["trades"] if t["status"] == "closed"]
        if closed:
            td["closedPositions"] = [{
                "market": t["market"][:80],
                "side": t["outcome"] or "YES",
                "pnl": round(t["pnl"]),
                "outcome": "Won" if t["pnl"] > 0 else "Lost",
                "entryPrice": t["avgEntryPrice"],
                "exitPrice": t["avgExitPrice"],
                "date": t["lastTrade"][:10] if t["lastTrade"] else ""
            } for t in closed[:15]]
            print(f"{username}: {len(td['closedPositions'])} closed positions")
        else:
            td["closedPositions"] = []
            print(f"{username}: no closed positions")

# Rebuild the JS
new_js = json.dumps(traders_data, indent=4)
new_html = html[:match.start(1)] + new_js + html[match.end(1):]

with open(INDEX_PATH, "w") as f:
    f.write(new_html)

print(f"\nUpdated {INDEX_PATH}")
