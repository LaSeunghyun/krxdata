#!/usr/bin/env node
/**
 * diag-scalp-edge.mjs — 인트라데이 신호의 **총엣지 상한** 측정 (2026-08-04)
 *
 * ── 왜 필요한가 ───────────────────────────────────────────────────────────────
 * `backtest-scalp5m.mjs` 의 결론은 TP/SL 격자를 어떻게 잡았느냐에 의존해 보인다. 그 의존을 없앤다.
 * 어떤 익절·손절을 쓰든 **신호 직후 평균 포워드수익을 넘는 이익은 만들 수 없다**(마틴게일·피라미딩은
 * 분산을 바꿀 뿐 평균을 못 바꾼다). 그래서 조건부 평균수익 − 무조건부 평균수익 = **총엣지 상한**이고,
 * 이걸 왕복 마찰 0.42% 와 직접 비교하면 손익비 선택과 무관한 판정이 나온다.
 *
 * ── 산출 ──────────────────────────────────────────────────────────────────────
 *   신호별 · 호라이즌(5/15/30/60/120분)별:
 *     조건부 평균수익 · 무조건부(같은 시간대) 평균수익 · 엣지(%p) · 승률 · 표본수
 *   무조건부 기준선은 **같은 시각 분포**에서 뽑는다(시간대 효과가 엣지로 둔갑하지 않게).
 *
 * 실행: node diag-scalp-edge.mjs [--tf 5] [--limit N]
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, 'candles-1m.jsonl');
const ARGV = process.argv.slice(2);
const argOf = (f, d) => { const i = ARGV.indexOf(f); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };

const TF = Number(argOf('--tf', 5));
const LIMIT = Number(argOf('--limit', 0));
const COST = Number(argOf('--cost', 0.42));
const HORIZONS = [5, 15, 30, 60, 120, 180, 240, 380];  // 분 (380 = 세션 전체)
const SESSION_START = '0900', SESSION_END = '1510';

const hm = (t) => t.slice(11, 13) + t.slice(14, 16);
const day = (t) => t.slice(0, 10);

function aggregate(b1, tf) {
  if (tf === 1) return b1.map((b, i) => ({ ...b, i0: i }));
  const out = []; let cur = null;
  for (let i = 0; i < b1.length; i++) {
    const b = b1[i];
    const key = day(b.t) + hm(b.t).slice(0, 2) + Math.floor(Number(hm(b.t).slice(2)) / tf);
    if (!cur || cur.key !== key) { if (cur) out.push(cur); cur = { key, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, i0: i }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
  }
  if (cur) out.push(cur);
  return out;
}
function rsiAt(c, i, n) {
  if (i < n) return 50;
  let up = 0, dn = 0;
  for (let j = i - n + 1; j <= i; j++) { const ch = c[j] - c[j - 1]; if (ch > 0) up += ch; else dn -= ch; }
  return up + dn === 0 ? 50 : (up / (up + dn)) * 100;
}

const SIGNALS = {
  'dipk3':    (b, i, x) => i >= 3 && b[i].c < b[i - 1].c && b[i - 1].c < b[i - 2].c && b[i - 2].c < b[i - 3].c,
  'dipk3c':   (b, i, x) => i >= 4 && b[i - 1].c < b[i - 2].c && b[i - 2].c < b[i - 3].c && b[i - 3].c < b[i - 4].c && b[i].c > b[i].o,
  'vwap1.0c': (b, i, x) => x.vwap[i] > 0 && b[i].c / x.vwap[i] - 1 <= -0.01 && b[i].c > b[i].o,
  'vwap2.0c': (b, i, x) => x.vwap[i] > 0 && b[i].c / x.vwap[i] - 1 <= -0.02 && b[i].c > b[i].o,
  'rsi20c':   (b, i, x) => i >= 15 && rsiAt(x.closes, i - 1, 14) < 20 && b[i].c > b[i].o,
  'bb2.0c':   (b, i, x) => {
    if (i < 21) return false;
    const w = x.closes.slice(i - 20, i);
    const m = w.reduce((a, v) => a + v, 0) / w.length;
    const sd = Math.sqrt(w.reduce((a, v) => a + (v - m) ** 2, 0) / w.length);
    return sd > 0 && b[i - 1].c < m - 2 * sd && b[i].c > b[i].o;
  },
  // 상승 계열도 넣는다 — 평균회귀만 보면 "엣지 없음"이 계열 선택 탓일 수 있다
  'up3':      (b, i, x) => i >= 3 && b[i].c > b[i - 1].c && b[i - 1].c > b[i - 2].c && b[i - 2].c > b[i - 3].c,
  'vwapup1c': (b, i, x) => x.vwap[i] > 0 && b[i].c / x.vwap[i] - 1 >= 0.01 && b[i].c > b[i].o,
};
const NAMES = Object.keys(SIGNALS);

// 누적: 신호별·호라이즌별 수익 / 시간대별 무조건부 수익
const acc = {};
for (const n of NAMES) { acc[n] = {}; for (const h of HORIZONS) acc[n][h] = []; }
const base = {};   // base[hm][h] = [] 같은 시각 무조건부 표본
for (const h of HORIZONS) base[h] = new Map();

let nStock = 0, nUsed = 0;
const rl = createInterface({ input: createReadStream(FILE) });
for await (const line of rl) {
  if (!line.trim()) continue;
  if (LIMIT && nStock >= LIMIT) break;
  let j; try { j = JSON.parse(line); } catch { continue; }
  nStock++;
  const b1 = [...j.bars].reverse();
  if (b1.length < 500) continue;
  nUsed++;
  const bars = aggregate(b1, TF);
  const closes = bars.map(b => b.c);
  const vwap = new Array(bars.length).fill(0);
  { let d = null, pv = 0, vv = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (day(b.t) !== d) { d = day(b.t); pv = 0; vv = 0; }
      const t3 = (b.h + b.l + b.c) / 3; pv += t3 * b.v; vv += b.v; vwap[i] = vv > 0 ? pv / vv : 0;
    } }
  const ctx = { vwap, closes };

  for (let i = 1; i < bars.length - 1; i++) {
    const t = hm(bars[i].t);
    if (t < SESSION_START || t > SESSION_END) continue;
    if (day(bars[i + 1].t) !== day(bars[i].t)) continue;
    const eIdx = bars[i + 1].i0;              // 다음 봉 시가 진입 (look-ahead 차단)
    const ePx = b1[eIdx].o;
    if (!(ePx > 0)) continue;
    // 호라이즌별 포워드수익 (같은 날 안에서만)
    const fwd = {};
    for (const h of HORIZONS) {
      const k = eIdx + h;
      fwd[h] = (k < b1.length && day(b1[k].t) === day(b1[eIdx].t)) ? (b1[k].c / ePx - 1) * 100 : null;
    }
    // 무조건부 기준선 (같은 시각 버킷)
    for (const h of HORIZONS) {
      if (fwd[h] == null) continue;
      if (!base[h].has(t)) base[h].set(t, { s: 0, n: 0 });
      const o = base[h].get(t); o.s += fwd[h]; o.n++;
    }
    // 신호별
    for (const n of NAMES) {
      let fire = false;
      try { fire = SIGNALS[n](bars, i, ctx); } catch { fire = false; }
      if (!fire) continue;
      for (const h of HORIZONS) if (fwd[h] != null) acc[n][h].push({ r: fwd[h], t });
    }
  }
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
console.log('=== 인트라데이 신호 총엣지 상한 (손익비 무관) ===');
console.log(`TF ${TF}분 · ${nUsed}종목 · 세션 ${SESSION_START}~${SESSION_END} · 왕복 마찰 ${COST}%\n`);
console.log(`${'신호'.padEnd(10)}${'H(분)'.padStart(6)}${'n'.padStart(9)}${'조건부%'.padStart(10)}${'무조건부%'.padStart(11)}${'엣지%p'.padStart(10)}${'승률'.padStart(8)}${'비용대비'.padStart(10)}`);
for (const n of NAMES) {
  for (const h of HORIZONS) {
    const rows = acc[n][h];
    if (rows.length < 100) continue;
    const cond = avg(rows.map(r => r.r));
    // 같은 시각 분포로 가중한 무조건부 기준선 — 시간대 효과 제거
    let bs = 0, bn = 0;
    for (const r of rows) { const o = base[h].get(r.t); if (o && o.n) { bs += o.s / o.n; bn++; } }
    const unc = bn ? bs / bn : NaN;
    const edge = cond - unc;
    const wr = rows.filter(r => r.r > 0).length / rows.length * 100;
    console.log(
      `${n.padEnd(10)}${String(h).padStart(6)}${String(rows.length).padStart(9)}` +
      `${((cond >= 0 ? '+' : '') + cond.toFixed(4)).padStart(10)}${((unc >= 0 ? '+' : '') + unc.toFixed(4)).padStart(11)}` +
      `${((edge >= 0 ? '+' : '') + edge.toFixed(4)).padStart(10)}${(wr.toFixed(1) + '%').padStart(8)}` +
      `${(Math.abs(edge) >= COST ? '★초과' : `1/${(COST / Math.abs(edge)).toFixed(0)}`).padStart(10)}`);
  }
}
console.log(`\n※ '비용대비' = 엣지가 왕복 마찰의 몇 분의 1인가. **초과**가 하나도 없으면`);
console.log(`  어떤 TP/SL 을 쓰든 순기대값은 음수다 — 손익비는 분산 배분을 바꿀 뿐 평균을 못 바꾼다.`);
