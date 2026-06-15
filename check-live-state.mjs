// 읽기 전용: 현재 라이브 상태(halt/queue/meta/baseline) + 토스 계좌 점검
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const dbQuery = async (sql) => {
  const res = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
};

const rows = await dbQuery(`SELECT k, data, updated_at FROM paper_state WHERE k IN ('live_halt','live_queue','live_meta','baseline') ORDER BY k`);
console.log('=== paper_state ===');
for (const r of rows) console.log(`[${r.k}] (updated ${r.updated_at})\n`, JSON.stringify(r.data, null, 2));
if (!rows.find(r => r.k === 'live_halt')) console.log('live_halt: (없음 = 정상, 집행 가능)');
if (!rows.find(r => r.k === 'live_queue')) console.log('live_queue: (없음 = 빈 큐)');

// 토스 계좌/현금/보유 (읽기 전용)
try {
  const { getAccounts, getBuyingPower, isTossConfigured } = await import('./toss-api.js');
  console.log('\n=== 토스 ===\nconfigured:', isTossConfigured());
  const accts = await getAccounts();
  console.log('계좌:', accts.map(a => ({ no: a.accountNo, seq: a.accountSeq })));
  if (accts[0]) {
    const bp = await getBuyingPower(accts[0].accountSeq, { currency: 'KRW' });
    console.log('현금(cashBuyingPower):', Number(bp?.cashBuyingPower ?? 0).toLocaleString(), '원');
  }
} catch (e) { console.log('\n토스 조회 실패:', e.message); }
