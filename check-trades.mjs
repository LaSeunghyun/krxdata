import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: __dirname + '/.env' });

const sql = "SELECT ts AT TIME ZONE 'Asia/Seoul' as kst_time, strat, type, code, name, qty, price, reason FROM paper_trades WHERE DATE(ts AT TIME ZONE 'Asia/Seoul') >= '2026-06-18' ORDER BY ts DESC LIMIT 30";

const req = async () => {
  const res = await fetch('https://api.supabase.com/v1/projects/' + process.env.SUPABASE_PROJECT_REF + '/database/query', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.SUPABASE_MANAGEMENT_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json();
  if (Array.isArray(data)) {
    console.log('PAPER TRADES (6/18 이후):');
    data.forEach(row => {
      console.log('[' + row.kst_time + '] ' + row.strat + ' ' + row.type + ' ' + row.code + ' ' + row.name + ' qty=' + row.qty + ' @' + row.price + ' (' + row.reason + ')');
    });
  } else {
    console.log('Error:', data.message);
  }
};
req().catch(e => console.error('Error:', e.message));
