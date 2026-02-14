// Vercel serverless: poll Polymarket API for wallet positions
export default async function handler(req, res) {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'address required' });

  const endpoints = [
    `https://data-api.polymarket.com/positions?user=${address}`,
    `https://gamma-api.polymarket.com/positions?user=${address}`,
  ];

  for (const url of endpoints) {
    try {
      const r = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const data = await r.json();
        return res.status(200).json({ source: url, positions: data });
      }
    } catch (_) { /* try next */ }
  }

  // Fallback: try CLOB API
  try {
    const r = await fetch(`https://clob.polymarket.com/positions?user=${address}`, {
      headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000)
    });
    if (r.ok) {
      const data = await r.json();
      return res.status(200).json({ source: 'clob', positions: data });
    }
  } catch (_) {}

  return res.status(502).json({ error: 'All Polymarket API endpoints failed' });
}
