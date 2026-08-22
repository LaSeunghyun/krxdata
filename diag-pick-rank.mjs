/**
 * diag-pick-rank.mjs — 2026-08-07 · "몰빵의 전제"를 직접 재는 계측
 *
 * 질문: 몰빵(자본을 1종목에 전액)은 **1등 픽의 거래당 기대값이 2·3등보다 높을 때만** 의미가 있다.
 *   1등 ≈ 3등이면 집중은 수익을 안 올리고 분산만 키운다(= 이번 MC 에서 실제로 관측된 모양).
 *
 * ═══ 판정 기준 (사전 선언 — 실행 후 수정 금지) ═══
 *  P1 pick1 거래당 수익률 − pick3+ 거래당 수익률 > **2 × SE(차이)** 이어야 "1등이 낫다"고 말한다.
 *     SE 는 **일자 클러스터**로 잰다 — 같은 날 픽들은 시장요인을 공유하므로 순진 SE 는 과소추정이다(§1-C).
 *  P2 그 부호가 **연도 4개 중 3개 이상** 일치해야 한다(단일 국면 아티팩트 배제).
 *  P3 conviction 동점률(같은 날 최고확신도 후보가 복수)이 50% 를 넘으면, 랭킹이 사실상
 *     tie-break(시총순)로 결정된다는 뜻이므로 P1 통과 여부와 무관하게 "선별력 없음"으로 기록한다.
 *
 * 입력: backtest-swing.mjs --dump 산출 JSON (ctx.rank·ctx.pick·ctx.cands 필요 — 2026-08-07 계측 추가분)
 * 사용: node diag-pick-rank.mjs dump-rank-slots5.json
 */
import { readFileSync } from 'fs';

const file = process.argv[2] ?? 'dump-rank-slots5.json';
const d = JSON.parse(readFileSync(file, 'utf8'));
const trades = d.books['combo-v2'].trades.filter(t => t.ctx?.pick != null);
if (!trades.length) { console.error('⛔ ctx.pick 이 없는 덤프다 (계측 전 산출물). 재실행 필요.'); process.exit(1); }

const retOf = (t) => t.pnl / (t.entry * t.qty) * 100;   // 거래당 수익률 % (사이즈 차이 제거)
const yearOf = (t) => t.day.slice(0, 4);

console.log(`=== 픽 순번별 거래당 성적 · ${d.from}~${d.to} · n=${trades.length} ===\n`);

// ── 1) 픽 순번별 ──────────────────────────────────────────────
const byPick = new Map();
for (const t of trades) {
  const k = Math.min(t.ctx.pick, 6);
  if (!byPick.has(k)) byPick.set(k, []);
  byPick.get(k).push(t);
}
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const sd = (a) => { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

console.log('픽 순번    n     거래당수익률   승률    SD    평균보유  누적손익(원)');
console.log('─'.repeat(72));
for (const k of [...byPick.keys()].sort((a, b) => a - b)) {
  const g = byPick.get(k), r = g.map(retOf);
  console.log(`${(k === 6 ? '6등+' : k + '등픽').padEnd(8)} ${String(g.length).padStart(5)} ${avg(r).toFixed(3).padStart(11)}% ${(Math.round(g.filter(t => t.pnl > 0).length / g.length * 100) + '%').padStart(7)} ${sd(r).toFixed(2).padStart(6)} ${avg(g.map(t => t.hold)).toFixed(1).padStart(7)}일 ${Math.round(g.reduce((s, t) => s + t.pnl, 0)).toLocaleString().padStart(13)}`);
}

// ── 2) P1: pick1 vs pick3+ · 일자 클러스터 SE ─────────────────
const A = trades.filter(t => t.ctx.pick === 1);
const B = trades.filter(t => t.ctx.pick >= 3);
// 일자별 평균으로 축약한 뒤 그 분포로 SE (클러스터 로버스트의 단순형)
const dayMean = (arr) => {
  const m = new Map();
  for (const t of arr) { const k = t.day; if (!m.has(k)) m.set(k, []); m.get(k).push(retOf(t)); }
  return [...m.values()].map(avg);
};
const dA = dayMean(A), dB = dayMean(B);
const seA = sd(dA) / Math.sqrt(dA.length), seB = sd(dB) / Math.sqrt(dB.length);
const diff = avg(dA) - avg(dB);
const seDiff = Math.sqrt(seA ** 2 + seB ** 2);

console.log(`\n=== P1 · 1등픽 vs 3등픽이하 (일자 클러스터 SE) ===`);
console.log(`  1등픽   일자평균 ${avg(dA).toFixed(3)}% (일수 ${dA.length}, SE ${seA.toFixed(3)})`);
console.log(`  3등픽↓  일자평균 ${avg(dB).toFixed(3)}% (일수 ${dB.length}, SE ${seB.toFixed(3)})`);
console.log(`  차이 ${diff >= 0 ? '+' : ''}${diff.toFixed(3)}%p · 2×SE ${(2 * seDiff).toFixed(3)}`);
const p1 = diff > 2 * seDiff;
console.log(`  → P1 ${p1 ? '통과: 1등이 실제로 낫다' : '미통과: 1등이 3등보다 낫다는 증거 없음'}`);
// 순진 SE 도 병기 — 얼마나 부풀려지는지 보여준다
const nsA = sd(A.map(retOf)) / Math.sqrt(A.length), nsB = sd(B.map(retOf)) / Math.sqrt(B.length);
console.log(`  (참고) 순진 SE 로는 2×SE ${(2 * Math.sqrt(nsA ** 2 + nsB ** 2)).toFixed(3)} — 클러스터 보정 전`);

// ── 3) P2: 연도별 부호 일관성 ─────────────────────────────────
console.log(`\n=== P2 · 연도별 (1등픽 − 3등픽↓) ===`);
const years = [...new Set(trades.map(yearOf))].sort();
let pos = 0;
for (const y of years) {
  const a = A.filter(t => yearOf(t) === y).map(retOf), b = B.filter(t => yearOf(t) === y).map(retOf);
  const dy = avg(a) - avg(b);
  if (dy > 0) pos++;
  console.log(`  ${y}  1등 ${avg(a).toFixed(3)}% (n=${a.length})  vs 3등↓ ${avg(b).toFixed(3)}% (n=${b.length})  → ${dy >= 0 ? '+' : ''}${dy.toFixed(3)}%p`);
}
const p2 = pos >= Math.ceil(years.length * 0.75);
console.log(`  → P2 ${p2 ? '통과' : '미통과'}: 양수 ${pos}/${years.length}년`);

// ── 4) P3: 랭킹의 해상도 — conviction 동점률 ───────────────────
const byDay = new Map();
for (const t of trades) { const k = t.day; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(t); }
let multi = 0, tied = 0;
for (const [, g] of byDay) {
  if (g.length < 2) continue;
  multi++;
  const cs = g.map(t => Number(t.ctx.conviction));
  if (Math.max(...cs) === Math.min(...cs)) tied++;
}
const tieRate = multi ? tied / multi * 100 : 0;
console.log(`\n=== P3 · 랭킹 해상도 (같은 날 매수분의 conviction 동점) ===`);
console.log(`  2건 이상 매수한 날 ${multi}일 중 **전원 동점** ${tied}일 = ${tieRate.toFixed(1)}%`);
const cvCount = new Map();
for (const t of trades) { const c = t.ctx.conviction; cvCount.set(c, (cvCount.get(c) ?? 0) + 1); }
const top = [...cvCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
console.log(`  conviction 값 분포 상위: ${top.map(([c, n]) => `${c}→${n}건(${(n / trades.length * 100).toFixed(0)}%)`).join(' · ')}`);
console.log(`  하루 후보수 중앙값 ${(() => { const s = trades.map(t => t.ctx.cands).sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; })()}건`);
console.log(`  → P3 ${tieRate > 50 ? '선별력 없음: 랭킹이 사실상 tie-break(시총순)으로 결정된다' : '동점률 50% 이하 — 랭킹이 구분은 한다'}`);

console.log(`\n=== 종합 ===`);
console.log(`  몰빵 전제(1등이 3등보다 낫다): ${p1 && p2 ? '성립' : '불성립'} (P1 ${p1 ? 'O' : 'X'} · P2 ${p2 ? 'O' : 'X'} · P3 ${tieRate > 50 ? '해상도 없음' : '해상도 있음'})`);
