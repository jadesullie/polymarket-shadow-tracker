// Vercel serverless: serve price history lookups
// GET /api/prices?tokens=tok1,tok2&from=2025-01-01&to=2025-03-01
// Returns { tokenId: { date: price, ... }, ... }
import { readFileSync } from 'fs';
import { join } from 'path';

let _cache = null;
function getPriceHistory() {
  if (_cache) return _cache;
  _cache = JSON.parse(readFileSync(join(process.cwd(), 'data', 'price-history.json'), 'utf8'));
  return _cache;
}

export default function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  try {
    const { tokens, from, to } = req.query;
    if (!tokens) return res.status(400).json({ error: 'tokens param required' });

    const tokenList = tokens.split(',').slice(0, 200); // limit to 200 tokens per request
    const prices = getPriceHistory();
    const result = {};

    for (const tok of tokenList) {
      const data = prices[tok];
      if (!data) continue;
      if (from || to) {
        const filtered = {};
        for (const [date, price] of Object.entries(data)) {
          if (from && date < from) continue;
          if (to && date > to) continue;
          filtered[date] = price;
        }
        result[tok] = filtered;
      } else {
        result[tok] = data;
      }
    }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
