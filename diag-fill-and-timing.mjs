/**
 * diag-fill-and-timing.mjs — ① 크로싱 스프레드 1.0% 회수 가능성 ② 진입 시각별 성적 (2026-07-29)
 *
 * 배경: 왕복 마찰 약 1.33%가 전략과 무관한 확정 손실이다.
 *   매수 limitBuyPx = 현재가 × 1.005 / 매도 limitSellPx = 현재가 × 0.995 → 스프레드 1.0%
 *   + 수수료·거래세 0.33%. 오늘 청산 15회면 그것만 계좌 -1.5%.
 *   크로싱 지정가를 쓰는 이유는 NXT가 시장가를 거부하기 때문인데, **+0.5% 대신 현재가에 걸면
 *   얼마나 체결되는지 측정한 적이 없다.**
 *
 * ★ 핵심 주의: 미체결은 공짜가 아니다. 소극적 지정가는 오르는 종목을 놓친다.
 *   그래서 체결률만 재면 안 되고 **미체결 건의 이후 경로**까지 재야 한다. 놓친 게 승자였다면
 *   0.5% 절약이 더 큰 손실로 돌아온다. 아래 '미체결 기회비용'이 그 측정이다.
 *
 * 체결 모델(보수적): 지정가 매수는 **가격이 그 수준까지 내려와야** 체결된다고 본다.
 *   현재가 px에 걸면 이후 N분 내 low <= px 여야 체결. 호가창이 없으니 즉시체결을 가정하지 않는다.
 *   크로싱(px×1.005)은 즉시 체결로 본다(현재 라이브 동작 그대로).
 *
 * ② 진입 시각: 백테는 **종가**에 사고 라이브는 **장중 아무 때나** 산다. 이 괴리는 미측정이었다.
 *   힌트: 07-29 진단에서 진입가가 직전 30분 구간의 63% 지점(무작위 28%)이었다.
 *
 * 실행: node diag-fill-and-timing.mjs [--wait 15] [--hold 5]
 */
import { createReadStream, readdirSync, readFileSync } from 'fs';
import readline from 'readline';
import { join } from 'path';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DIR = 'data-1m';
const WAITS = [5, 15, 30, 60];              // 지정가 대기 시간(분) 후보
const HOLD = Number(argOf('--hold', 5));    // 보유 거래일 (combo-v2 maxHoldR)
const TIMES = [900, 930, 1000, 1030, 1100, 1130, 1300, 1330, 1400, 1500];
const RSI_MAX = 10, VOL_MIN = 1.25, COST = 0.33;
const CROSS = 1.005;                        // 현재 라이브 매수 프리미엄
const TRAIL = 6, HARD = 7;                  // 청산(rsi2는 하드+MA3지만 여기선 진입 비교가 목적 → 단순 트레일/하드)

const KST = (s) => new Date(s * 1000 + 9 * 3_600_000);
const dayOf = (s) => KST(s).toISOString().slice(0, 10).replace(/-/g, '');
const hmOf = (s) => { const d = KST(s); return d.getUTCHours() * 100 + d.getUTCMinutes(); };

const NEED = new Set(readdirSync(DIR).filter(f => f.endsWith('.jsonl')).map(f => f.replace('.jsonl', '')));
NEED.add('005930');
const HIST = new Map();
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream('candles-daily.jsonl') });
  rl.on('line', (l) => {
    const m = l.slice(0, 40).match(/"code"\s*:\s*"(\d{6})"/);
    if (!m || !NEED.has(m[1])) return;
    try { const j = JSON.parse(l); if (j.c?.length >= 200) HIST.set(j.code, j); } catch {}
  });
  rl.on('close', res);
});
const mkt = HIST.get('005930');
const mIdx = new Map(mkt.d.map((d, i) => [d, i]));
console.log(`일봉 ${HIST.size}종목 · 대기 후보 ${WAITS.join('/')}분 · 보유 ${HOLD}일 · 비용 ${COST}%p\n`);

const rsi2At = (c, i) => { let u = 0, d = 0; for (let j = i - 1; j <= i; j++) { const ch = c[j] - c[j - 1]; if (ch > 0) u += ch; else d -= ch; } return u + d === 0 ? 50 : u / (u + d) * 100; };
function regimeAt(mi) {
  if (mi < 60) return null;
  let a = 0, b = 0;
  for (let k = mi - 19; k <= mi; k++) a += mkt.c[k];
  for (let k = mi - 59; k <= mi; k++) b += mkt.c[k];
  a /= 20; b /= 60;
  const r5 = (mkt.c[mi] / mkt.c[mi - 5] - 1) * 100;
  if (mkt.c[mi] > a && a > b) return 'UP';
  if (mkt.c[mi] < a && r5 < -3) return 'DOWN';
  return 'NEUTRAL';
}
/** 진입 후 청산 (트레일/하드/만기) — 진입가 대비 손익% */
function fwdExit(days, si, bi, entry) {
  let hi = entry;
  for (let di = si; di < Math.min(days.length, si + HOLD); di++) {
    const bars = days[di].bars;
    for (let k = (di === si ? bi + 1 : 0); k < bars.length; k++) {
      const b = bars[k];
      const lv = Math.max(entry * (1 - HARD / 100), hi * (1 - TRAIL / 100));
      if (b.l <= lv) return (Math.min(lv, b.o) / entry - 1) * 100 - COST;
      if (b.h > hi) hi = b.h;
    }
    if (di === si + HOLD - 1 || di === days.length - 1) return (bars.at(-1).c / entry - 1) * 100 - COST;
  }
  return null;
}

// 집계 구조
const byTime = new Map();                    // 시각 → {n, sum, win}
const fill = new Map();                      // 대기분 → {n, filled, savedSum, passSum, crossSum, missSum, missN}
for (const w of WAITS) fill.set(w, { n: 0, filled: 0, passSum: 0, crossSum: 0, missSum: 0, missN: 0 });
let nSig = 0, nSkipStock = 0;

for (const f of readdirSync(DIR).filter(f => f.endsWith('.jsonl'))) {
  const code = f.replace('.jsonl', '');
  const j = HIST.get(code);
  if (!j) continue;
  let o;
  try { o = JSON.parse(readFileSync(join(DIR, f), 'utf8').split('\n')[0]); } catch { continue; }
  if (!o.t?.length) continue;

  const dmap = new Map();
  for (let i = 0; i < o.t.length; i++) {
    const d = dayOf(o.t[i]);
    let a = dmap.get(d);
    if (!a) dmap.set(d, a = []);
    a.push({ hm: hmOf(o.t[i]), o: o.o[i], h: o.h[i], l: o.l[i], c: o.c[i] });
  }
  const days = [...dmap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, bars]) => ({ day, bars }));
  const dayIdx = new Map(days.map((d, i) => [d.day, i]));
  const jIdx = new Map(j.d.map((d, i) => [d, i]));

  // 수정주가 불일치 종목 제외 (2026-07-29 확인된 함정: 234개 중 6개)
  { let n = 0, mm = 0; for (const dd of days) { const k = jIdx.get(dd.day); if (k == null) continue; const r = dd.bars.at(-1).c / j.c[k]; n++; if (r < 0.95 || r > 1.05) mm++; } if (n < 10 || mm / n > 0.05) { nSkipStock++; continue; } }

  for (let i = 200; i < j.c.length - 1; i++) {
    if (rsi2At(j.c, i) >= RSI_MAX) continue;
    let v20 = 0; for (let k = i - 19; k <= i; k++) v20 += j.v[k];
    if (!(v20 > 0) || j.v[i] / (v20 / 20) < VOL_MIN) continue;
    const mi = mIdx.get(j.d[i]);
    const rg = mi == null ? null : regimeAt(mi);
    if (rg == null || rg === 'NEUTRAL') continue;
    const si = dayIdx.get(j.d[i + 1]);
    if (si == null) continue;
    nSig++;
    const bars = days[si].bars;

    // ── ② 진입 시각별 (크로싱 진입 = 현재 라이브 동작) ──
    for (const T of TIMES) {
      const bi = bars.findIndex(b => b.hm >= T);
      if (bi < 0) continue;
      const px = bars[bi].c;
      if (!(px > 0)) continue;
      const r = fwdExit(days, si, bi, px * CROSS);
      if (r == null) continue;
      let g = byTime.get(T);
      if (!g) byTime.set(T, g = { n: 0, sum: 0, win: 0 });
      g.n++; g.sum += r; if (r > 0) g.win++;
    }

    // ── ① 스프레드: 10:00 기준 크로싱 vs 소극적 지정가 ──
    const bi0 = bars.findIndex(b => b.hm >= 1000);
    if (bi0 < 0) continue;
    const px0 = bars[bi0].c;
    if (!(px0 > 0)) continue;
    const rCross = fwdExit(days, si, bi0, px0 * CROSS);
    if (rCross == null) continue;
    for (const w of WAITS) {
      const acc = fill.get(w);
      acc.n++; acc.crossSum += rCross;
      // 지정가 px0 — 이후 w분 내 저가가 px0 이하로 내려오면 체결
      let hitAt = -1;
      for (let k = bi0 + 1; k <= Math.min(bi0 + w, bars.length - 1); k++) { if (bars[k].l <= px0) { hitAt = k; break; } }
      if (hitAt >= 0) {
        const rP = fwdExit(days, si, hitAt, px0);
        if (rP != null) { acc.filled++; acc.passSum += rP; }
      } else {
        acc.missN++; acc.missSum += rCross;   // 놓친 거래가 크로싱으로는 얼마였나 = 기회비용
      }
    }
  }
}

const f2 = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
console.log(`수정주가 불일치 제외 ${nSkipStock}종목 · rsi2 신호 ${nSig.toLocaleString()}건\n`);

console.log('=== ② 진입 시각별 성적 (크로싱 +0.5% 진입, 트레일6/하드7/만기5일, 비용차감) ===');
console.log('시각    표본     평균손익   승률');
for (const T of TIMES) {
  const g = byTime.get(T);
  if (!g) continue;
  console.log(`${String(T).padStart(4)}  ${String(g.n).padStart(6)}   ${f2(g.sum / g.n).padStart(7)}%  ${(g.win / g.n * 100).toFixed(1).padStart(5)}%`);
}
console.log('※ 백테는 종가(1520 근처) 진입을 가정한다. 라이브는 장중 아무 때나 산다 — 그 차이가 여기 보인다.');

console.log('\n=== ① 크로싱(+0.5%) vs 소극적 지정가(현재가) ===');
console.log('대기   표본   체결률    크로싱평균   지정가평균(체결분)  미체결 기회비용   순효과');
for (const w of WAITS) {
  const a = fill.get(w);
  if (!a.n) continue;
  const fr = a.filled / a.n * 100;
  const cAvg = a.crossSum / a.n;
  const pAvg = a.filled ? a.passSum / a.filled : 0;
  const missAvg = a.missN ? a.missSum / a.missN : 0;
  // 순효과: 지정가 전략 전체 기대값(체결분만 거래, 미체결은 0) − 크로싱 전체 기대값
  const netPass = a.filled ? (a.passSum / a.n) : 0;   // 미체결은 0으로 계산(거래 안 함)
  console.log(`${String(w).padStart(3)}분 ${String(a.n).padStart(6)}  ${fr.toFixed(1).padStart(5)}%   ${f2(cAvg).padStart(8)}%   ${f2(pAvg).padStart(12)}%   ${f2(missAvg).padStart(11)}%   ${f2(netPass - cAvg).padStart(7)}%p`);
}
console.log('\n※ 순효과 = (지정가 전략 전체 기대값, 미체결은 거래 0) − (크로싱 전체 기대값)');
console.log('※ 미체결 기회비용이 크게 +면 놓친 게 승자였다는 뜻 = 스프레드 절약보다 손실이 크다.');
