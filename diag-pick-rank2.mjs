/**
 * diag-pick-rank2.mjs — 2026-08-07 · 1차 결과의 교란 제거 (diag-pick-rank.mjs 후속)
 *
 * 1차 결과: 1등픽 4.153% vs 3등픽↓ 1.657% (P1·P2 통과) 인데 **conviction 동점률 71.5%** 였다.
 *   "랭킹이 구분을 못 하는데 1등이 낫다" = 모순. 셋 중 하나다:
 *     H1 픽 순번이 외생이 아니다 — pick3 은 **슬롯 3개가 빈 날에만** 존재한다(대량청산 직후 = 국면 편향).
 *        1차는 서로 **다른 날 모집단**을 비교했다.
 *     H2 sub 구성이 다르다 — conviction 10.0 은 `RSI0 × UP(10×1.0)` 과 `돌파 ≥10%` 가 **같은 값**이고
 *        동점 tie-break 이 `hi120` 우선이라 **1등픽에 대형 돌파가 몰린다**. 고분산 모멘텀 베팅이 1등에 쏠린 것.
 *     H3 진짜로 tie-break(시총순)에 정보가 있다.
 *
 * ═══ 판정 (사전 선언) ═══
 *   Q1 **같은 날 안에서** pick1 − pick3 짝차이 > 2×SE 여야 H3 이 산다(H1 제거).
 *   Q2 **같은 sub 안에서** pick1 우위가 유지돼야 H3 이 산다(H2 제거).
 *   Q1·Q2 둘 다 통과해야 "랭킹 1등에 정보가 있다". 하나라도 죽으면 1차 결과는 교란이다.
 */
import { readFileSync } from 'fs';

const file = process.argv[2] ?? 'dump-rank-slots5.json';
const d = JSON.parse(readFileSync(file, 'utf8'));
const trades = d.books['combo-v2'].trades.filter(t => t.ctx?.pick != null);
const retOf = (t) => t.pnl / (t.entry * t.qty) * 100;
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const sd = (a) => { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const se = (a) => (a.length ? sd(a) / Math.sqrt(a.length) : 0);

console.log(`=== 교란 제거 · n=${trades.length} · ${d.from}~${d.to} ===\n`);

// ── Q1: 같은 날 안에서 짝비교 (H1 제거) ────────────────────────
const byDay = new Map();
for (const t of trades) { if (!byDay.has(t.day)) byDay.set(t.day, []); byDay.get(t.day).push(t); }

for (const [lo, hi, label] of [[1, 2, '1등 vs 2등'], [1, 3, '1등 vs 3등']]) {
  const pairs = [];
  for (const [, g] of byDay) {
    const a = g.find(t => t.ctx.pick === lo), b = g.find(t => t.ctx.pick === hi);
    if (a && b) pairs.push(retOf(a) - retOf(b));
  }
  const m = avg(pairs), s = se(pairs);
  console.log(`Q1 ${label} · 같은 날 짝 ${pairs.length}쌍 · 평균 차이 ${m >= 0 ? '+' : ''}${m.toFixed(3)}%p · 2×SE ${(2 * s).toFixed(3)} → ${m > 2 * s ? '유의(1등 우위)' : Math.abs(m) < 2 * s ? '유의하지 않음' : '유의(1등 열위)'}`);
}

// ── Q2: sub 별 분해 (H2 제거) ─────────────────────────────────
console.log(`\n=== Q2 · sub 별 분해 ===`);
console.log('sub      픽   n     거래당수익률      SD   승률');
console.log('─'.repeat(52));
for (const sub of ['hi120', 'rsi2']) {
  for (const [k, label] of [[1, '1등'], [2, '2등'], [3, '3등↓']]) {
    const g = trades.filter(t => t.sub === sub && (k === 3 ? t.ctx.pick >= 3 : t.ctx.pick === k));
    if (!g.length) { console.log(`${sub.padEnd(8)} ${label.padEnd(4)} ${'0'.padStart(4)}          —`); continue; }
    const r = g.map(retOf);
    console.log(`${sub.padEnd(8)} ${label.padEnd(4)} ${String(g.length).padStart(4)} ${avg(r).toFixed(3).padStart(11)}% ${sd(r).toFixed(2).padStart(7)} ${(Math.round(g.filter(t => t.pnl > 0).length / g.length * 100) + '%').padStart(5)}`);
  }
}

// sub 구성비 (H2 의 핵심 근거)
console.log(`\n=== 픽 순번별 sub 구성비 (H2 검정) ===`);
for (const k of [1, 2, 3]) {
  const g = trades.filter(t => k === 3 ? t.ctx.pick >= 3 : t.ctx.pick === k);
  const h = g.filter(t => t.sub === 'hi120').length;
  console.log(`  ${k === 3 ? '3등↓' : k + '등'} n=${String(g.length).padStart(4)} · hi120 ${(h / g.length * 100).toFixed(1)}% · rsi2 ${((g.length - h) / g.length * 100).toFixed(1)}%`);
}

// 1등픽 hi120 의 돌파폭 vs 나머지 hi120
const bp = (t) => Number(t.ctx.breakoutPct);
const h1 = trades.filter(t => t.sub === 'hi120' && t.ctx.pick === 1).map(bp).filter(Number.isFinite);
const h2 = trades.filter(t => t.sub === 'hi120' && t.ctx.pick >= 2).map(bp).filter(Number.isFinite);
console.log(`\n  hi120 돌파폭 평균: 1등픽 ${avg(h1).toFixed(2)}% (n=${h1.length}) vs 2등↓ ${avg(h2).toFixed(2)}% (n=${h2.length})`);

// ── Q3(참고): 같은 날 · 같은 sub 짝비교 = 두 교란 동시 제거 ────
console.log(`\n=== Q3 · 같은 날 ∧ 같은 sub 짝비교 (교란 2개 동시 제거) ===`);
for (const sub of ['hi120', 'rsi2']) {
  const pairs = [];
  for (const [, g] of byDay) {
    const s = g.filter(t => t.sub === sub).sort((a, b) => a.ctx.pick - b.ctx.pick);
    if (s.length >= 2) pairs.push(retOf(s[0]) - retOf(s[s.length - 1]));
  }
  const m = avg(pairs), sE = se(pairs);
  console.log(`  ${sub.padEnd(6)} 짝 ${String(pairs.length).padStart(3)}쌍 · 최상위−최하위 ${m >= 0 ? '+' : ''}${m.toFixed(3)}%p · 2×SE ${(2 * sE).toFixed(3)} → ${Math.abs(m) > 2 * sE ? (m > 0 ? '유의(상위 우위)' : '유의(상위 열위)') : '유의하지 않음'}`);
}
