#!/bin/bash
# Runs minute-poller.js and sends Discord alert if new trades found
cd /Users/jadesullie/.openclaw/workspace/polymarket-tracker

OUTPUT=$(node minute-poller.js 2>/dev/null)

if [ "$OUTPUT" != "NO_NEW_TRADES" ] && [ -n "$OUTPUT" ]; then
  # Write to a file for the hourly cron to pick up
  echo "$OUTPUT" > data/pending-discord-alert.txt
fi
