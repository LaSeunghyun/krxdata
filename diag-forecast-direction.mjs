#!/usr/bin/env node
/**
 * diag-forecast-direction.mjs — 예측 원장 방향적중 진단 (2026-08-05)
 *
 * ── 왜 ────────────────────────────────────────────────────────────────────────
 * 일간 방향적중이 **17.03%**(n=276). 3분류(상승/보합/하락)에서 무작위가 33% 인데 그 절반이다.
 * **무작위보다 낮다는 건 정보가 없다는 뜻이 아니라 정보를 거꾸로 쓰고 있을 수 있다는 뜻이다.**
 * 뉴스를 숫자 예측에 넣는 설계 변경(= 백테 불가 축 추가)을 하기 전에, 먼저 원인을 가른다.
 *
 * ── 사전선언 질문 ─────────────────────────────────────────────────────────────
 *  Q1 **일관 역방향인가?** 예측을 뒤집으면(상승↔하락) 적중률이 얼마가 되나.
 *     뒤집어서 50%+ 면 부호 문제이지 정보 부재가 아니다.
 *  Q2 **국면 의존인가?** 실제 변동이 큰 날(|actual| 상위)과 조용한 날의 적중률 차이.
 *     큰 날에만 무너지면 뉴스 주도 국면을 못 읽는 것 → 뉴스 주입이 답.
 *  Q3 **섹터 의존인가?** 섹터별 적중률 분산. 특정 섹터만 나쁘면 그 섹터 매핑·데이터 문제.
 *  Q4 **보합 과다 예측인가?** pred_class 분포 vs actual_class 분포.
 *     보합을 남발하면 3분류 적중률이 구조적으로 낮아진다(보합은 실제로 드물다).
 *
 * 실행: node diag-forecast-direction.mjs
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

const rows = await dbQuery(`
  SELECT l.sector, l.target_kind, l.market_layer, l.target_end_date,
         l.forecast_median, l.probability_up, l.probability_flat, l.probability_down,
         l.flat_band, l.confidence, l.call_direction,
         v.actual_return, v.actual_class, v.pred_class, v.direction_hit, v.in_range, v.abs_error
  FROM forecast_ledger l JOIN forecast_verification v ON v.ledger_id = l.id
  ORDER BY l.target_end_date`);

console.log(`=== 예측 방향적중 진단 ===`);
console.log(`검증 완료 ${rows.length}건\n`);
if (!rows.length) process.exit(0);

const daily = rows.filter(r => r.target_kind === 'daily' || r.target_kind === 'day' || !r.target_kind?.includes('min'));
const pick = daily.length >= 30 ? daily : rows;
console.log(`분석 대상 ${pick.length}건 (target_kind 분포: ${[...new Set(rows.map(r => r.target_kind))].join(', ')})\n`);

const cls = (v, band) => (v > band ? 'up' : v < -band ? 'down' : 'flat');
const pct = (a, b) => (b ? (a / b * 100).toFixed(1) + '%' : '-');

// ── Q4 먼저: 분포 (다른 질문 해석의 전제) ─────────────────────
const dist = (key) => {
  const m = {};
  for (const r of pick) { const k = r[key] ?? '?'; m[k] = (m[k] ?? 0) + 1; }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, pick.length)}`).join(' · ');
};
console.log(`【Q4 분류 분포】 — 보합 남발이면 3분류 적중률이 구조적으로 낮아진다`);
console.log(`  예측 pred_class : ${dist('pred_class')}`);
console.log(`  실제 actual_class: ${dist('actual_class')}\n`);

// ── Q1 역방향 검정 ────────────────────────────────────────────
let hit = 0, flip = 0, nonFlat = 0, flipNonFlat = 0, hitNonFlat = 0;
for (const r of pick) {
  const p = r.pred_class, a = r.actual_class;
  if (p && a) {
    if (p === a) hit++;
    const inv = p === 'up' ? 'down' : p === 'down' ? 'up' : 'flat';
    if (inv === a) flip++;
    if (p !== 'flat' && a !== 'flat') {
      nonFlat++;
      if (p === a) hitNonFlat++;
      if (inv === a) flipNonFlat++;
    }
  }
}
console.log(`【Q1 역방향 검정】 — 뒤집어서 50%+ 면 부호 문제이지 정보 부재가 아니다`);
console.log(`  원본 적중        ${pct(hit, pick.length)}  (${hit}/${pick.length})`);
console.log(`  **뒤집으면**      ${pct(flip, pick.length)}  (${flip}/${pick.length})`);
console.log(`  보합 제외(양방향만) 원본 ${pct(hitNonFlat, nonFlat)} / 뒤집으면 ${pct(flipNonFlat, nonFlat)}  (n=${nonFlat})\n`);

// ── Q2 국면 의존 ──────────────────────────────────────────────
const withAbs = pick.filter(r => Number.isFinite(Number(r.actual_return)));
const sorted = [...withAbs].sort((a, b) => Math.abs(Number(b.actual_return)) - Math.abs(Number(a.actual_return)));
const q = Math.max(1, Math.floor(sorted.length / 4));
const band = (arr, label) => {
  const h = arr.filter(r => r.direction_hit).length;
  const ir = arr.filter(r => r.in_range).length;
  const mae = arr.reduce((s, r) => s + Math.abs(Number(r.abs_error) || 0), 0) / arr.length;
  console.log(`  ${label.padEnd(18)} n=${String(arr.length).padStart(4)} 방향 ${pct(h, arr.length).padStart(6)} · 범위 ${pct(ir, arr.length).padStart(6)} · MAE ${mae.toFixed(2)}%p · |실제| 평균 ${(arr.reduce((s, r) => s + Math.abs(Number(r.actual_return)), 0) / arr.length).toFixed(2)}%`);
};
console.log(`【Q2 국면 의존】 — 큰 날에만 무너지면 뉴스 주도 국면을 못 읽는 것`);
band(sorted.slice(0, q), '변동 큰 25%');
band(sorted.slice(q, 2 * q), '2분위');
band(sorted.slice(2 * q, 3 * q), '3분위');
band(sorted.slice(3 * q), '변동 작은 25%');
console.log();

// ── Q3 섹터 의존 ──────────────────────────────────────────────
console.log(`【Q3 섹터별】 — 특정 섹터만 나쁘면 매핑·데이터 문제`);
const bySec = {};
for (const r of pick) (bySec[r.sector] ??= []).push(r);
const secRows = Object.entries(bySec).filter(([, a]) => a.length >= 5)
  .map(([s, a]) => ({ s, n: a.length, hit: a.filter(x => x.direction_hit).length / a.length * 100 }))
  .sort((a, b) => b.hit - a.hit);
for (const x of secRows.slice(0, 6)) console.log(`  ${x.s.padEnd(22)} n=${String(x.n).padStart(3)}  ${x.hit.toFixed(0)}%`);
if (secRows.length > 6) { console.log(`  ...`); for (const x of secRows.slice(-3)) console.log(`  ${x.s.padEnd(22)} n=${String(x.n).padStart(3)}  ${x.hit.toFixed(0)}%`); }
const hits = secRows.map(x => x.hit);
console.log(`  → 섹터간 분산: 최고 ${Math.max(...hits).toFixed(0)}% / 최저 ${Math.min(...hits).toFixed(0)}% (${secRows.length}개 섹터)`);

// ── 예측 median 부호 vs 실제 부호 (분류와 별개로 원자료 확인) ──
const both = pick.filter(r => Number.isFinite(Number(r.forecast_median)) && Number.isFinite(Number(r.actual_return)));
const sameSign = both.filter(r => Math.sign(Number(r.forecast_median)) === Math.sign(Number(r.actual_return))).length;
console.log(`\n【원자료 부호 일치】 forecast_median 과 actual_return 의 부호가 같은 비율: ${pct(sameSign, both.length)} (n=${both.length})`);
console.log(`  ※ 50% 근처면 정보 없음 · 명확히 50% 미만이면 **역방향 신호**(부호를 뒤집으면 쓸 수 있다는 뜻)`);
