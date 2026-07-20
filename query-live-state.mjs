import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: `${__dirname}/.env` });

const sql = `SELECT k, updated_at FROM paper_state WHERE k IN ('live_queue', 'live_meta') ORDER BY updated_at DESC LIMIT 5`;

const req = async () => {
  const res = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
};
req().catch(e => console.error('Error:', e.message));
