/**
 * research-neutral-strength.mjs — "지금(NEUTRAL 레짐) 강한 종목을 사면 어떻게 되나"의 기대값 측정
 * 2026-07-27, 사용자 요청("지금 산다고 치면 어떻게 되는지 보고싶어")에 대한 정직한 답.
 *
 * scan-1m-now.mjs의 B안 조건을 **일봉으로 재현**해 3.4년 전체 유니버스에 소급 적용한다.
 *   (1분봉 자체는 백테 불가 — stock_prices_1m이 top30·2026-07-24 이후뿐)
 * 진입조건(D일 종가 기준, 전부 D일까지 데이터만 사용):
 *   레짐 NEUTRAL(005930 MA20/60, 라이브와 동일) · 종가>MA20 · 종가>시가
 *   · 종가가 당일 고저구간 상위 40%(일중위치 프록시) · 20일 상대강세>0 · 20일 거래대금≥30억
 * 집행: D+1 시가 진입 → 라이브 청산룰(하드 -7% / 고점대비 트레일 -6% / +6%·+12% 절반씩 부분익절 / 최대 10일)
 * 비교군: **같은 날짜** 유동성통과 전 종목 랜덤(날짜매칭 베이스라인) — 2026-07-24 PEAD 교훈
 * 한계: 현재 상장 종목만(생존편향) → 절대 수익률은 낙관, 상대 비교만 신뢰.
 */
import { createReadStream } from 'fs';
import readline from 'readline';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const POS_MIN = Number(argOf('--posmin', 0.6));   // 종가 일중위치 하한
const CRASH = Number(argOf('--crash', 0));
const REGIME = String(argOf('--regime', 'NEUTRAL'));        // 시장 20일 수익률 ≤ -N% 구간만 (0=전체 NEUTRAL). 오늘은 -29.8%
const MIN_TURNOVER = 30e8, TRAIL = 6, HARD = 7, TP1 = 6, TP2 = 12, MAXHOLD = 10;

const C = new Map();
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream('candles-daily.jsonl') });
  rl.on('line', (l) => { if (!l.trim()) return; try { const j = JSON.parse(l); if (j.c?.length >= 200) C.set(j.code, j); } catch {} });
  rl.on('close', res);
});
const mkt = C.get('005930');
const idx = new Map(mkt.d.map((d, i) => [d, i]));
const dates = mkt.d.filter(d => d >= '20230102');
console.log(`종목 ${C.size} · 대상일 ${dates.length}일 (${dates[0]}~${dates.at(-1)})`);

// 레짐(라이브 동일): 종가>MA20 && MA20>MA60 = UP / 종가<MA20 && 5일<-3% = DOWN / else NEUTRAL
const regimeOf = (di) => {
  const c = mkt.c;
  const avg = (n) => { let s = 0; for (let k = di - n + 1; k <= di; k++) s += c[k]; return s / n; };
  const ma20 = avg(20), ma60 = avg(60), ret5 = (c[di] / c[di - 5] - 1) * 100;
  if (c[di] > ma20 && ma20 > ma60) return 'UP';
  if (c[di] < ma20 && ret5 < -3) return 'DOWN';
  return 'NEUTRAL';
};

/** 진입 후 라이브 청산룰로 경로 시뮬레이션 → 총수익률(%) */
function simulate(j, e) {   // e = 진입 인덱스(D+1)
  const entry = j.o[e];
  if (!(entry > 0)) return null;
  let hi = entry, qty = 1, realized = 0, tp1 = false, tp2 = false;
  for (let i = e; i < Math.min(j.c.length, e + MAXHOLD + 1); i++) {
    const c = j.c[i];
    hi = Math.max(hi, c);
    const ret = (c / entry - 1) * 100;
    if (i > e) {                                    // 진입 당일은 청산 판정 제외(라이브 동일)
      if (ret <= -HARD) return realized + qty * -HARD;
      if (!tp1 && ret >= TP1) { realized += 0.5 * TP1; qty -= 0.5; tp1 = true; }
      else if (tp1 && !tp2 && ret >= TP2) { realized += 0.25 * TP2; qty -= 0.25; tp2 = true; }
      else if (c <= hi * (1 - TRAIL / 100)) return realized + qty * ret;
      if (i === e + MAXHOLD) return realized + qty * ret;
    }
  }
  const last = j.c[Math.min(j.c.length - 1, e + MAXHOLD)];
  return realized + qty * ((last / entry - 1) * 100);
}

// 날짜별 레짐·시장 20일수익률 사전계산 (종목 루프를 밖으로 빼서 O(전체봉)으로 처리)
const dayInfo = new Map();
for (const day of dates) {
  const di = idx.get(day);
  if (di == null || di < 130 || di + 1 >= mkt.d.length) continue;
  if (REGIME !== 'all' && regimeOf(di) !== REGIME) continue;
  const mret20 = mkt.c[di] / mkt.c[di - 20] - 1;
  if (CRASH > 0 && mret20 > -CRASH / 100) continue;
  dayInfo.set(day, mret20);
}
const nDays = dayInfo.size;

const hash = (s) => { let h = 2166136261; for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619); } return h >>> 0; };
const sig = [], sample = new Map();   // sample: day → 해시 최소 8종목(날짜매칭 랜덤 표본)
for (const [code, j] of C) {
  for (let i = 130; i + 1 < j.c.length; i++) {
    const mret20 = dayInfo.get(j.d[i]);
    if (mret20 == null) continue;
    let tv = 0; for (let k = i - 19; k <= i; k++) tv += j.c[k] * j.v[k];
    if (tv / 20 < MIN_TURNOVER) continue;
    // 날짜매칭 베이스라인 표본: 같은 날 유동성통과 풀에서 해시 기준 8종목
    const h = hash(code + j.d[i]);
    let arr = sample.get(j.d[i]); if (!arr) sample.set(j.d[i], arr = []);
    if (arr.length < 8) { arr.push({ h, j, i }); arr.sort((a, b) => a.h - b.h); }
    else if (h < arr[7].h) { arr[7] = { h, j, i }; arr.sort((a, b) => a.h - b.h); }
    // 신호
    let ma20 = 0; for (let k = i - 19; k <= i; k++) ma20 += j.c[k];
    ma20 /= 20;
    const rng = j.h[i] - j.l[i];
    const pos = rng > 0 ? (j.c[i] - j.l[i]) / rng : 0.5;
    const rs20 = (j.c[i] / j.c[i - 20] - 1) - mret20;
    if (j.c[i] > ma20 && j.c[i] > j.o[i] && pos >= POS_MIN && rs20 > 0) {
      const r = simulate(j, i + 1);
      if (r != null) sig.push(r);
    }
  }
}
const base = [];
for (const arr of sample.values()) for (const { j, i } of arr) { const r = simulate(j, i + 1); if (r != null) base.push(r); }

const stat = (a) => {
  if (!a.length) return 'n=0';
  const avg = a.reduce((s, v) => s + v, 0) / a.length;
  const win = a.filter(v => v > 0).length / a.length * 100;
  const s = [...a].sort((x, y) => x - y);
  const gp = a.filter(v => v > 0).reduce((s2, v) => s2 + v, 0), gl = -a.filter(v => v < 0).reduce((s2, v) => s2 + v, 0);
  return `n=${a.length} 평균 ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}% 승률 ${win.toFixed(0)}% 중위 ${s[Math.floor(s.length / 2)].toFixed(2)}% PF ${gl > 0 ? (gp / gl).toFixed(2) : '∞'} 최악 ${s[0].toFixed(1)}%`;
};
console.log(`\nNEUTRAL 대상일 ${nDays}일${CRASH > 0 ? ` (시장 20일 ≤ -${CRASH}% 구간만)` : ''} · 일중위치 ≥ ${POS_MIN}`);
console.log(`신호(강세+상대강세): ${stat(sig)}`);
console.log(`베이스라인(날짜매칭 랜덤): ${stat(base)}`);
const d = sig.length && base.length ? (sig.reduce((s, v) => s + v, 0) / sig.length) - (base.reduce((s, v) => s + v, 0) / base.length) : null;
console.log(`→ 초과수익: ${d == null ? 'n/a' : (d >= 0 ? '+' : '') + d.toFixed(2) + '%p'} (거래당, 같은 날 랜덤 대비)`);
