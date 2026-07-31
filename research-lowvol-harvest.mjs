/**
 * research-lowvol-harvest.mjs — 저변동성 신호를 5슬롯 계좌에서 수확할 수 있는가 (2026-07-31)
 *
 * ═══ 배경 ═══
 * research-ic.mjs 에서 측정 가능한 최강 신호는 저변동성이었다:
 *   atrPct 20일 IC -0.1244 · t -23.2 · 십분위 스프레드 -1.979% · 4년 부호 일관
 *   (2위권 volRatio t +9.6, 현행 전략 핵심 rsi2 t -6.2 — 저변동성이 3~4배 강하다)
 * 그런데 과거 수확 시도는 전부 실패했다: `--rsiatrrank`(확신도 동률 내 ATR 오름차순) Calmar **0.70** 최하위,
 * `--rsiatrmax 5`(고ATR 배제) 0.79. **왜 실패했는지는 규명되지 않았다.**
 *
 * ═══ 네 가지 불일치 가설 ═══
 *   ① 방향  — 신호는 십분위 **스프레드**(저변동 롱 − 고변동 숏)로 측정됐다. 봇은 롱온리 = 절반만.
 *   ② 분산  — 십분위는 40~100종목 동일가중. 봇은 **5종목**.
 *   ③ 지평  — 20~60일에서 최강(5일 t -14.7 < 20일 -23.2). 봇 rsi2 만기는 **5거래일**.
 *   ④ 모집단 — 신호는 유니버스 전체에서 측정됐다. 봇은 **rsi2 조건(2일 연속 하락) 통과 종목만** 본다.
 *
 * ═══ 세 실험 ═══
 * [실험 1] 롱온리 분해 — 최저ATR 십분위의 **절대 초과수익**(vs 유니버스 동일가중 평균).
 *          스프레드 중 롱 쪽 몫이 실현 가능 상한이다. 숏 쪽에만 있으면 롱온리로는 못 먹는다.
 * [실험 2] 종목수 열화 — 최저ATR N종목 동일가중, h일 리밸런싱. N=50/30/20/10/5.
 *          포트폴리오 기계(슬롯·현금·복리·청산규칙)를 **쓰지 않는다** — 분산 부족 효과만 격리한다.
 *          왕복비용 0.33%p 를 리밸런싱마다 차감해 실현 기준으로 본다.
 * [실험 3] 모집단 상호작용 — atrPct IC 를 **rsi2 신호 종목으로 제한**해 재측정, 전체와 비교.
 *          사라지면 ④가 과거 실패의 원인이고, 남으면 원인은 ①②③ 쪽이다.
 *
 * 판정에는 오늘 확립한 규율을 그대로 쓴다: 귀무 대조군(결정적 노이즈) · Newey-West · 비중복표본.
 * atrPct 는 일별 갱신이라 재무 팩터만큼 심한 자기상관은 없지만, 전방수익 겹침(h일)은 그대로 있다.
 *
 * 한계: 생존편향(현재 상장분) · 비용은 왕복 0.33%p 고정 가정(실제 스프레드·미체결 미반영)
 *       · 동일가중 이론 바스켓이라 호가단위·최소수량 제약 없음(5종목 구간에서 실제로는 더 나쁘다).
 *
 * 실행: node --max-old-space-size=6144 research-lowvol-harvest.mjs
 */
import { createReadStream } from 'fs';
import readline from 'readline';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const CANDLES = String(argOf('--candles', 'candles-daily-toss-clean.jsonl'));
const MIN_TOV = Number(argOf('--minturnover', 3e9));
const FROM = String(argOf('--from', '20230102'));
const COST = Number(argOf('--cost', 0.33));          // 왕복 %p (수수료 0.03 + 거래세 0.15 + 슬리피지)
const HORIZONS = [5, 20, 60];
const NS = [50, 30, 20, 10, 5];
const MIN_STOCKS = 100;

// ── 데이터 ───────────────────────────────────────────────────────────────────
const C = [];
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream(CANDLES), crlfDelay: Infinity });
  rl.on('line', (l) => { if (!l.trim()) return; try { const j = JSON.parse(l); if (j.c?.length >= 200) C.push(j); } catch {} });
  rl.on('close', res);
});
const idxOf = new Map(C.map(j => [j.code, new Map(j.d.map((d, i) => [String(d), i]))]));
const allDays = [...new Set(C.flatMap(j => j.d.map(String)))].filter(d => d >= FROM).sort();
console.log(`종목 ${C.length} · 거래일 ${allDays.length} · ${CANDLES} · 비용 왕복 ${COST}%p\n`);

const atrPct = (j, i) => { let t = 0; for (let k = i - 13; k <= i; k++) t += Math.max(j.h[k] - j.l[k], Math.abs(j.h[k] - j.c[k - 1]), Math.abs(j.l[k] - j.c[k - 1])); return (t / 14) / j.c[i]; };
const rsi2f = (j, i) => { let u = 0, d = 0; for (let k = i - 1; k <= i; k++) { const ch = j.c[k] - j.c[k - 1]; if (ch > 0) u += ch; else d -= ch; } return u + d === 0 ? 50 : u / (u + d) * 100; };
const h32 = (a, b) => { let x = (a * 374761393 + b * 668265263) | 0; x = (x ^ (x >>> 13)) * 1274126177 | 0; return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };
const seedOf = (c) => { let h = 0; for (const ch of String(c)) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; };
const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
const sd = (x) => { const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, x.length - 1)); };
const tval = (x) => (x.length < 3 ? 0 : (sd(x) > 0 ? mean(x) / (sd(x) / Math.sqrt(x.length)) : 0));
const tvalNW = (x, L) => {
  const n = x.length; if (n < 10) return 0;
  const m = mean(x);
  const g = (l) => { let s = 0; for (let i = l; i < n; i++) s += (x[i] - m) * (x[i - l] - m); return s / n; };
  let v = g(0); const LL = Math.min(L, n - 2);
  for (let l = 1; l <= LL; l++) v += 2 * (1 - l / (LL + 1)) * g(l);
  return v > 0 ? m / Math.sqrt(v / n) : 0;
};
const spearman = (xs, ys) => {
  const n = xs.length; if (n < 20) return null;
  const rank = (a) => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Float64Array(n); o.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rx = rank(xs), ry = rank(ys);
  let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += rx[i]; my += ry[i]; } mx /= n; my /= n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
};

// ── 일별 횡단면 수집 ─────────────────────────────────────────────────────────
// day → { rows:[{code,atr,rsi,fw:[h별]}] }
const byDay = new Map();
for (const day of allDays) {
  const rows = [];
  for (const j of C) {
    const i = idxOf.get(j.code).get(day);
    if (i == null || i < 130) continue;
    if (i + Math.max(...HORIZONS) >= j.d.length) continue;
    let to = 0; for (let k = i - 19; k <= i; k++) to += j.c[k] * (j.v?.[k] ?? 0);
    if (to / 20 < MIN_TOV) continue;
    const a = atrPct(j, i);
    if (!(a > 0) || a > 0.5) continue;
    rows.push({ code: j.code, atr: a, rsi: rsi2f(j, i), fw: HORIZONS.map(h => (j.c[i + h] / j.c[i] - 1) * 100) });
  }
  if (rows.length >= MIN_STOCKS) byDay.set(day, rows);
}
const days = [...byDay.keys()];
console.log(`유효 거래일 ${days.length}일 · 일평균 종목 ${Math.round(mean(days.map(d => byDay.get(d).length)))}\n`);

// ── 실험 1: 롱온리 분해 ──────────────────────────────────────────────────────
console.log('=== 실험 1: 저변동성 십분위의 롱온리 초과수익 분해 ===');
console.log('지평   유니버스평균   최저ATR십분위   최고ATR십분위  |  롱 초과   숏 초과   스프레드');
console.log('─'.repeat(92));
HORIZONS.forEach((h, hi) => {
  const uni = [], lo = [], hiD = [];
  for (const d of days) {
    const r = byDay.get(d);
    const s = [...r].sort((a, b) => a.atr - b.atr);
    const k = Math.max(1, Math.floor(s.length / 10));
    uni.push(mean(r.map(x => x.fw[hi])));
    lo.push(mean(s.slice(0, k).map(x => x.fw[hi])));
    hiD.push(mean(s.slice(-k).map(x => x.fw[hi])));
  }
  const u = mean(uni), L = mean(lo), H = mean(hiD);
  console.log(`${String(h).padStart(3)}일  ${(u.toFixed(3) + '%').padStart(11)}  ${(L.toFixed(3) + '%').padStart(13)}  ${(H.toFixed(3) + '%').padStart(13)}  |  ${((L - u).toFixed(3) + '%p').padStart(8)} ${((u - H).toFixed(3) + '%p').padStart(8)} ${((L - H).toFixed(3) + '%p').padStart(9)}`);
});
console.log('※ 롱 초과 = 최저ATR십분위 − 유니버스평균. 이것이 **롱온리로 실현 가능한 상한**이다.');
console.log('※ 숏 초과 = 유니버스평균 − 최고ATR십분위. 롱온리로는 먹을 수 없는 몫.\n');

// ── 실험 2: 종목수 열화 곡선 ─────────────────────────────────────────────────
console.log('=== 실험 2: 최저ATR N종목 동일가중 · h일 리밸런싱 (비용 차감) ===');
console.log('지평   N    기간수  평균수익/기간  비용후   승률   표준편차   Sharpe(기간)  NW-t');
console.log('─'.repeat(94));
HORIZONS.forEach((h, hi) => {
  for (const N of NS) {
    const rets = [];
    for (let di = 0; di < days.length; di += h) {          // 비중복 리밸런싱
      const r = byDay.get(days[di]);
      if (r.length < N * 2) continue;
      const s = [...r].sort((a, b) => a.atr - b.atr).slice(0, N);
      rets.push(mean(s.map(x => x.fw[hi])));
    }
    if (rets.length < 8) continue;
    const m = mean(rets), net = m - COST, s2 = sd(rets);
    const win = rets.filter(v => v - COST > 0).length / rets.length * 100;
    console.log(`${String(h).padStart(3)}일 ${String(N).padStart(3)} ${String(rets.length).padStart(7)}  ${(m.toFixed(3) + '%').padStart(11)} ${(net.toFixed(3) + '%').padStart(8)} ${(win.toFixed(0) + '%').padStart(6)} ${(s2.toFixed(2) + '%').padStart(9)} ${(s2 > 0 ? (net / s2).toFixed(3) : '-').padStart(12)} ${tvalNW(rets.map(v => v - COST), 1).toFixed(1).padStart(6)}`);
  }
  console.log('');
});
console.log('※ 표준편차가 N 감소와 함께 커지는 폭이 **분산 부족의 대가**다.');
console.log('※ 5종목에서 Sharpe 가 무너지면 과거 실패의 원인이 ② 분산이다.\n');

// ── 실험 3: 모집단 상호작용 (rsi2 신호 내부에서 저변동성이 살아있나) ─────────
console.log('=== 실험 3: atrPct IC — 전체 유니버스 vs rsi2 신호(RSI2<10) 종목 한정 ===');
console.log('지평   전체 IC    NW-t     n       |  rsi2한정 IC   NW-t     n      일평균종목  |  귀무 IC');
console.log('─'.repeat(100));
HORIZONS.forEach((h, hi) => {
  const icAll = [], icSub = [], icNull = [], subN = [];
  for (const d of days) {
    const r = byDay.get(d);
    const a = spearman(r.map(x => x.atr), r.map(x => x.fw[hi]));
    if (a != null) icAll.push(a);
    const nl = spearman(r.map(x => h32(seedOf(x.code), hi + 1)), r.map(x => x.fw[hi]));
    if (nl != null) icNull.push(nl);
    const sub = r.filter(x => x.rsi < 10);
    if (sub.length >= 20) {
      const b = spearman(sub.map(x => x.atr), sub.map(x => x.fw[hi]));
      if (b != null) { icSub.push(b); subN.push(sub.length); }
    }
  }
  const f = (a) => `${mean(a).toFixed(4).padStart(8)} ${tvalNW(a, h).toFixed(1).padStart(7)} ${String(a.length).padStart(6)}`;
  console.log(`${String(h).padStart(3)}일 ${f(icAll)}  | ${f(icSub)}  ${Math.round(mean(subN)).toString().padStart(8)}  | ${mean(icNull).toFixed(4).padStart(8)}`);
});
console.log('※ rsi2 한정에서 IC 가 사라지면 --rsiatrrank 실패의 원인이 ④ 모집단이다.');
console.log('※ 남아 있으면 실패 원인은 ①롱온리·②분산·③지평 쪽이고, 순서 재배치로는 못 먹는다는 뜻이다.');
