#!/usr/bin/env node
/**
 * diag-forecast-root.mjs — 예측 원장 3대 결함 근본원인 진단 (2026-08-05)
 *
 * 1차 진단(diag-forecast-direction.mjs)에서 나온 3개를 각각 파고든다:
 *   A 보합밴드 — 가장 조용한 구간(|실제| 0.21%)에서 방향적중 15.6% 로 최악. 밴드가 실제 분포와 안 맞는다는 신호
 *   B 하락편향 — 예측 down 46.6% vs 실제 down 27.8%. 어디서 생기나(median 인가 확률인가)
 *   C 저적중섹터 — 조선·운송장비 4% · 가구·기타제조 4% (무작위 33% 의 1/8). 매핑·산출 버그 의심
 *
 * 각 절은 **원인을 특정**하는 것이 목적이다. "나쁘다"는 이미 안다.
 */
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

async function dbQuery(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`db ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const rows = (await dbQuery(`
  SELECT l.sector, l.target_kind, l.target_end_date, l.session,
         l.forecast_median::float8 fm, l.forecast_low::float8 flo, l.forecast_high::float8 fhi,
         l.probability_up::float8 pu, l.probability_flat::float8 pf, l.probability_down::float8 pd,
         l.flat_band::float8 band, l.sigma::float8 sigma, l.stat_median::float8 sm, l.confidence::float8 conf,
         v.actual_return::float8 ar, v.actual_class ac, v.pred_class pc, v.direction_hit dh, v.in_range ir
  FROM forecast_ledger l JOIN forecast_verification v ON v.ledger_id = l.id
  ORDER BY l.target_end_date`)).map(r => ({ ...r }));

const n = rows.length;
const pct = (a, b) => (b ? (a / b * 100).toFixed(1) + '%' : '-');
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const med = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

console.log(`=== 예측 3대 결함 근본원인 진단 (검증 ${n}건) ===\n`);

// ══ A. 보합밴드 ═══════════════════════════════════════════════
console.log(`【A. 보합밴드】 왜 조용한 날에 가장 못 맞추나`);
const bands = rows.map(r => r.band).filter(Number.isFinite);
const absAr = rows.map(r => Math.abs(r.ar)).filter(Number.isFinite);
console.log(`  현행 flat_band  중위 ${med(bands).toFixed(3)}%  (25% ${q(bands, .25).toFixed(3)} / 75% ${q(bands, .75).toFixed(3)})`);
console.log(`  실제 |수익률|    중위 ${med(absAr).toFixed(3)}%  (25% ${q(absAr, .25).toFixed(3)} / 75% ${q(absAr, .75).toFixed(3)})`);
const flatShare = absAr.filter(v => v <= med(bands)).length / absAr.length;
console.log(`  → 현행 밴드로 자르면 실제의 ${pct(flatShare * absAr.length, absAr.length)} 가 '보합'인데, 원장 실제 보합은 32.0%`);
// 밴드를 바꿔가며 3분류 적중률 재계산 (예측 클래스 = forecast_median 과 밴드로 재분류)
console.log(`\n  밴드별 3분류 적중률 재계산 (예측=median·실제=actual 을 같은 밴드로 분류):`);
console.log(`  ${'밴드%'.padStart(7)}${'적중'.padStart(8)}${'예측up'.padStart(8)}${'예측flat'.padStart(9)}${'예측down'.padStart(9)}${'실제flat'.padStart(9)}`);
let bestB = null;
for (const b of [0.1, 0.2, 0.3, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0]) {
  const cl = (v) => (v > b ? 'up' : v < -b ? 'down' : 'flat');
  let h = 0, pu = 0, pflat = 0, pdn = 0, aflat = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.fm) || !Number.isFinite(r.ar)) continue;
    const p = cl(r.fm), a = cl(r.ar);
    if (p === a) h++;
    if (p === 'up') pu++; else if (p === 'flat') pflat++; else pdn++;
    if (a === 'flat') aflat++;
  }
  const acc = h / n * 100;
  if (!bestB || acc > bestB.acc) bestB = { b, acc };
  console.log(`  ${b.toFixed(1).padStart(7)}${(acc.toFixed(1) + '%').padStart(8)}${pct(pu, n).padStart(8)}${pct(pflat, n).padStart(9)}${pct(pdn, n).padStart(9)}${pct(aflat, n).padStart(9)}`);
}
console.log(`  → 최적 밴드 ${bestB.b}% 에서 적중 ${bestB.acc.toFixed(1)}% (현행 원장 28.6%)`);

// ══ B. 하락편향 ═══════════════════════════════════════════════
console.log(`\n【B. 하락편향】 down 46.6% vs 실제 27.8% — 어디서 생기나`);
const fm = rows.map(r => r.fm).filter(Number.isFinite);
const ar = rows.map(r => r.ar).filter(Number.isFinite);
console.log(`  예측 median  평균 ${avg(fm).toFixed(3)}% · 중위 ${med(fm).toFixed(3)}% · 음수비율 ${pct(fm.filter(v => v < 0).length, fm.length)}`);
console.log(`  실제 수익률  평균 ${avg(ar).toFixed(3)}% · 중위 ${med(ar).toFixed(3)}% · 음수비율 ${pct(ar.filter(v => v < 0).length, ar.length)}`);
const dprob = rows.filter(r => Number.isFinite(r.pd) && Number.isFinite(r.pu));
console.log(`  확률 P(down)−P(up)  평균 ${avg(dprob.map(r => r.pd - r.pu)).toFixed(2)}%p · 양수비율 ${pct(dprob.filter(r => r.pd > r.pu).length, dprob.length)}`);
console.log(`  → ${Math.abs(avg(fm)) > 0.1 ? `**median 자체가 ${avg(fm) < 0 ? '음' : '양'}으로 치우침**` : 'median 은 중립'}` +
  ` · ${Math.abs(avg(dprob.map(r => r.pd - r.pu))) > 3 ? '**확률도 하락 쪽으로 치우침**' : '확률은 비교적 중립'}`);
// 시기별 — 하락편향이 특정 구간(폭락기)에서 학습된 것인지
console.log(`\n  월별 예측 median 평균 vs 실제 평균:`);
const byMon = {};
for (const r of rows) { const m = String(r.target_end_date).slice(0, 6); (byMon[m] ??= []).push(r); }
for (const [m, a] of Object.entries(byMon).sort()) {
  const f = a.map(x => x.fm).filter(Number.isFinite), t = a.map(x => x.ar).filter(Number.isFinite);
  console.log(`    ${m}  n=${String(a.length).padStart(3)}  예측 ${avg(f).toFixed(2).padStart(6)}%  실제 ${avg(t).toFixed(2).padStart(6)}%  차 ${(avg(f) - avg(t)).toFixed(2).padStart(6)}%p`);
}

// ══ C. 저적중 섹터 ════════════════════════════════════════════
console.log(`\n【C. 저적중 섹터】 조선·운송장비/가구·기타제조 4% — 매핑인가 산출인가`);
const bySec = {};
for (const r of rows) (bySec[r.sector] ??= []).push(r);
const secStat = Object.entries(bySec).filter(([, a]) => a.length >= 5).map(([s, a]) => {
  const f = a.map(x => x.fm).filter(Number.isFinite), t = a.map(x => x.ar).filter(Number.isFinite);
  const same = a.filter(x => Number.isFinite(x.fm) && Number.isFinite(x.ar) && Math.sign(x.fm) === Math.sign(x.ar)).length;
  // 예측-실제 상관
  const pairs = a.filter(x => Number.isFinite(x.fm) && Number.isFinite(x.ar));
  const mf = avg(pairs.map(x => x.fm)), mt = avg(pairs.map(x => x.ar));
  const cov = avg(pairs.map(x => (x.fm - mf) * (x.ar - mt)));
  const sf = Math.sqrt(avg(pairs.map(x => (x.fm - mf) ** 2))), st = Math.sqrt(avg(pairs.map(x => (x.ar - mt) ** 2)));
  return { s, n: a.length, hit: a.filter(x => x.dh).length / a.length * 100,
    predSd: sf, actSd: st, corr: sf > 0 && st > 0 ? cov / (sf * st) : NaN,
    signSame: same / pairs.length * 100, predMean: mf, actMean: mt };
}).sort((a, b) => a.hit - b.hit);
console.log(`  ${'섹터'.padEnd(20)}${'n'.padStart(4)}${'적중'.padStart(7)}${'부호일치'.padStart(9)}${'예측σ'.padStart(8)}${'실제σ'.padStart(8)}${'상관'.padStart(8)}${'예측평균'.padStart(9)}${'실제평균'.padStart(9)}`);
for (const x of secStat) {
  console.log(`  ${x.s.slice(0, 18).padEnd(20)}${String(x.n).padStart(4)}${(x.hit.toFixed(0) + '%').padStart(7)}` +
    `${(x.signSame.toFixed(0) + '%').padStart(9)}${x.predSd.toFixed(2).padStart(8)}${x.actSd.toFixed(2).padStart(8)}` +
    `${(Number.isFinite(x.corr) ? x.corr.toFixed(2) : '-').padStart(8)}${x.predMean.toFixed(2).padStart(9)}${x.actMean.toFixed(2).padStart(9)}`);
}
console.log(`\n  ※ 읽는 법: 예측σ << 실제σ 면 **변동성 과소예측**(범위 이탈의 원인).`);
console.log(`     상관 ≈ 0 이면 정보 없음 · 음수면 역방향 · 부호일치 50% 미만이면 뒤집는 게 낫다.`);
console.log(`     실제평균이 섹터마다 크게 다르면 합성지수 산출(시총가중)이 의심된다.`);
