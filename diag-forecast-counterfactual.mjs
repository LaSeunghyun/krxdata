#!/usr/bin/env node
/**
 * diag-forecast-counterfactual.mjs — 예측 엔진 상수 반사실 검정 (2026-08-05)
 *
 * ── 무엇을 하나 ───────────────────────────────────────────────────────────────
 * 원장은 불변이고 `sigma`·`forecast_median` 이 남아 있다. 엔진 식이
 *   median = clamp(MEDIAN_SHRINK × m20, ±MEDIAN_CAP_SIGMA × σ)   (현행 0.3, 0.5)
 * 이므로 clamp 에 안 걸린 행은 **m20 = median / 0.3** 으로 입력을 복원할 수 있다.
 * 복원한 m20·σ 로 **다른 상수를 넣었으면 어떤 예측이었을지**를 재구성해 실제 결과와 대조한다.
 *
 * 이건 정당한 리플레이다 — m20·σ 는 예측 시점에 알 수 있던 값이고, actual_return 은 그 뒤의 결과다.
 * 미래 정보가 들어가지 않는다.
 *
 * ── 사전선언 판정 (사후 조정 금지) ────────────────────────────────────────────
 *   · 채택 후보 = **IS·OOS 둘 다** 부호일치 > 50% ∧ 3분류 적중이 현행보다 높을 것
 *   · 표본 378건 · 23거래일뿐이다. **파라미터를 이 표본에 맞추면 그게 과적합**이므로
 *     격자를 굵게(부호·shrink·cap 몇 점) 두고, 미세조정은 하지 않는다.
 *   · 부호 반전은 단일 이진 선택이라 과적합 여지가 가장 작다 — 그것만이라도 갈리면 소득이다.
 *
 * 실행: node diag-forecast-counterfactual.mjs
 */
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const CUR_SHRINK = 0.3, CUR_CAP = 0.5, CUR_BAND_K = 0.25;

async function dbQuery(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`db ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const raw = await dbQuery(`
  SELECT l.sector, l.target_end_date, l.forecast_median::float8 fm, l.sigma::float8 sg,
         l.flat_band::float8 band, v.actual_return::float8 ar, v.direction_hit dh
  FROM forecast_ledger l JOIN forecast_verification v ON v.ledger_id = l.id
  WHERE l.sigma IS NOT NULL AND l.forecast_median IS NOT NULL
  ORDER BY l.target_end_date`);

// m20 복원 — clamp 에 걸린 행은 입력을 특정할 수 없으므로 제외한다(추정으로 메우면 결론을 만든다)
const EPS = 1e-6;
const rows = [];
let clamped = 0;
for (const r of raw) {
  const fm = Number(r.fm), sg = Number(r.sg), ar = Number(r.ar);
  if (!Number.isFinite(fm) || !Number.isFinite(sg) || !Number.isFinite(ar) || sg <= 0) continue;
  if (Math.abs(Math.abs(fm) - CUR_CAP * sg) < EPS) { clamped++; continue; }   // clamp 경계 = 복원 불가
  rows.push({ ...r, fm, sg, ar, m20: fm / CUR_SHRINK });
}
console.log(`=== 예측 엔진 상수 반사실 검정 ===`);
console.log(`원장 ${raw.length}건 → m20 복원 ${rows.length}건 (clamp 걸려 제외 ${clamped}건)\n`);
if (rows.length < 50) { console.log('표본 부족 — 중단'); process.exit(1); }

// IS/OOS — 날짜 중앙 분할
const dates = [...new Set(rows.map(r => r.target_end_date))].sort();
const split = dates[Math.floor(dates.length / 2)];
const IS = rows.filter(r => r.target_end_date < split), OOS = rows.filter(r => r.target_end_date >= split);
console.log(`IS ${IS.length}건 (~${split}) / OOS ${OOS.length}건 (${split}~) · 거래일 ${dates.length}일\n`);

const cls = (v, b) => (v > b ? 'up' : v < -b ? 'down' : 'flat');
function evaluate(set, { sign, shrink, cap, bandK }) {
  let hit = 0, signSame = 0, n = 0;
  const fs = [], as = [];
  for (const r of set) {
    const raw2 = sign * shrink * r.m20;
    const med = Math.max(-cap * r.sg, Math.min(cap * r.sg, raw2));
    const b = bandK * r.sg;
    if (cls(med, b) === cls(r.ar, b)) hit++;
    if (Math.sign(med) === Math.sign(r.ar) && med !== 0) signSame++;
    fs.push(med); as.push(r.ar); n++;
  }
  const mf = fs.reduce((a, b) => a + b, 0) / n, ma = as.reduce((a, b) => a + b, 0) / n;
  let cov = 0, sf = 0, sa = 0;
  for (let i = 0; i < n; i++) { cov += (fs[i] - mf) * (as[i] - ma); sf += (fs[i] - mf) ** 2; sa += (as[i] - ma) ** 2; }
  const corr = sf > 0 && sa > 0 ? cov / Math.sqrt(sf * sa) : NaN;
  return { acc: hit / n * 100, sign: signSame / n * 100, corr, sd: Math.sqrt(sf / n) };
}

const GRID = [];
for (const sign of [1, -1]) for (const shrink of [0.3, 1.0, 2.0]) for (const cap of [0.5, 2.0, 99]) GRID.push({ sign, shrink, cap, bandK: CUR_BAND_K });
// 밴드 축은 부호·shrink 최적점에서만 따로 본다(격자를 곱하면 과적합 표면이 커진다)

console.log(`${'부호'.padStart(5)}${'shrink'.padStart(8)}${'cap σ'.padStart(7)}` +
  `${'IS적중'.padStart(8)}${'IS부호'.padStart(8)}${'IS상관'.padStart(8)}` +
  `${'OOS적중'.padStart(9)}${'OOS부호'.padStart(9)}${'OOS상관'.padStart(9)}${'예측σ'.padStart(8)}`);
const res = [];
for (const g of GRID) {
  const i = evaluate(IS, g), o = evaluate(OOS, g);
  res.push({ g, i, o });
  const cur = g.sign === 1 && g.shrink === CUR_SHRINK && g.cap === CUR_CAP ? '  ← 현행' : '';
  console.log(`${(g.sign > 0 ? '+' : '−').padStart(5)}${g.shrink.toFixed(1).padStart(8)}${(g.cap === 99 ? 'off' : g.cap.toFixed(1)).padStart(7)}` +
    `${(i.acc.toFixed(1) + '%').padStart(8)}${(i.sign.toFixed(1) + '%').padStart(8)}${i.corr.toFixed(2).padStart(8)}` +
    `${(o.acc.toFixed(1) + '%').padStart(9)}${(o.sign.toFixed(1) + '%').padStart(9)}${o.corr.toFixed(2).padStart(9)}${o.sd.toFixed(2).padStart(8)}${cur}`);
}

console.log(`\n── 사전선언 판정 ──`);
const base = res.find(x => x.g.sign === 1 && x.g.shrink === CUR_SHRINK && x.g.cap === CUR_CAP);
const pass = res.filter(x => x.i.sign > 50 && x.o.sign > 50 && x.i.acc > base.i.acc && x.o.acc > base.o.acc);
if (!pass.length) {
  console.log(`  채택 후보 0건 (IS·OOS 둘 다 부호>50% ∧ 적중이 현행 초과)`);
  const signOk = res.filter(x => x.i.sign > 50 && x.o.sign > 50);
  console.log(`  · 부호 조건만 통과: ${signOk.length}건${signOk.length ? ' → ' + signOk.slice(0, 3).map(x => `${x.g.sign > 0 ? '+' : '−'}/${x.g.shrink}/${x.g.cap}`).join(', ') : ''}`);
} else {
  for (const x of pass.sort((a, b) => b.o.acc - a.o.acc)) {
    console.log(`  ★ 부호 ${x.g.sign > 0 ? '+' : '−'} · shrink ${x.g.shrink} · cap ${x.g.cap === 99 ? 'off' : x.g.cap}σ` +
      ` — IS 적중 ${x.i.acc.toFixed(1)}%/부호 ${x.i.sign.toFixed(1)}% · OOS 적중 ${x.o.acc.toFixed(1)}%/부호 ${x.o.sign.toFixed(1)}%`);
  }
}
console.log(`\n※ 현행 기준선: IS 적중 ${base.i.acc.toFixed(1)}% · OOS 적중 ${base.o.acc.toFixed(1)}% · OOS 부호 ${base.o.sign.toFixed(1)}%`);
console.log(`※ 표본 ${rows.length}건·${dates.length}거래일. **파라미터 미세조정 금지** — 부호 반전(이진)만이 과적합 여지가 작다.`);
