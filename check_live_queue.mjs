import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

async function dbQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(data?.message ?? 'DB 쿼리 오류');
  return data;
}

// live_queue 확인
const queue = await dbQuery(`SELECT data FROM paper_state WHERE k = 'live_queue'`);
console.log('=== live_queue (내일 시가 실주문 예약) ===');
if (queue[0]?.data) {
  const qdata = queue[0].data;
  console.log(`건수: ${Array.isArray(qdata) ? qdata.length : 0}건`);
  if (Array.isArray(qdata) && qdata.length > 0) {
    console.log('\n내용:');
    qdata.forEach((q, i) => {
      console.log(`  ${i+1}) ${q.side} ${q.name ?? q.code} ${q.qty}주 @ ${q.close}원 (${q.reason})`);
    });
  } else {
    console.log('(비어있음 — 내일 실주문 없음)');
  }
} else {
  console.log('NOT FOUND');
}

// live_halt 확인 (서킷브레이커)
const halt = await dbQuery(`SELECT data FROM paper_state WHERE k = 'live_halt'`);
console.log('\n=== live_halt (서킷브레이커) ===');
if (halt[0]?.data) {
  console.log(JSON.stringify(halt[0].data, null, 2));
} else {
  console.log('(활성화 안 됨)');
}

// live_baseline 확인
const baseline = await dbQuery(`SELECT data FROM paper_state WHERE k = 'live_baseline'`);
console.log('\n=== live_baseline (원금 기준선) ===');
if (baseline[0]?.data) {
  console.log(JSON.stringify(baseline[0].data, null, 2));
} else {
  console.log('NOT FOUND (원금 설정 안 됨)');
}

// 최근 라이브 트레이드 확인
console.log('\n=== 최근 라이브 매매 (paper_trades) ===');
const trades = await dbQuery(`
  SELECT ts, type, code, name, qty, price, entry, pnl FROM paper_trades
  WHERE strat = 'live'
  ORDER BY ts DESC LIMIT 5
`);
if (trades.length) {
  trades.forEach(t => {
    const sign = t.pnl >= 0 ? '+' : '';
    console.log(`  ${t.ts} | ${t.type.toUpperCase()} ${t.name}(${t.code}) ${t.qty}주 @ ${t.price}원 | 손익 ${sign}${t.pnl}원`);
  });
} else {
  console.log('(아직 실주문 체결 없음)');
}

