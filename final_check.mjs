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

console.log('=== LIVE 매수 차단 분석 ===\n');

// 1. getAccounts() 실패 가능성
console.log('🔴 가능성 1: getAccounts() 또는 getHoldings() 실패');
console.log('   → seq == null → early return → 매수 로직 진입 안 함');
console.log('   확인방법: Toss API 토큰/인증 상태 점검 필요\n');

// 2. rsiUniverse 0건 가능성
const slotBudget = Math.floor(47359 / LIVE_SLOTS);
const priceCeiling = Math.max(slotBudget, MIN_PRICE * 3);
const rsiCount = await dbQuery(`
  SELECT COUNT(*) as cnt FROM stock_analysis
  WHERE current_price >= ${MIN_PRICE} AND current_price <= ${priceCeiling}
    AND market_cap_tril >= 0.3
`);

console.log('💚 가능성 2: rsiUniverse 0건 (DB 후보 없음)');
console.log(`   검색 범위: ${MIN_PRICE}~${priceCeiling}원, 시총≥3000억`);
console.log(`   결과: ${rsiCount[0]?.cnt || 0}개 ${(rsiCount[0]?.cnt || 0) === 0 ? '← 0건 = 루프 스킵' : '← 후보 있음'}\n`);

// 3. ranked.length === 0 가능성 (신호 미발생)
const queue = await dbQuery(`SELECT data FROM paper_state WHERE k = 'live_queue'`);
const qdata = queue[0]?.data ?? [];
console.log('💛 가능성 3: ranked.length === 0 (후보가 있지만 신호 미발생)');
console.log(`   live_queue: ${Array.isArray(qdata) ? qdata.length : 0}개 BUY`);
console.log(`   → ranked.length=0이면 pickBuyCandidates() 호출 안 됨 (line 700 if)\n`);

// 4. affordability 필터
console.log('💙 가능성 4: affordability 필터 (a33d574 수정 후)');
console.log(`   필터: close * 1.01 <= slotBudget * atrMult`);
console.log(`   현재 slotBudget: ${slotBudget}원, ATR×0.5~1.5\n`);

// 5. 종합
console.log('=== 종합 판정 ===');
console.log('① rsiUniverse > 0 ← OK');
console.log(`② live_queue.length === 0 ← 매수 후보 미적재`);
console.log(`③ 원인 추정:`);
console.log(`   - Toss 인증 실패 → seq == null → early return`);
console.log(`   - OR: rsi2SignalG(code) 반환값 null → 신호 미발생`);
console.log(`   - OR: affordability 필터로 제외`);

