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

const MIN_PRICE = 2000;
const LIVE_SLOTS = 2;

// 오늘 실행 가정
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

// 1. evaluateLiveHoldings 매수 경로 진입 조건
console.log('=== evaluateLiveHoldings 진입 조건 ===');

const halt = await dbQuery(`SELECT data FROM paper_state WHERE k = 'live_halt'`);
console.log(`1) live_halt 체크: ${halt[0]?.data ? 'HALT 활성 → 조기 return' : 'OK'}`);

// 2. 계좌 (Toss API 체크 불가 — 실주문 계좌 없음 가정)
console.log('\n2) 계좌 조회: 🔴 Toss API 확인 필요 (시뮬레이션 불가)');
console.log('   → getAccounts() 실패하면 early return (seq == null)');

// 3. 신규 진입 조건
const baseline = await dbQuery(`SELECT data FROM paper_state WHERE k = 'live_baseline'`);
console.log('\n3) slotsToFill 계산 조건:');
console.log(`   - baseline 설정 여부: ${baseline[0]?.data ? 'YES' : 'NO'}`);
if (baseline[0]?.data) {
  const bline = baseline[0].data;
  console.log(`     (${bline.at}: ${bline.value.toLocaleString()}원)`);
}

// 4. uApplied 상태 확인 (모멘텀 top30)
const largeCaps = await dbQuery(`
  SELECT COUNT(*) as cnt FROM stock_analysis
  WHERE current_price >= ${MIN_PRICE}
  ORDER BY market_cap_tril DESC LIMIT 30
`);
console.log(`\n4) uApplied(모멘텀 top30) 쿼리 결과: ${largeCaps[0]?.cnt || 0}개`);

// 5. rsi2 유니버스 후보 확인
const slotBudget = Math.floor(47359 / LIVE_SLOTS);
const priceCeiling = Math.max(slotBudget, MIN_PRICE * 3);
const rsiCount = await dbQuery(`
  SELECT COUNT(*) as cnt FROM stock_analysis
  WHERE current_price >= ${MIN_PRICE} AND current_price <= ${priceCeiling}
    AND market_cap_tril >= 0.3
`);
console.log(`\n5) rsiUniverse(시총≥0.3조 & 가격≤${priceCeiling}원) 쿼리 결과: ${rsiCount[0]?.cnt || 0}개`);
if (rsiCount[0]?.cnt === 0) {
  console.log('   🔴 rsiUniverse가 0개 → for 루프 스킵 → 매수 후보 0');
}

// 6. 최종 ranked 배열 상태
const queue = await dbQuery(`SELECT data FROM paper_state WHERE k = 'live_queue'`);
const qdata = queue[0]?.data ?? [];
console.log(`\n6) 최종 live_queue 상태: ${Array.isArray(qdata) ? qdata.length : 0}개 BUY 주문`);
if (Array.isArray(qdata) && qdata.length === 0) {
  console.log('   → ranked.length === 0이므로 pickBuyCandidates 호출 안 됨');
}

console.log('\n=== 종합 판정 ===');
if (rsiCount[0]?.cnt === 0 && largeCaps[0]?.cnt === 0) {
  console.log('❌ uApplied=0 AND rsiUniverse=0 → 매수 경로 완전 차단');
} else if (rsiCount[0]?.cnt === 0) {
  console.log('⚠️  rsiUniverse=0이지만 uApplied는 있음 → hi120 경로만 유지');
} else if (qdata.length === 0 && rsiCount[0]?.cnt > 0) {
  console.log('❓ rsiUniverse>0 인데 live_queue=0 → 신호(rsi2SignalG) 부재 또는 affordability 필터');
}

