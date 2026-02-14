#!/bin/bash
# Fetch all trades for all traders, 10 at a time in parallel
DATADIR="/Users/jadesullie/.openclaw/workspace/polymarket-tracker/data/raw-trades"
TRADERS_FILE="/Users/jadesullie/.openclaw/workspace/polymarket-tracker/data/all-traders.json"
mkdir -p "$DATADIR"

# Extract addresses
ADDRS=$(node -e "require('$TRADERS_FILE').forEach(t => console.log(t.address))")

fetch_trader() {
  local addr=$1
  local offset=0
  local all="[]"
  local count=0
  
  while true; do
    local resp=$(curl -s "https://data-api.polymarket.com/activity?user=${addr}&limit=500&offset=${offset}" 2>/dev/null)
    local len=$(echo "$resp" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).length)}catch(e){console.log(0)}})")
    
    if [ "$len" = "0" ] || [ -z "$len" ]; then
      break
    fi
    
    # Merge arrays
    all=$(node -e "
      const a=JSON.parse(process.argv[1]);
      const b=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log(JSON.stringify([...a,...b]));
    " "$all" <<< "$resp")
    
    count=$((count + len))
    offset=$((offset + 500))
    
    # Cap at 2000 trades
    if [ $offset -ge 2000 ]; then
      break
    fi
    
    if [ "$len" -lt 500 ]; then
      break
    fi
    
    sleep 0.2
  done
  
  echo "$all" > "$DATADIR/${addr}.json"
  echo "Fetched $count trades for $addr"
}

export -f fetch_trader
export DATADIR

# Process 10 at a time
echo "$ADDRS" | xargs -P 10 -I {} bash -c 'fetch_trader "$@"' _ {}

echo "DONE fetching all trades"
