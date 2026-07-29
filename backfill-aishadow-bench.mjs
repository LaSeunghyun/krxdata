/**
 * backfill-aishadow-bench.mjs — 기존 ai_shadow_positions에 벤치마크 청산 트랙을 소급 재생 (2026-07-29)
 *
 * 목적: AI의 기여를 **종목 선택**만으로 분리한다.
 *   지금 원장은 "AI 선택 + AI가 정한 청산(target/stop/horizon)" 한 트랙뿐이라
 *   0승 5패가 선택 탓인지 청산 탓인지 갈리지 않는다. 실측으로 확인된 것:
 *     · 진입가 편향 평균 -0.50%(비관) → 보정해도 -7.11% → -6.42%, 원인 아님
 *     · AI 청산은 버티기보다 +5.04%p 유리했다 → 청산도 원인 아님
 *     · 6건 중 4건이 07-23 진입이고 07-25~29에 시장 -16~25% → **폭락이 원인**
 *   그래도 "고정 규칙으로 청산했으면?"은 별개 질문이고, 일봉이 있으니 지금 답할 수 있다.
 *
 * 벤치마크 규칙 (ai-shadow.mjs의 BENCH와 동일): 트레일 -6% / 하드 -7% / 만기 20거래일.
 *   부분익절은 미적용(단일 손익 추적). 일봉 종가로 판정한다 — 원장이 종가 기반이라 규약을 맞춘다.
 *
 * 실행: node backfill-aishadow-bench.mjs [--dry]
 */
import 'dotenv/config';
import { getDailyPrices } from './kis-api.js';

const DRY = process.argv.includes('--dry');
const BENCH = { trail: 6, hard: 7, maxHold: 20 };
const esc = (s) => String(s).replace(/'/g, "''");
const q = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(60_000) });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`SQL: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ymd = (s) => String(s).slice(0, 10).replace(/-/g, '');

// bench_* 컬럼은 ai-shadow.mjs의 ensureTables()가 만들지만 이 스크립트는 그걸 부르지 않는다 → 여기서도 보장한다.
await q(`
  ALTER TABLE ai_shadow_positions ADD COLUMN IF NOT EXISTS entry_src TEXT;
  ALTER TABLE ai_shadow_positions ADD COLUMN IF NOT EXISTS bench_status TEXT DEFAULT 'open';
  ALTER TABLE ai_shadow_positions ADD COLUMN IF NOT EXISTS bench_hi NUMERIC;
  ALTER TABLE ai_shadow_positions ADD COLUMN IF NOT EXISTS bench_close_price NUMERIC;
  ALTER TABLE ai_shadow_positions ADD COLUMN IF NOT EXISTS bench_closed_at TIMESTAMPTZ;
  ALTER TABLE ai_shadow_positions ADD COLUMN IF NOT EXISTS bench_reason TEXT;
  ALTER TABLE ai_shadow_positions ADD COLUMN IF NOT EXISTS bench_pnl_pct NUMERIC;
  SELECT 1;`);

const rows = await q(`SELECT id, stock_code, name, opened_date, entry_price, close_reason, pnl_pct FROM ai_shadow_positions ORDER BY opened_date`);
console.log(`대상 ${rows.length}건 · 벤치마크 트레일 -${BENCH.trail}% / 하드 -${BENCH.hard}% / 만기 ${BENCH.maxHold}일${DRY ? ' · DRY' : ''}\n`);

const out = [];
for (const p of rows) {
  const d0 = ymd(p.opened_date), entry = Number(p.entry_price);
  let bars;
  try { bars = await getDailyPrices(p.stock_code); } catch (e) { console.log(`${p.name} 일봉 실패: ${String(e.message).slice(0, 60)}`); continue; }
  await sleep(150);
  const norm = (bars ?? []).map(b => ({ d: ymd(b.date), h: Number(b.high), l: Number(b.low), c: Number(b.close) }))
    .filter(b => b.d && b.c > 0).sort((a, b) => a.d.localeCompare(b.d));
  const i0 = norm.findIndex(b => b.d === d0);
  if (i0 < 0) { console.log(`${p.name}(${p.stock_code}) 진입일 ${d0} 일봉 없음`); continue; }

  // 진입일 종가부터 판정 (원장이 종가 기반이므로 동일 규약)
  let hi = entry, br = null, bpx = null, bday = null, held = 0;
  for (let i = i0; i < norm.length; i++) {
    const c = norm[i].c;
    held = i - i0;
    hi = Math.max(hi, c);
    const ret = (c / entry - 1) * 100;
    if (ret <= -BENCH.hard) { br = 'hard'; bpx = c; bday = norm[i].d; break; }
    if (c <= hi * (1 - BENCH.trail / 100)) { br = 'trail'; bpx = c; bday = norm[i].d; break; }
    if (held >= BENCH.maxHold) { br = 'time'; bpx = c; bday = norm[i].d; break; }
  }
  const lastC = norm.at(-1).c, lastD = norm.at(-1).d;
  const openRet = (lastC / entry - 1) * 100;
  out.push({
    id: p.id, name: p.name, code: p.stock_code, d0, entry,
    aiPnl: p.pnl_pct == null ? null : Number(p.pnl_pct), aiReason: p.close_reason,
    br, bpx, bday, bHeld: held, bPnl: bpx == null ? null : (bpx / entry - 1) * 100,
    hi, openRet, lastC, lastD,
  });
}

console.log('종목            진입일     진입가   AI청산    AI사유   벤치청산  벤치사유  벤치일자   벤치보유  현재손익');
console.log('─'.repeat(118));
for (const r of out) {
  const f = (v, w = 8) => (v == null ? '-' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%').padStart(w);
  console.log(`${String(r.name).padEnd(14)} ${r.d0}  ${Math.round(r.entry).toLocaleString().padStart(8)} ${f(r.aiPnl)}  ${String(r.aiReason ?? '-').padEnd(7)} ${f(r.bPnl)}  ${String(r.br ?? '보유중').padEnd(8)} ${String(r.bday ?? '-').padEnd(9)} ${String(r.bHeld).padStart(4)}일  ${f(r.openRet)}`);
}

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const both = out.filter(r => r.aiPnl != null && r.bPnl != null);
console.log('\n── AI 청산 vs 벤치마크 청산 (같은 종목·같은 진입가) ──');
if (both.length) {
  const a = avg(both.map(r => r.aiPnl)), b = avg(both.map(r => r.bPnl));
  console.log(`표본 ${both.length}건 | AI청산 평균 ${a.toFixed(2)}%  vs  벤치청산 평균 ${b.toFixed(2)}%  → 차이 ${(b - a).toFixed(2)}%p`);
  console.log(`AI가 나은 건 ${both.filter(r => r.aiPnl > r.bPnl).length} · 벤치가 나은 건 ${both.filter(r => r.bPnl > r.aiPnl).length}`);
  console.log(`\n※ 벤치가 유의하게 나으면 → AI의 청산 파라미터가 문제(선택은 별개).`);
  console.log(`※ 둘이 비슷하면 → 청산 방식이 원인이 아니고 **선택 또는 시점**이다.`);
}
console.log(`\n버티기(현재까지) 평균 ${avg(out.map(r => r.openRet)).toFixed(2)}%  ← 두 청산 모두 이보다 나으면 청산 자체는 기여한 것`);

if (!DRY) {
  for (const r of out) {
    if (r.br) {
      await q(`UPDATE ai_shadow_positions SET bench_status='closed', bench_close_price=${r.bpx}, bench_closed_at=NOW(),
        bench_reason='${esc(r.br)}', bench_pnl_pct=${r.bPnl.toFixed(2)}, bench_hi=${r.hi} WHERE id=${r.id}`);
    } else {
      await q(`UPDATE ai_shadow_positions SET bench_status='open', bench_hi=${r.hi} WHERE id=${r.id}`);
    }
  }
  console.log(`\n원장 갱신 완료 ${out.length}건 (bench_* 컬럼)`);
} else {
  console.log(`\n(--dry: 원장 미갱신)`);
}
