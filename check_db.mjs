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

// 현재 라이브 계좌 자산 파악
const state = await dbQuery(`SELECT data FROM paper_state WHERE k = 'live_meta'`);
console.log('=== live_meta (라이브 계좌 상태) ===');
if (state[0]?.data) {
  const meta = state[0].data;
  console.log(JSON.stringify(meta, null, 2));
} else {
  console.log('NOT FOUND — 라이브 매수가 지금까지 실행된 적 없음');
}

// rsi2 유니버스 후보 확인
const MIN_PRICE = 2000;
const slotBudget = Math.floor(47359 / 2);
const priceCeiling = Math.max(slotBudget, MIN_PRICE * 3);

console.log(`\n=== rsi2 유니버스 후보 ===`);
console.log(`검색 범위: ${MIN_PRICE}~${priceCeiling}원, 시총≥3000억`);

const rsiCount = await dbQuery(`
  SELECT COUNT(*) as cnt FROM stock_analysis
  WHERE current_price >= ${MIN_PRICE} AND current_price <= ${priceCeiling}
    AND market_cap_tril >= 0.3
`);
console.log(`→ 매칭하는 종목: ${rsiCount[0]?.cnt || 0}개 (0이면 매수 불가)`);

if ((rsiCount[0]?.cnt || 0) > 0) {
  const sample = await dbQuery(`
    SELECT stock_code, corp_name, current_price, market_cap_tril FROM stock_analysis
    WHERE current_price >= ${MIN_PRICE} AND current_price <= ${priceCeiling}
      AND market_cap_tril >= 0.3
    ORDER BY market_cap_tril DESC LIMIT 10
  `);
  console.log(`샘플 top10:`);
  sample.forEach(s => console.log(`  ${s.corp_name}(${s.stock_code}): ${s.current_price}원, 시총${(s.market_cap_tril*1).toFixed(2)}조`));
}

// hi120 유니버스 (모멘텀 top30)
console.log(`\n=== hi120 유니버스 (모멘텀 top30) ===`);
const hi120Candidates = await dbQuery(`
  SELECT stock_code, corp_name, current_price FROM stock_analysis
  WHERE current_price >= ${MIN_PRICE}
  ORDER BY market_cap_tril DESC LIMIT 30
`);
console.log(`→ hi120 후보: ${hi120Candidates.length}개`);
if (hi120Candidates.length > 0) {
  console.log(`샘플 top5:`);
  hi120Candidates.slice(0, 5).forEach(c => console.log(`  ${c.corp_name}(${c.stock_code}): ${c.current_price}원`));
}

