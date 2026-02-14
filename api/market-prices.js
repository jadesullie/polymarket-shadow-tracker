// Vercel serverless: batch price lookup by market+side+date
// POST /api/market-prices with body: { positions: [{market, side}], date: "2025-01-01" }
// Returns: { "market|side": price, ... }
import { readFileSync } from 'fs';
import { join } from 'path';

let _priceCache = null;
let _tokenMap = null;

function load() {
  if (!_priceCache) _priceCache = JSON.parse(readFileSync(join(process.cwd(), 'data', 'price-history.json'), 'utf8'));
  if (!_tokenMap) _tokenMap = JSON.parse(readFileSync(join(process.cwd(), 'data', 'market-side-to-token.json'), 'utf8'));
}

export default function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  try {
    load();

    if (req.method === 'POST') {
      const { positions, date } = req.body;
      if (!positions || !date) return res.status(400).json({ error: 'positions and date required' });

      const result = {};
      for (const p of positions.slice(0, 500)) {
        const key = p.market + '|' + p.side;
        const tokenId = _tokenMap[key];
        if (tokenId && _priceCache[tokenId] && _priceCache[tokenId][date] != null) {
          result[key] = _priceCache[tokenId][date];
        }
      }
      return res.status(200).json(result);
    }

    // GET mode: ?positions=market1|side1,market2|side2&date=2025-01-01
    const { positions: posStr, date } = req.query;
    if (!posStr || !date) return res.status(400).json({ error: 'positions and date params required' });

    const posList = posStr.split(',').slice(0, 200);
    const result = {};
    for (const p of posList) {
      const tokenId = _tokenMap[p];
      if (tokenId && _priceCache[tokenId] && _priceCache[tokenId][date] != null) {
        result[p] = _priceCache[tokenId][date];
      }
    }
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
