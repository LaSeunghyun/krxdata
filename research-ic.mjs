/**
 * research-ic.mjs — 처음부터 다시: 횡단면 예측력 연구 (2026-07-29)
 *
 * ═══ 왜 다시 시작하는가 ═══
 * 오늘 "전략 X를 파라미터 P로" 형태의 가설 35변종이 전패했다. 실패 원인이 파라미터가 아니라
 * **연구 설계**였다: 진입·청산·슬롯·자본제약·복리가 얽혀 있어 무엇이 신호이고 무엇이 구현인지
 * 분리되지 않았고, 그 결합된 자유도가 매번 국면에 과적합됐다.
 *
 * ═══ 세 가지를 바꾼다 ═══
 * ① 가설 형태: "이 전략이 버나" → **"어떤 특징이 미래 수익을 예측하나, 얼마나"**
 *    전략 이전의 질문이다. 예측력이 없으면 어떤 청산 규칙으로도 만들 수 없다.
 * ② 시뮬레이션: 포트폴리오 백테 → **없앤다.** 매일 횡단면 순위 → 십분위 스프레드.
 *    슬롯·자본·복리·청산규칙이 전부 빠지므로 신호가 구현과 분리된다. 과적합할 자유도가 없다.
 * ③ 집계: CAGR/MDD 점추정 → **분포와 안정성.** 일별 스프레드 시계열의 평균·t값·연도별 IC·
 *    보유지평별 감쇠. 그리고 **다중비교를 명시**한다(특징×지평 개수 → 우연 기대 건수).
 *
 * ═══ 한계 (정직히) ═══
 * · 생존편향: 풀이 현재 상장분. 폐지 종목 부재 → 절대 수치는 낙관. 제거 불가(가격이력 없음).
 * · 거래비용 미반영: 스프레드는 비용 전이다. 왕복 0.33%p + 스프레드를 넘어야 실현 가능.
 * · 십분위는 동일가중 이론 포트폴리오다. 실제 체결·유동성 제약은 다음 단계에서 본다.
 * · 특징은 모두 **그 시점까지의 데이터만** 쓴다(i일 종가까지). forward는 i+1 이후.
 *
 * 실행: node research-ic.mjs [--minturnover 3e9] [--from 20230102]
 */
import { createReadStream } from 'fs';
import readline from 'readline';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const MIN_TOV = Number(argOf('--minturnover', 3e9));   // 유동성 하한 (실현 가능성)
// ★ 2026-07-31 수정: 기본 데이터를 **정제본**으로 바꿨다. 원본 candles-daily.jsonl 에는
//   Toss 캐시의 가짜 가격점프 18종목(최대 30배)이 들어 있다(2026-07-30 발견 — 권리변동 미반영으로
//   시계열 내부에 -97% 같은 허위 급락이 생긴다). IC 연구에서 그건 ret20/distMA 계열을 통째로 오염시킨다.
const CANDLES = String(argOf('--candles', 'candles-daily-toss-clean.jsonl'));
const FROM = String(argOf('--from', '20230102'));
const HORIZONS = [1, 3, 5, 10, 20];
const MIN_STOCKS = 100;                                 // 그날 횡단면 최소 종목수

// ── 데이터 로드 ──────────────────────────────────────────────────────────────
const C = [];
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream(CANDLES) });
  rl.on('line', (l) => { if (!l.trim()) return; try { const j = JSON.parse(l); if (j.c?.length >= 200) C.push(j); } catch {} });
  rl.on('close', res);
});
console.log(`종목 ${C.length.toLocaleString()} 로드 · 유동성 하한 ${(MIN_TOV / 1e8).toFixed(0)}억 · 지평 ${HORIZONS.join('/')}일\n`);

// 전체 거래일 축 (가장 긴 종목 기준)
const allDays = [...new Set(C.flatMap(j => j.d))].filter(d => d >= FROM).sort();
const dayIdx = new Map(allDays.map((d, i) => [d, i]));
console.log(`거래일 ${allDays.length}일 (${allDays[0]} ~ ${allDays.at(-1)})`);

/**
 * 특징 라이브러리 — 전부 **i일 종가까지의 데이터만** 사용(lookahead 없음).
 * 부호는 "값이 클수록 미래수익이 높다고 가정"하는 방향으로 맞춰 놓지 않는다 —
 * IC의 부호 자체가 결과이므로 원래 정의대로 계산한다.
 */
const FEATURES = {
  rsi2:      (j, i) => { let u = 0, d = 0; for (let k = i - 1; k <= i; k++) { const ch = j.c[k] - j.c[k - 1]; if (ch > 0) u += ch; else d -= ch; } return u + d === 0 ? 50 : u / (u + d) * 100; },
  rsi14:     (j, i) => { let u = 0, d = 0; for (let k = i - 13; k <= i; k++) { const ch = j.c[k] - j.c[k - 1]; if (ch > 0) u += ch; else d -= ch; } return u + d === 0 ? 50 : u / (u + d) * 100; },
  ret1:      (j, i) => j.c[i] / j.c[i - 1] - 1,
  ret5:      (j, i) => j.c[i] / j.c[i - 5] - 1,
  ret20:     (j, i) => j.c[i] / j.c[i - 20] - 1,
  ret60:     (j, i) => j.c[i] / j.c[i - 60] - 1,
  volRatio:  (j, i) => { let a = 0; for (let k = i - 20; k < i; k++) a += j.v[k]; return a > 0 ? j.v[i] / (a / 20) : 1; },
  atrPct:    (j, i) => { let t = 0; for (let k = i - 13; k <= i; k++) t += Math.max(j.h[k] - j.l[k], Math.abs(j.h[k] - j.c[k - 1]), Math.abs(j.l[k] - j.c[k - 1])); return (t / 14) / j.c[i]; },
  pos20:     (j, i) => { let hi = -Infinity, lo = Infinity; for (let k = i - 19; k <= i; k++) { if (j.h[k] > hi) hi = j.h[k]; if (j.l[k] < lo) lo = j.l[k]; } return hi > lo ? (j.c[i] - lo) / (hi - lo) : 0.5; },
  pos120:    (j, i) => { let hi = -Infinity, lo = Infinity; for (let k = i - 119; k <= i; k++) { if (j.h[k] > hi) hi = j.h[k]; if (j.l[k] < lo) lo = j.l[k]; } return hi > lo ? (j.c[i] - lo) / (hi - lo) : 0.5; },
  distMA20:  (j, i) => { let s = 0; for (let k = i - 19; k <= i; k++) s += j.c[k]; return j.c[i] / (s / 20) - 1; },
  distMA60:  (j, i) => { let s = 0; for (let k = i - 59; k <= i; k++) s += j.c[k]; return j.c[i] / (s / 60) - 1; },
  closeLoc:  (j, i) => (j.h[i] > j.l[i] ? (j.c[i] - j.l[i]) / (j.h[i] - j.l[i]) : 0.5),
  gap:       (j, i) => j.o[i] / j.c[i - 1] - 1,
  vol20:     (j, i) => { let s = 0, m = 0; for (let k = i - 19; k <= i; k++) m += j.c[k] / j.c[k - 1] - 1; m /= 20; for (let k = i - 19; k <= i; k++) { const r = j.c[k] / j.c[k - 1] - 1; s += (r - m) ** 2; } return Math.sqrt(s / 20); },
  turnover:  (j, i) => { let t = 0; for (let k = i - 19; k <= i; k++) t += j.c[k] * j.v[k]; return Math.log(t / 20 + 1); },
};
// ★ 2026-07-31 추가: **귀무 대조군.** 다중비교 건수만 세면 "우연 기대 N개" 상한만 알 뿐,
//   |IC|·t·스프레드가 무신호에서 실제로 어디까지 흔들리는지는 모른다. 순수 노이즈 특징을
//   **같은 파이프라인**에 통과시켜 그 바닥을 직접 측정한다(포트폴리오 MC 의 교란 대조군과 같은 역할).
//   결정적 해시라 재현 가능하다 — Math.random 이면 재실행마다 바닥이 달라진다.
const h32 = (a, b) => { let x = (a * 374761393 + b * 668265263) | 0; x = (x ^ (x >>> 13)) * 1274126177 | 0; return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };
const codeSeed = (j) => { let h = 0; for (const ch of String(j.code)) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; };
FEATURES.NULL_a = (j, i) => h32(codeSeed(j), i);
FEATURES.NULL_b = (j, i) => h32(codeSeed(j) ^ 0x5bf03635, i * 7 + 1);
FEATURES.NULL_c = (j, i) => h32(codeSeed(j) + 99991, i * 13 + 5);
const NAMES = Object.keys(FEATURES);

/** Spearman 상관 (순위 기반). 동순위는 평균순위로 처리하지 않음 — 표본이 크고 연속값이라 영향 미미 */
function spearman(xs, ys) {
  const n = xs.length;
  if (n < 20) return null;
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Float64Array(a.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rx = rank(xs), ry = rank(ys);
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += rx[i]; my += ry[i]; }
  mx /= n; my /= n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : null;
}

// ── 특징별 · 지평별 IC와 십분위 스프레드 ────────────────────────────────────
// 성능: 종목별로 한 번만 순회해 **일자 버킷에 적립**한다. 날짜 루프 안에서 indexOf를 부르면
//   O(종목×일자×일자)로 폭발한다(초기 구현의 버그). 여기선 O(종목×일자).
const results = [];
for (const fname of NAMES) {
  const fn = FEATURES[fname];
  // 일자 → { xs, fw[h][] }
  const bucket = new Map();
  for (const j of C) {
    const n = j.c.length;
    // 20일 거래대금 롤링
    let tov = 0;
    for (let i = 0; i < n; i++) {
      tov += j.c[i] * j.v[i];
      if (i >= 20) tov -= j.c[i - 20] * j.v[i - 20];
      if (i < 130) continue;
      const day = j.d[i];
      if (day < FROM) continue;
      if (tov / 20 < MIN_TOV) continue;
      const v = fn(j, i);
      if (!Number.isFinite(v)) continue;
      let bad = false;
      const f = [];
      for (const h of HORIZONS) { if (i + h >= n) { bad = true; break; } f.push(j.c[i + h] / j.c[i] - 1); }
      if (bad) continue;
      let b = bucket.get(day);
      if (!b) bucket.set(day, b = { xs: [], fw: HORIZONS.map(() => []) });
      b.xs.push(v);
      f.forEach((x, hi) => b.fw[hi].push(x));
    }
  }
  const perH = HORIZONS.map(() => ({ ics: [], spreads: [], byYear: new Map() }));
  for (const [day, b] of [...bucket.entries()].sort()) {
    if (b.xs.length < MIN_STOCKS) continue;
    const yr = day.slice(0, 4);
    HORIZONS.forEach((h, hi) => {
      const ic = spearman(b.xs, b.fw[hi]);
      if (ic == null) return;
      perH[hi].ics.push(ic);
      const ord = b.xs.map((v, i2) => [v, b.fw[hi][i2]]).sort((a, c) => a[0] - c[0]);
      const k = Math.max(1, Math.floor(ord.length / 10));
      const lo = ord.slice(0, k).reduce((s, p) => s + p[1], 0) / k;
      const hi2 = ord.slice(-k).reduce((s, p) => s + p[1], 0) / k;
      perH[hi].spreads.push(hi2 - lo);
      if (!perH[hi].byYear.has(yr)) perH[hi].byYear.set(yr, []);
      perH[hi].byYear.get(yr).push(ic);
    });
  }
  results.push({ fname, perH });
  process.stdout.write('.');
}
console.log('');

// ── 보고 ────────────────────────────────────────────────────────────────────
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const tstat = (a) => (a.length > 1 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);

console.log('=== 횡단면 예측력 (Spearman IC, 일별 → 평균·t값) ===');
console.log('특징        지평   일수    IC평균    t값     십분위스프레드   연도별 IC 부호');
console.log('─'.repeat(96));
const flat = [];
for (const { fname, perH } of results) {
  HORIZONS.forEach((h, hi) => {
    const p = perH[hi];
    if (!p.ics.length) return;
    const ic = mean(p.ics), t = tstat(p.ics), sp = mean(p.spreads) * 100;
    const yrs = [...p.byYear.entries()].sort().map(([y, a]) => (mean(a) >= 0 ? '+' : '−'));
    const consistent = yrs.every(s => s === yrs[0]);
    flat.push({ fname, h, ic, t, sp, consistent, nDays: p.ics.length, yrs: yrs.join('') });
  });
}
flat.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
for (const r of flat.slice(0, 30)) {
  console.log(`${r.fname.padEnd(11)} ${String(r.h).padStart(3)}일 ${String(r.nDays).padStart(5)}  ${(r.ic >= 0 ? '+' : '') + r.ic.toFixed(4)}  ${(r.t >= 0 ? '+' : '') + r.t.toFixed(1).padStart(6)}   ${((r.sp >= 0 ? '+' : '') + r.sp.toFixed(2) + '%').padStart(9)}      ${r.yrs}${r.consistent ? ' ✓일관' : ''}`);
}

const N = flat.length;
const sig = flat.filter(r => Math.abs(r.t) >= 3);
const cons = sig.filter(r => r.consistent);
console.log(`\n=== 다중비교 정직성 ===`);
console.log(`검정 수: 특징 ${NAMES.length} × 지평 ${HORIZONS.length} = ${N}개`);
console.log(`|t| ≥ 3 (p<0.003): ${sig.length}개 · 우연 기대 ${(N * 0.0027).toFixed(1)}개`);
console.log(`그 중 **연도별 IC 부호가 전부 일치**: ${cons.length}개  ← 국면 안정성까지 통과한 것`);
// ★ 2026-07-31: 귀무 바닥 판정. NULL_* 의 |IC|·|t|·|스프레드| 최대값이 무신호 상한이다.
const nullRows = flat.filter(r => r.fname.startsWith('NULL_'));
const realRows = flat.filter(r => !r.fname.startsWith('NULL_'));
if (nullRows.length) {
  const mx = (k) => Math.max(...nullRows.map(r => Math.abs(r[k])));
  const icF = mx('ic'), tF = mx('t'), spF = mx('sp');
  console.log(`
=== 귀무 바닥 (NULL 특징 ${nullRows.length}건 = 노이즈만) ===`);
  console.log(`|IC| 최대 ${icF.toFixed(4)} · |t| 최대 ${tF.toFixed(2)} · |십분위스프레드| 최대 ${spF.toFixed(4)}%`);
  const pass = realRows.filter(r => Math.abs(r.ic) > icF && Math.abs(r.t) > tF && Math.abs(r.sp) > spF);
  console.log(`실제 특징 중 **세 지표 모두 귀무 바닥 초과**: ${pass.length}/${realRows.length}건`);
  for (const r of pass.sort((a, b) => Math.abs(b.t) - Math.abs(a.t)).slice(0, 15)) {
    console.log(`  ${r.fname.padEnd(10)} ${String(r.h).padStart(2)}일  IC ${r.ic.toFixed(4)}  t ${r.t.toFixed(1)}  스프레드 ${r.sp.toFixed(3)}%  연도부호 ${r.consistent ? '일치' : '불일치'} (${r.yrs})`);
  }
  if (!pass.length) console.log(`  없음 — 이 특징집합에서 노이즈를 넘는 예측력이 검출되지 않았다.`);
}
console.log(`\n※ IC는 비용 전이다. 왕복 0.33%p + 스프레드를 넘어야 실현 가능하다.`);
console.log(`※ 십분위 스프레드가 지평별로 어떻게 감쇠하는지가 보유기간의 근거가 된다.`);
console.log(`※ 생존편향: 풀이 현재 상장분 → 절대 수치는 낙관. 상대 순위 비교엔 영향 작다.`);
