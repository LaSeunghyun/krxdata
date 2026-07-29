/**
 * diag-aishadow-entry.mjs — ai-shadow 진입가 편향 실측 (2026-07-29, 사용자 지적)
 *   "진입일 진입가도 잘못 판단한건 아니었을까?"
 *
 * 확인된 결함: ai-shadow는 진입가·청산가를 모두 `stock_prices` 최신 종가로 매긴다(ai-shadow.mjs:64,135).
 *   08:47에 실행되므로 그 값은 **전일 종가**다. 실제로 그 가격에 살 수는 없다.
 *   판단 근거인 공시는 장 마감 후 나오는 경우가 많아 **룩어헤드(AI에 유리)** 방향이다.
 *
 * 이 스크립트는 편향의 **크기**를 실측한다. 0.2% 수준이면 0승5패의 원인이 아니고,
 * 2~3%면 원인의 상당 부분이다. 크기를 모르면 "청산만 고쳐 재생"해도 결과를 못 믿는다.
 *
 * 방법: ai_shadow_positions의 청산건마다 KIS 일봉으로 진입일 실제 시/고/저/종을 받아
 *   기록 진입가와 대조한다. 체결 가능한 최선가(시가)와의 차이가 편향이다.
 *
 * 실행: node diag-aishadow-entry.mjs
 */
import 'dotenv/config';
import { getDailyPrices } from './kis-api.js';

const q = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(60_000) });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`SQL: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const rows = await q(`SELECT stock_code, name, opened_date, entry_price, close_price, closed_at,
  close_reason, pnl_pct, target_pct, stop_pct, horizon_days, conviction
  FROM ai_shadow_positions ORDER BY opened_date`);
console.log(`ai_shadow_positions ${rows.length}건 (청산 ${rows.filter(r => r.close_price != null).length}건)\n`);

const ymd = (s) => String(s).slice(0, 10).replace(/-/g, '');
const out = [];
for (const r of rows) {
  const d0 = ymd(r.opened_date);
  let bars;
  try { bars = await getDailyPrices(r.stock_code, 40); } catch (e) { console.log(`${r.name} 일봉 실패: ${String(e.message).slice(0, 60)}`); continue; }
  await sleep(120);
  // getDailyPrices 반환 정렬을 가정하지 않는다 — 날짜로 찾는다
  const norm = (bars ?? []).map(b => ({ d: ymd(b.date ?? b.stck_bsop_date ?? ''), o: Number(b.open ?? b.stck_oprc), h: Number(b.high ?? b.stck_hgpr), l: Number(b.low ?? b.stck_lwpr), c: Number(b.close ?? b.stck_clpr) }))
    .filter(b => b.d && b.c > 0).sort((a, b) => a.d.localeCompare(b.d));
  const i = norm.findIndex(b => b.d === d0);
  if (i < 1) { console.log(`${r.name}(${r.stock_code}) 진입일 ${d0} 일봉 없음 (보유 ${norm.length}일)`); continue; }
  const prev = norm[i - 1], day = norm[i];
  const rec = Number(r.entry_price);
  out.push({
    name: r.name, code: r.stock_code, d0, rec,
    prevClose: prev.c, o: day.o, h: day.h, l: day.l, c: day.c,
    isPrevClose: Math.abs(rec / prev.c - 1) < 0.001,
    vsOpen: (day.o / rec - 1) * 100,          // +면 실제로는 더 비싸게 사야 했다 = 원장이 낙관
    pnl: r.pnl_pct == null ? null : Number(r.pnl_pct),
    holdNow: (norm.at(-1).c / rec - 1) * 100,      // 안 팔고 지금까지 버텼으면
    lastDay: norm.at(-1).d,
    reason: r.close_reason, stop: r.stop_pct, horizon: r.horizon_days,
  });
}

console.log('종목            진입일     기록가     전일종가   당일시가   당일저가   기록가=전일종가  시가편향   실현손익');
console.log('─'.repeat(118));
for (const r of out) {
  const f = (v) => Math.round(v).toLocaleString().padStart(9);
  console.log(`${String(r.name).padEnd(14)} ${r.d0}  ${f(r.rec)} ${f(r.prevClose)} ${f(r.o)} ${f(r.l)}      ${(r.isPrevClose ? '예' : '아니오').padEnd(6)}  ${((r.vsOpen >= 0 ? '+' : '') + r.vsOpen.toFixed(2) + '%').padStart(8)}  ${r.pnl == null ? '  (보유)' : ((r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(1) + '%').padStart(7)}`);
}

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const bias = out.map(r => r.vsOpen);
console.log('\n── 진입가 편향 종합 ──');
console.log(`기록가 = 전일종가인 건: ${out.filter(r => r.isPrevClose).length}/${out.length}`);
console.log(`당일시가 vs 기록가: 평균 ${(avg(bias) >= 0 ? '+' : '') + avg(bias).toFixed(2)}%  (최소 ${Math.min(...bias).toFixed(2)}% / 최대 ${Math.max(...bias).toFixed(2)}%)`);
console.log(`  +면 실제 체결가가 기록가보다 비쌌다 = **원장이 낙관 편향**(AI에 유리하게 기록됨)`);
console.log(`\n※ 평균 편향이 ±0.5% 안이면 진입 결함은 0승5패의 원인이 아니다.`);
console.log(`※ +2% 이상이면 원장 성적이 실제보다 좋게 나온 것이므로 실제 성적은 더 나쁘다.`);

// 편향을 제거한 재계산: 당일 시가에 샀다면 실현손익이 어떻게 바뀌나
const adj = out.filter(r => r.pnl != null).map(r => r.pnl - r.vsOpen);
if (adj.length) {
  console.log(`\n── 당일 시가 진입으로 보정한 실현손익 ──`);
  console.log(`원장 평균 ${avg(out.filter(r => r.pnl != null).map(r => r.pnl)).toFixed(2)}%  →  보정 후 평균 ${avg(adj).toFixed(2)}%`);
}

// ★ 진짜 벤치마크: 안 팔고 버텼으면? (표본이 07-23~24 진입 = 07-25~29 시장 폭락 직전이다)
//   0승5패라도 시장이 더 빠졌다면 "선택이 나빴다"고 단정할 수 없다. 청산이 구한 몫을 분리한다.
const cl = out.filter(r => r.pnl != null);
if (cl.length) {
  console.log(`\n── 청산 vs 버티기 (기준일 ${out[0]?.lastDay ?? '?'}) ──`);
  console.log('종목            실현손익   버텼으면   청산이 구한 것');
  for (const r of out) {
    const saved = r.pnl == null ? null : r.pnl - r.holdNow;
    console.log(`${String(r.name).padEnd(14)} ${(r.pnl == null ? '(보유)' : (r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(1) + '%').padStart(8)} ${((r.holdNow >= 0 ? '+' : '') + r.holdNow.toFixed(1) + '%').padStart(9)}  ${saved == null ? '        -' : ((saved >= 0 ? '+' : '') + saved.toFixed(1) + '%p').padStart(9)}`);
  }
  const a = avg(cl.map(r => r.pnl)), b = avg(cl.map(r => r.holdNow));
  console.log(`\n청산 평균 ${a.toFixed(2)}%  vs  버티기 평균 ${b.toFixed(2)}%  → 청산이 ${Math.abs(a - b).toFixed(2)}%p ${a > b ? '구했다' : '더 잃었다'}`);
}
