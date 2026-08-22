#!/usr/bin/env node
/**
 * diag-scalp-edge2.mjs — 5분 스캘핑 엣지 2차 탐색: 극단이격·거래량·시간대·횡단면 (2026-08-04)
 *
 * ── 1차(diag-scalp-edge.mjs)의 한계 ──────────────────────────────────────────
 * 8개 신호계열이 전부 **개별종목 시계열의 완만한 평균회귀**였다(VWAP −1~2%, RSI<20, BB 2σ, 연속음봉).
 * 5분 호라이즌 최대 엣지가 +0.0014%p(비용의 1/294)로 나왔지만, 안 재본 축이 넷 있었다:
 *   ① 극단 이격 (−3/−5/−8%) — 1차는 −2% 에서 멈췄다. 드물지만 반등폭이 클 수 있다.
 *   ② 거래량 급증 — 1차엔 거래량 신호가 아예 없었다. 촉매는 대개 거래량으로 먼저 드러난다.
 *   ③ 시간대 — 1차는 09:00~15:10 을 균일 취급했다. 개장·마감 구간은 동역학이 다르다.
 *   ④ 횡단면 — 1차는 전부 자기 시계열 기준. 같은 순간 시장 대비 상대이격은 다른 정보다.
 *
 * ④ 는 2패스가 필요하다: 1패스에서 **분 단위 횡단면 평균수익(시장요인)**을 만들고,
 * 2패스에서 잔차이격을 신호로 쓴다. 시장요인을 안 빼면 "같이 떨어진 것"과 "혼자 떨어진 것"이 안 갈린다.
 *
 * 판정 기준은 1차와 동일: **조건부 − 무조건부(같은 시각) 포워드수익 = 총엣지 상한**.
 * 손익비를 어떻게 잡든 이 값을 못 넘는다.
 *
 * 실행: node diag-scalp-edge2.mjs [--tf 5] [--limit N]
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
const HORIZONS = [3, 5, 10, 15, 30];
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

// ══ 1패스: 분 단위 횡단면 평균수익(시장요인) ═══════════════════
// key = "YYYY-MM-DD HHMM" → {s, n}. TF봉 종가 수익률의 횡단면 평균.
const mkt = new Map();
{
  let n = 0;
  const rl = createInterface({ input: createReadStream(FILE) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (LIMIT && n >= LIMIT) break;
    let j; try { j = JSON.parse(line); } catch { continue; }
    n++;
    const bars = aggregate([...j.bars].reverse(), TF);
    for (let i = 1; i < bars.length; i++) {
      if (day(bars[i].t) !== day(bars[i - 1].t)) continue;
      const r = bars[i - 1].c > 0 ? bars[i].c / bars[i - 1].c - 1 : null;
      if (r == null || !Number.isFinite(r)) continue;
      const k = day(bars[i].t) + ' ' + hm(bars[i].t);
      const o = mkt.get(k) ?? { s: 0, n: 0 };
      o.s += r; o.n++; mkt.set(k, o);
    }
  }
  console.log(`[1패스] 시장요인 ${mkt.size.toLocaleString()} 시점 산출 (${n}종목)`);
}
const mktRet = (k) => { const o = mkt.get(k); return o && o.n >= 20 ? o.s / o.n : null; };

// ══ 2패스: 신호 평가 ═══════════════════════════════════════════
/**
 * 신호는 전부 "지금 사면 이득인가"를 묻는 롱 전용이다(리테일 공매도 불가).
 * xs* = 횡단면 잔차 기준. 시장이 같이 빠진 날의 하락은 개별 정보가 아니다.
 */
const SIGNALS = {
  'vwap3c':   (b, i, x) => x.vwap[i] > 0 && b[i].c / x.vwap[i] - 1 <= -0.03 && b[i].c > b[i].o,
  'vwap5c':   (b, i, x) => x.vwap[i] > 0 && b[i].c / x.vwap[i] - 1 <= -0.05 && b[i].c > b[i].o,
  'vwap8c':   (b, i, x) => x.vwap[i] > 0 && b[i].c / x.vwap[i] - 1 <= -0.08 && b[i].c > b[i].o,
  // 거래량 급증 + 하락 (투매 소진 가설)
  'volspike5dn': (b, i, x) => x.vr[i] >= 5 && b[i].c < b[i].o,
  'volspike10dn': (b, i, x) => x.vr[i] >= 10 && b[i].c < b[i].o,
  // 거래량 급증 + 상승 (촉매 추종 가설)
  'volspike5up': (b, i, x) => x.vr[i] >= 5 && b[i].c > b[i].o,
  // 극단 급락 후 반전확인 (봉 자체 −3% 이상)
  'crash3c':  (b, i, x) => i >= 1 && b[i - 1].c > 0 && b[i - 1].c / b[i - 1].o - 1 <= -0.03 && b[i].c > b[i].o,
  // ── 횡단면 잔차 ──
  'xs2':      (b, i, x) => x.resid[i] != null && x.resid[i] <= -0.02,
  'xs3':      (b, i, x) => x.resid[i] != null && x.resid[i] <= -0.03,
  'xs2c':     (b, i, x) => x.resid[i] != null && x.resid[i] <= -0.02 && b[i].c > b[i].o,
  // 극단이격 × 시간대. 1차 실측에서 개장30분 엣지가 −0.458 로 최악이라 그 구간을 뺀 형태를 따로 잰다.
  'vwap5c_noopen': (b, i, x) => x.vwap[i] > 0 && b[i].c / x.vwap[i] - 1 <= -0.05 && b[i].c > b[i].o && hm(b[i].t) >= '0930',
  'vwap5c_am':     (b, i, x) => x.vwap[i] > 0 && b[i].c / x.vwap[i] - 1 <= -0.05 && b[i].c > b[i].o && hm(b[i].t) >= '0930' && hm(b[i].t) < '1300',
  'vwap8c_noopen': (b, i, x) => x.vwap[i] > 0 && b[i].c / x.vwap[i] - 1 <= -0.08 && b[i].c > b[i].o && hm(b[i].t) >= '0930',
  'vwap10c':       (b, i, x) => x.vwap[i] > 0 && b[i].c / x.vwap[i] - 1 <= -0.10 && b[i].c > b[i].o,
  // ★ 2차에서 유일하게 비용을 넘은 축 = 횡단면 잔차 × 오전. 정밀 측정을 위해 등급·시간대를 신호로 편입.
  'xs3_am':   (b, i, x) => x.resid[i] != null && x.resid[i] <= -0.03 && hm(b[i].t) >= '0930' && hm(b[i].t) < '1130',
  'xs4_am':   (b, i, x) => x.resid[i] != null && x.resid[i] <= -0.04 && hm(b[i].t) >= '0930' && hm(b[i].t) < '1130',
  'xs5_am':   (b, i, x) => x.resid[i] != null && x.resid[i] <= -0.05 && hm(b[i].t) >= '0930' && hm(b[i].t) < '1130',
  'xs3_amwide': (b, i, x) => x.resid[i] != null && x.resid[i] <= -0.03 && hm(b[i].t) >= '0900' && hm(b[i].t) < '1300',
  'xs4':      (b, i, x) => x.resid[i] != null && x.resid[i] <= -0.04,
  'xs5':      (b, i, x) => x.resid[i] != null && x.resid[i] <= -0.05,
};
const NAMES = Object.keys(SIGNALS);
// 시간대 버킷: 개장30분 / 오전 / 점심 / 오후 / 마감30분
const seg = (t) => (t < '0930' ? '개장30분' : t < '1130' ? '오전' : t < '1300' ? '점심' : t < '1440' ? '오후' : '마감30분');
const SEGS = ['개장30분', '오전', '점심', '오후', '마감30분'];

const acc = {};   // acc[sig][h] = {n,sum} · accSeg[sig][h][seg]
for (const n of NAMES) { acc[n] = {}; for (const h of HORIZONS) acc[n][h] = { n: 0, sum: 0, wins: 0, bySeg: {} }; }
const base = {};  // base[h] = Map(hm → {s,n})
for (const h of HORIZONS) base[h] = new Map();

let nStock = 0, nUsed = 0;
{
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
    const vwap = new Array(bars.length).fill(0);
    const vr = new Array(bars.length).fill(1);
    const resid = new Array(bars.length).fill(null);
    { let d = null, pv = 0, vv = 0;
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        if (day(b.t) !== d) { d = day(b.t); pv = 0; vv = 0; }
        const t3 = (b.h + b.l + b.c) / 3; pv += t3 * b.v; vv += b.v; vwap[i] = vv > 0 ? pv / vv : 0;
        // 거래량비 = 직전 20봉 평균 대비
        if (i >= 20) {
          let s = 0; for (let k = i - 20; k < i; k++) s += bars[k].v;
          const m = s / 20; vr[i] = m > 0 ? bars[i].v / m : 1;
        }
        // 횡단면 잔차 = 자기 수익 − 시장요인 (같은 시점)
        if (i >= 1 && day(bars[i - 1].t) === day(b.t) && bars[i - 1].c > 0) {
          const mr = mktRet(day(b.t) + ' ' + hm(b.t));
          if (mr != null) resid[i] = (b.c / bars[i - 1].c - 1) - mr;
        }
      } }
    const ctx = { vwap, vr, resid };

    for (let i = 1; i < bars.length - 1; i++) {
      const t = hm(bars[i].t);
      if (t < SESSION_START || t > SESSION_END) continue;
      if (day(bars[i + 1].t) !== day(bars[i].t)) continue;
      const eIdx = bars[i + 1].i0;
      const ePx = b1[eIdx].o;
      if (!(ePx > 0)) continue;
      const fwd = {};
      for (const h of HORIZONS) {
        const k = eIdx + h;
        fwd[h] = (k < b1.length && day(b1[k].t) === day(b1[eIdx].t)) ? (b1[k].c / ePx - 1) * 100 : null;
      }
      for (const h of HORIZONS) {
        if (fwd[h] == null) continue;
        const o = base[h].get(t) ?? { s: 0, n: 0 };
        o.s += fwd[h]; o.n++; base[h].set(t, o);
      }
      for (const n of NAMES) {
        let fire = false;
        try { fire = SIGNALS[n](bars, i, ctx); } catch { fire = false; }
        if (!fire) continue;
        const sg = seg(t);
        for (const h of HORIZONS) {
          if (fwd[h] == null) continue;
          const a = acc[n][h];
          a.n++; a.sum += fwd[h]; if (fwd[h] > 0) a.wins++;
          const bs = (a.bySeg[sg] ??= { n: 0, sum: 0, bsum: 0 });
          bs.n++; bs.sum += fwd[h];
          const bo = base[h].get(t); if (bo && bo.n) bs.bsum += bo.s / bo.n;
          (a.tsum ??= 0); a.tsum += (base[h].get(t) && base[h].get(t).n ? base[h].get(t).s / base[h].get(t).n : 0);
        }
      }
    }
  }
}

console.log(`\n=== 5분 스캘핑 엣지 2차 탐색 (극단·거래량·시간대·횡단면) ===`);
console.log(`TF ${TF}분 · ${nUsed}종목 · 왕복 마찰 ${COST}%`);
console.log(`※ 엣지 = 조건부 − 무조건부(같은 시각). 손익비 무관 상한.\n`);
console.log(`${'신호'.padEnd(13)}${'H(분)'.padStart(6)}${'n'.padStart(9)}${'조건부%'.padStart(10)}${'엣지%p'.padStart(10)}${'승률'.padStart(8)}${'비용대비'.padStart(10)}`);
let bestEdge = -Infinity, bestDesc = '';
for (const n of NAMES) {
  for (const h of HORIZONS) {
    const a = acc[n][h];
    if (a.n < 200) continue;
    const cond = a.sum / a.n;
    const unc = (a.tsum ?? 0) / a.n;
    const edge = cond - unc;
    if (h <= 15 && edge > bestEdge) { bestEdge = edge; bestDesc = `${n} H=${h}분 (n=${a.n})`; }
    console.log(
      `${n.padEnd(13)}${String(h).padStart(6)}${String(a.n).padStart(9)}` +
      `${((cond >= 0 ? '+' : '') + cond.toFixed(4)).padStart(10)}${((edge >= 0 ? '+' : '') + edge.toFixed(4)).padStart(10)}` +
      `${((a.wins / a.n * 100).toFixed(1) + '%').padStart(8)}` +
      `${(Math.abs(edge) >= COST ? '★초과' : `1/${(COST / Math.max(1e-9, Math.abs(edge))).toFixed(0)}`).padStart(10)}`);
  }
}

// 시간대 분해 — 최고 신호에 대해
console.log(`\n── 시간대 분해 (H=5분, 엣지%p) ──`);
console.log(`  ${'신호'.padEnd(13)}${SEGS.map(s => s.padStart(12)).join('')}`);
for (const n of NAMES) {
  const a = acc[n][5];
  if (!a || a.n < 200) continue;
  const cells = SEGS.map(s => {
    const o = a.bySeg[s];
    if (!o || o.n < 50) return '-';
    const e = (o.sum - o.bsum) / o.n;
    return (e >= 0 ? '+' : '') + e.toFixed(4);
  });
  console.log(`  ${n.padEnd(13)}${cells.map(c => c.padStart(12)).join('')}`);
}

console.log(`\n※ 단기(H≤15분) 최대 엣지: ${bestEdge >= 0 ? '+' : ''}${bestEdge.toFixed(4)}%p — ${bestDesc}`);
console.log(`  비용 ${COST}% 대비 ${Math.abs(bestEdge) >= COST ? '**초과 — 스캘핑 성립**' : `**1/${(COST / Math.max(1e-9, Math.abs(bestEdge))).toFixed(0)} — 여전히 불가**`}`);
