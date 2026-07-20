import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: __dirname + '/.env' });

const sql = "SELECT date, notes FROM paper_journal WHERE date >= '20260618' ORDER BY date DESC LIMIT 5";

const req = async () => {
  const res = await fetch('https://api.supabase.com/v1/projects/' + process.env.SUPABASE_PROJECT_REF + '/database/query', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.SUPABASE_MANAGEMENT_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json();
  if (Array.isArray(data)) {
    console.log('PAPER JOURNAL:');
    data.forEach(row => {
      console.log('Date: ' + row.date);
      console.log('Notes: ' + (row.notes ? row.notes.substring(0, 500) : '(empty)'));
      console.log('---');
    });
  } else {
    console.log('Error:', data.message || JSON.stringify(data));
  }
};
req().catch(e => console.error('Error:', e.message));
