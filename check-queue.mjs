import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: `${__dirname}/.env` });

const sql = `SELECT data FROM paper_state WHERE k = 'live_queue'`;

const req = async () => {
  const res = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json();
  if (Array.isArray(data) && data[0]) {
    const queue = typeof data[0].data === 'string' ? JSON.parse(data[0].data) : data[0].data;
    console.log('LIVE QUEUE (6/19 00:27):');
    console.log(JSON.stringify(queue, null, 2));
  }
};
req().catch(e => console.error('Error:', e.message));
