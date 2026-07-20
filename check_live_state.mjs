import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { 
      Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(data?.message ?? 'Query failed');
  return data;
}

(async () => {
  try {
    console.log('=== Checking live_queue and live_meta ===');
    const result = await query(`SELECT k, data FROM paper_state WHERE k IN ('live_queue', 'live_meta')`);
    result.forEach(row => {
      console.log(`\n${row.k}:`);
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      console.log(JSON.stringify(data, null, 2));
    });
    
    console.log('\n=== Holdings check (accounts & holdings) ===');
    // Check actual holdings
    const acctResult = await query(`SELECT data FROM paper_state WHERE k = 'accounts_live'`);
    if (acctResult.length > 0) {
      const acct = typeof acctResult[0].data === 'string' ? JSON.parse(acctResult[0].data) : acctResult[0].data;
      console.log('accounts_live:', JSON.stringify(acct, null, 2));
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
})();
