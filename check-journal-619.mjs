import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: __dirname + '/.env' });

const sql = "SELECT date, data, notes FROM paper_journal WHERE date = '20260619' LIMIT 1";

const req = async () => {
  const res = await fetch('https://api.supabase.com/v1/projects/' + process.env.SUPABASE_PROJECT_REF + '/database/query', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.SUPABASE_MANAGEMENT_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json();
  if (Array.isArray(data) && data.length > 0) {
    console.log('PAPER JOURNAL 6/19:');
    console.log('Date:', data[0].date);
    console.log('Notes:', data[0].notes || '(none)');
    if (data[0].data) {
      console.log('\nData:', JSON.stringify(data[0].data, null, 2));
    }
  } else {
    console.log('No journal entry for 6/19 yet or error:', data.message);
  }
};
req().catch(e => console.error('Error:', e.message));
