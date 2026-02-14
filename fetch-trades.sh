#!/bin/bash
# Fetch trade history for all tracked Polymarket wallets
DATA_DIR="/Users/jadesullie/.openclaw/workspace/polymarket-tracker/data"
mkdir -p "$DATA_DIR/raw-trades"

# Read trader addresses from the DB
TRADERS_DB="/Users/jadesullie/.openclaw/workspace/memory/polymarket-traders-db.json"

# Extract username and address pairs
cat "$TRADERS_DB" | python3 -c "
import json, sys
traders = json.load(sys.stdin)
for t in traders:
    print(f\"{t['username']}|{t['address']}|{t.get('predictions') or 0}\")
" | while IFS='|' read -r username address predictions; do
    echo "Fetching trades for $username ($address) - $predictions predictions..."
    
    # Determine max trades to fetch
    max_trades=500
    if [ "$predictions" -lt 500 ] 2>/dev/null; then
        max_trades=$((predictions + 100))  # buffer for sells/redemptions
    fi
    
    outfile="$DATA_DIR/raw-trades/${username}.json"
    all_trades="[]"
    offset=0
    
    while true; do
        echo "  Fetching offset=$offset..."
        response=$(curl -s "https://data-api.polymarket.com/activity?user=${address}&limit=100&offset=${offset}")
        
        # Check if we got results
        count=$(echo "$response" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d))" 2>/dev/null)
        
        if [ -z "$count" ] || [ "$count" = "0" ]; then
            echo "  No more results at offset=$offset"
            break
        fi
        
        echo "  Got $count trades"
        
        # Append to all_trades
        if [ "$all_trades" = "[]" ]; then
            all_trades="$response"
        else
            all_trades=$(python3 -c "
import json, sys
existing = json.loads('''$all_trades''') if len('''$all_trades''') < 100000 else []
print('TOOLARGE')
" 2>/dev/null)
            # Use file-based approach to avoid shell limits
            echo "$response" > "$DATA_DIR/raw-trades/${username}_page.json"
            python3 -c "
import json
with open('$outfile', 'r') as f:
    existing = json.load(f)
with open('$DATA_DIR/raw-trades/${username}_page.json', 'r') as f:
    new = json.load(f)
existing.extend(new)
with open('$outfile', 'w') as f:
    json.dump(existing, f)
" 2>/dev/null
        fi
        
        # First page - write directly
        if [ "$offset" = "0" ]; then
            echo "$response" > "$outfile"
        fi
        
        offset=$((offset + 100))
        
        if [ "$count" -lt 100 ]; then
            echo "  Done (last page had $count < 100)"
            break
        fi
        
        if [ "$offset" -ge "$max_trades" ]; then
            echo "  Reached max_trades limit ($max_trades)"
            break
        fi
        
        sleep 0.3
    done
    
    total=$(python3 -c "import json; print(len(json.load(open('$outfile'))))" 2>/dev/null)
    echo "  Total trades saved: $total"
    echo "---"
done

echo "All raw trades fetched!"
