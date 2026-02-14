// Vercel serverless: serve historical snapshot data
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

export default function handler(req, res) {
  const snapshotsDir = join(process.cwd(), 'data', 'snapshots');
  if (!existsSync(snapshotsDir)) return res.status(200).json({ snapshots: [] });

  try {
    const files = readdirSync(snapshotsDir).filter(f => f.endsWith('.json')).sort();
    const snapshots = files.map(f => {
      const data = JSON.parse(readFileSync(join(snapshotsDir, f), 'utf8'));
      return { date: f.replace('.json', ''), ...data };
    });
    return res.status(200).json({ snapshots });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
