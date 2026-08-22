#!/usr/bin/env node
/**
 * backtest-scalp5m.mjs — 국내주식 1분/5분봉 스캘핑 승률 탐색 엔진 (2026-08-04 신설)
 *
 * ── 목표 (사용자) ─────────────────────────────────────────────────────────────
 * "1분 혹은 5분봉으로 승률 60~70%". 단 **승률만**은 익절폭을 조이면 자명하게 나오고 그 답은 쓸 수 없다
 * (이 저장소가 이미 확인: 코인 tp1-s15 가 승률 89% 에 총수익 -48~-90%).
 * 그래서 목표를 **승률 60~70% ∧ 비용차감 기대값 > 0 ∧ OOS 재현** 의 결합 조건으로 둔다.
 *
 * ── 비용 (diag-scalp-friction.mjs 실측) ───────────────────────────────────────
 *   수수료 0.015%×2 + **매도 거래세 0.15%(면제 불가)** = 0.180% 고정
 *   + 틱 슬리피지: 중위 1틱 0.120% → 왕복 2틱 0.240%
 *   = **현실 0.420%** (시장가 왕복) / 낙관 0.300% (지정가 절반 성공)
 *   ★ 틱 비용은 가격대별 3배 차이(1.7만원 0.057% ↔ 5,420원 0.185%) → `--tickmax` 로 고비용 종목 배제 가능.
 *     비용을 깎는 것은 이 저장소에서 승률이 검증된 유일한 방향이다(통과 3건 전부 "거래를 줄이는" 쪽).
 *
 * ── 손익분기 승률 = (SL + 비용) / (TP + SL) ───────────────────────────────────
 *   TP1.5/SL1.5 → 64.0%  (무작위 50%, 필요 엣지 +14%p)  ← 목표대 안에서 가장 낮은 엣지 요구
 *   TP1.5/SL1.0 → 56.8%  (무작위 40%, 필요 엣지 +17%p)
 *   TP1.0/SL0.7 → 65.9%  (무작위 41%, 필요 엣지 +25%p)
 *
 * ── 사전선언 판정 기준 (사후 조정 금지) ───────────────────────────────────────
 *   ① 승률 60~70% 구간
 *   ② 비용차감 EV/거래 > 0
 *   ③ **무작위 진입 대조군 대비 우위가 노이즈 바닥 초과** (같은 TP/SL·같은 거래수로 재추출)
 *   ④ IS(2026-02-20~05-15) 통과 후 **OOS(05-16~07-22, 7월 폭락 포함) 재현**
 *   ⑤ 거래수 ≥ MIN_TRADES (표본 부족한 우연 제외)
 *   위 5개를 **전부** 만족해야 '채택 후보'. 하나라도 실패하면 기각으로 적는다.
 *
 * ── 체결 보수성 ───────────────────────────────────────────────────────────────
 *   · 신호는 봉 종가 기준, 진입은 **다음 봉 시가** (look-ahead 차단)
 *   · 청산은 1분봉으로 판정. 한 봉에서 TP·SL 동시 충족 시 **SL 우선** (최악 가정)
 *   · 세션 종료 강제청산(EOD flat) — 오버나이트 금지
 *
 * 실행:
 *   node backtest-scalp5m.mjs --signal dipk --tf 5 --tp 1.5 --sl 1.5
 *   node backtest-scalp5m.mjs --sweep
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, 'candles-1m.jsonl');

const ARGV = process.argv.slice(2);
const argOf = (f, d = null) => { const i = ARGV.indexOf(f); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };
const hasFlag = (f) => ARGV.includes(f);

// ── 설정 ──────────────────────────────────────────────────────
const TF = Number(argOf('--tf', 5));                 // 신호 타임프레임(분)
const TP = Number(argOf('--tp', 1.5));               // 익절 %
const SL = Number(argOf('--sl', 1.5));               // 손절 %
const MAX_HOLD = Number(argOf('--maxhold', 24));     // 최대 보유(신호봉 단위)
const SIGNAL = argOf('--signal', 'dipk');
const K = Number(argOf('--k', 3));                   // dipk: 연속 음봉 수
const DEV = Number(argOf('--dev', 1.0));             // vwapdev: VWAP 하방 이격 %
const RSI_N = Number(argOf('--rsin', 14));
const RSI_TH = Number(argOf('--rsith', 25));
const BB_W = Number(argOf('--bbw', 20));
const BB_K = Number(argOf('--bbk', 2.0));
const SESSION_START = argOf('--start', '0900');      // KRX 정규장. NXT(08:00~/~20:00)는 얇아 기본 제외
const SESSION_END = argOf('--end', '1510');          // 마감 10분 전까지만 진입
const FLAT_HM = argOf('--flat', '1520');             // 강제청산
const TICK_MAX = Number(argOf('--tickmax', 0));      // 틱비용(%) 상한. 0=off
const MIN_PRICE = Number(argOf('--minprice', 2000));
const COST = Number(argOf('--cost', 0.42));          // 왕복 마찰 %
const MIN_TRADES = Number(argOf('--mintrades', 200));
const IS_END = argOf('--isend', '2026-06-12');       // IS/OOS 분할일
const RANDOM_DRAWS = Number(argOf('--draws', 20));
const LIMIT_STOCKS = Number(argOf('--limit', 0));    // 디버그용 종목 수 제한

function tickSize(px) {
  if (px < 2000) return 1;
  if (px < 5000) return 5;
  if (px < 20000) return 10;
  if (px < 50000) return 50;
  if (px < 200000) return 100;
  if (px < 500000) return 500;
  return 1000;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hm = (t) => t.slice(11, 13) + t.slice(14, 16);   // "2026-07-22T09:05:00..." → "0905"
const day = (t) => t.slice(0, 10);

/** 1분봉 → TF분봉 집계. 세션(일자) 안에서만 묶는다. */
function aggregate(bars1m, tf) {
  if (tf === 1) return bars1m.map((b, i) => ({ ...b, i0: i, i1: i }));
  const out = [];
  let cur = null;
  for (let i = 0; i < bars1m.length; i++) {
    const b = bars1m[i];
    const slot = Math.floor(Number(hm(b.t).slice(2)) / tf);   // 분 기준 슬롯
    const key = day(b.t) + hm(b.t).slice(0, 2) + slot;
    if (!cur || cur.key !== key) {
      if (cur) out.push(cur);
      cur = { key, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, i0: i, i1: i };
    } else {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l);
      cur.c = b.c; cur.v += b.v; cur.i1 = i;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function rsi(closes, i, n) {
  if (i < n) return 50;
  let up = 0, dn = 0;
  for (let j = i - n + 1; j <= i; j++) { const ch = closes[j] - closes[j - 1]; if (ch > 0) up += ch; else dn -= ch; }
  return up + dn === 0 ? 50 : (up / (up + dn)) * 100;
}

/**
 * 신호 판정. **봉 종가 확정 시점**에 판정하고 진입은 다음 봉 시가 → look-ahead 없음.
 * 전부 평균회귀 계열이다. 목표가 승률 60~70% 이므로 추세추종(저승률·고손익비)은 애초에 대상이 아니다.
 */
function signalAt(sig, bars, i, ctx, p) {
  const c = ctx.closes;
  switch (sig) {
    case 'dipk': {   // k봉 연속 하락
      if (i < p.k) return false;
      for (let j = i - p.k + 1; j <= i; j++) if (!(bars[j].c < bars[j - 1].c)) return false;
      return true;
    }
    case 'dipk-confirm': {   // k봉 연속 하락 뒤 **반전 양봉** 확인 (역선택 방어)
      if (i < p.k + 1) return false;
      for (let j = i - p.k; j <= i - 1; j++) if (!(bars[j].c < bars[j - 1].c)) return false;
      return bars[i].c > bars[i].o;
    }
    case 'vwapdev': {        // VWAP 하방 이격
      const vw = ctx.vwap[i];
      return vw > 0 && bars[i].c / vw - 1 <= -p.dev / 100;
    }
    case 'vwapdev-confirm': {
      const vw = ctx.vwap[i];
      return vw > 0 && bars[i].c / vw - 1 <= -p.dev / 100 && bars[i].c > bars[i].o;
    }
    case 'rsi': {
      if (i < p.rsiN) return false;
      return rsi(c, i, p.rsiN) < p.rsiTh;
    }
    case 'rsi-confirm': {
      if (i < p.rsiN + 1) return false;
      return rsi(c, i - 1, p.rsiN) < p.rsiTh && bars[i].c > bars[i].o;
    }
    case 'bb': {             // 볼린저 하단 이탈
      if (i < p.bbW) return false;
      const w = c.slice(i - p.bbW + 1, i + 1);
      const m = w.reduce((a, b) => a + b, 0) / w.length;
      const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length);
      return sd > 0 && bars[i].c < m - p.bbK * sd;
    }
    case 'bb-confirm': {
      if (i < p.bbW + 1) return false;
      const w = c.slice(i - p.bbW, i);
      const m = w.reduce((a, b) => a + b, 0) / w.length;
      const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length);
      return sd > 0 && bars[i - 1].c < m - p.bbK * sd && bars[i].c > bars[i].o;
    }
    case 'random': return true;   // 대조군(호출부에서 별도 샘플링)
    default: throw new Error(`unknown signal: ${sig}`);
  }
}

/**
 * 진입 후 청산 시뮬레이션. **1분봉으로 판정**한다(신호가 5분봉이어도 청산은 분 단위가 정확).
 * 한 봉에서 TP·SL 동시 충족 → **SL 우선**(최악 가정). 세션 끝 강제청산.
 * @returns {{ret:number, bars:number, why:string}} ret = 총수익률(%) — 비용 미차감
 */
function simulateExit(bars1m, entryIdx, entryPx, tpPct, slPct, maxHoldMin, flatHm) {
  const tp = entryPx * (1 + tpPct / 100);
  const sl = entryPx * (1 - slPct / 100);
  const d0 = day(bars1m[entryIdx].t);
  for (let i = entryIdx; i < bars1m.length && i - entryIdx < maxHoldMin; i++) {
    const b = bars1m[i];
    if (day(b.t) !== d0) break;                       // 날이 바뀌면 직전에 청산됐어야 함
    if (i > entryIdx) {                                // 진입봉은 시가 진입이므로 그 봉부터 판정
      if (b.l <= sl) return { ret: -slPct, bars: i - entryIdx, why: 'SL' };
      if (b.h >= tp) return { ret: tpPct, bars: i - entryIdx, why: 'TP' };
    } else {
      if (b.l <= sl) return { ret: -slPct, bars: 0, why: 'SL' };
      if (b.h >= tp) return { ret: tpPct, bars: 0, why: 'TP' };
    }
    if (hm(b.t) >= flatHm) return { ret: (b.c / entryPx - 1) * 100, bars: i - entryIdx, why: 'EOD' };
  }
  const last = Math.min(bars1m.length - 1, entryIdx + maxHoldMin - 1);
  return { ret: (bars1m[last].c / entryPx - 1) * 100, bars: last - entryIdx, why: 'TIME' };
}

// ── 단일 패스 스윕 ───────────────────────────────────────────
/**
 * ★ 974MB 를 설정마다 다시 읽으면 스윕이 불가능하다. **종목 1회 파싱 → 모든 설정 평가**로 바꾼다.
 *   타임프레임 집계·VWAP 도 (종목, tf) 당 1회만 하고 캐시한다.
 */
const CFG_DEFAULT = { k: 3, dev: 1.0, rsiN: 14, rsiTh: 25, bbW: 20, bbK: 2.0 };

function buildConfigs() {
  const out = [];
  const push = (name, sig, tf, tp, sl, p = {}, mh = MAX_HOLD) => out.push({ name, sig, tf, tp, sl, mh, p: { ...CFG_DEFAULT, ...p } });
  if (!hasFlag('--sweep')) {
    push(`${SIGNAL}`, SIGNAL, TF, TP, SL, { k: K, dev: DEV, rsiN: RSI_N, rsiTh: RSI_TH, bbW: BB_W, bbK: BB_K });
    push('random', 'random', TF, TP, SL, {});
    return out;
  }
  // 신호 × 손익비 × 최대보유. 손익비를 넓혀 **승률-EV 프론티어**를 그린다(목표대가 어디서 EV를 잃는지).
  for (const tf of [1, 5]) {
    for (const [tp, sl] of [[0.5,1.0],[0.7,1.0],[1.0,1.0],[1.0,1.5],[1.5,1.5],[1.5,1.0],[2.0,1.5],[2.0,1.0]]) {
      for (const mh of [24, 78]) {
        push('dipk3c', 'dipk-confirm', tf, tp, sl, { k: 3 }, mh);
        push('vwap1.0c', 'vwapdev-confirm', tf, tp, sl, { dev: 1.0 }, mh);
        push('rsi20c', 'rsi-confirm', tf, tp, sl, { rsiN: 14, rsiTh: 20 }, mh);
        push('bb2.0c', 'bb-confirm', tf, tp, sl, { bbW: 20, bbK: 2.0 }, mh);
        push('random', 'random', tf, tp, sl, {}, mh);
      }
    }
  }
  return out;
}

const CONFIGS = buildConfigs();
const results = CONFIGS.map(() => []);
const RND = CONFIGS.map((_, i) => mulberry32(999 + i));

let nStock = 0, nUsed = 0;
{
  const rl = createInterface({ input: createReadStream(FILE) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (LIMIT_STOCKS && nStock >= LIMIT_STOCKS) break;
    let j; try { j = JSON.parse(line); } catch { continue; }
    nStock++;
    const bars1m = [...j.bars].reverse();
    if (bars1m.length < 200) continue;
    const px0 = bars1m[bars1m.length - 1].c;
    if (px0 < MIN_PRICE) continue;
    if (TICK_MAX > 0 && (tickSize(px0) / px0 * 100) > TICK_MAX) continue;
    nUsed++;

    const aggCache = new Map(), ctxCache = new Map();
    const getAgg = (tf) => {
      if (!aggCache.has(tf)) {
        const a = aggregate(bars1m, tf);
        aggCache.set(tf, a);
        const vwap = new Array(a.length).fill(0);
        let d = null, pv = 0, vv = 0;
        for (let i = 0; i < a.length; i++) {
          const b = a[i];
          if (day(b.t) !== d) { d = day(b.t); pv = 0; vv = 0; }
          const tp3 = (b.h + b.l + b.c) / 3;
          pv += tp3 * b.v; vv += b.v; vwap[i] = vv > 0 ? pv / vv : 0;
        }
        ctxCache.set(tf, { vwap, closes: a.map(b => b.c) });
      }
      return { bars: aggCache.get(tf), ctx: ctxCache.get(tf) };
    };

    for (let ci = 0; ci < CONFIGS.length; ci++) {
      const cfg = CONFIGS[ci];
      const { bars, ctx } = getAgg(cfg.tf);
      const rate = cfg.tf === 1 ? 0.002 : 0.01;      // 무작위 대조군 발생률(거래수 대략 맞춤)
      for (let i = 1; i < bars.length - 1; i++) {
        const b = bars[i], t = hm(b.t);
        if (t < SESSION_START || t > SESSION_END) continue;
        if (day(bars[i + 1].t) !== day(b.t)) continue;
        const fire = cfg.sig === 'random' ? RND[ci]() < rate : signalAt(cfg.sig, bars, i, ctx, cfg.p);
        if (!fire) continue;
        const eIdx = bars[i + 1].i0;
        const ePx = bars1m[eIdx].o;
        if (!(ePx > 0)) continue;
        const r = simulateExit(bars1m, eIdx, ePx, cfg.tp, cfg.sl, cfg.mh * cfg.tf, FLAT_HM);
        results[ci].push({ d: day(b.t), ret: r.ret, why: r.why, bars: r.bars });
      }
    }
  }
}

// ── 통계 ──────────────────────────────────────────────────────
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function stats(trades, cost) {
  if (!trades.length) return { n: 0 };
  const net = trades.map(t => t.ret - cost);
  const wins = net.filter(v => v > 0), losses = net.filter(v => v <= 0);
  const gp = wins.reduce((a, b) => a + b, 0), gl = -losses.reduce((a, b) => a + b, 0);
  return {
    n: trades.length, winRate: wins.length / trades.length * 100, ev: avg(net),
    grossWR: trades.filter(t => t.ret > 0).length / trades.length * 100, grossEV: avg(trades.map(t => t.ret)),
    pf: gl > 0 ? gp / gl : Infinity, total: net.reduce((a, b) => a + b, 0),
    tpRate: trades.filter(t => t.why === 'TP').length / trades.length * 100,
    holdAvg: avg(trades.map(t => t.bars)),
  };
}

console.log(`\n데이터: ${nStock}종목 스캔 · ${nUsed}종목 사용 · 설정 ${CONFIGS.length}개 · IS/OOS 분할 ${IS_END}\n`);
const bo = (tp, sl) => (sl + COST) / (tp + sl) * 100;

// 무작위 기준선을 (tf, 손익비) 별로 뽑아둔다 — 엣지 계산의 분모
const randBy = new Map();
for (let i = 0; i < CONFIGS.length; i++) {
  const c = CONFIGS[i];
  if (c.sig === 'random') randBy.set(`${c.tf}|${c.tp}|${c.sl}|${c.mh}`, stats(results[i], COST));
}

const rows = [];
for (let i = 0; i < CONFIGS.length; i++) {
  const c = CONFIGS[i];
  const all = results[i];
  const s = stats(all, COST);
  if (!s.n) continue;
  const si = stats(all.filter(t => t.d <= IS_END), COST);
  const so = stats(all.filter(t => t.d > IS_END), COST);
  const r = randBy.get(`${c.tf}|${c.tp}|${c.sl}|${c.mh}`);
  rows.push({ c, s, si, so, r, edgeWR: r && r.n ? s.winRate - r.winRate : NaN });
}
rows.sort((a, b) => b.s.ev - a.s.ev);

console.log(`${'신호'.padEnd(10)}${'tf'.padStart(3)}${'TP/SL'.padStart(9)}${'보유'.padStart(5)}${'손분%'.padStart(7)}${'n'.padStart(7)}${'총승률'.padStart(8)}${'순승률'.padStart(8)}${'총EV'.padStart(8)}${'순EV'.padStart(8)}${'엣지WR'.padStart(8)}${'IS'.padStart(8)}${'OOS'.padStart(8)}`);
for (const { c, s, si, so, edgeWR } of rows) {
  const mark = (c.sig !== 'random' && s.winRate >= 60 && s.winRate <= 70 && s.ev > 0) ? '  ★' : '';
  console.log(
    `${c.name.padEnd(10)}${String(c.tf).padStart(3)}${`${c.tp}/${c.sl}`.padStart(9)}${String(c.mh * c.tf).padStart(5)}${bo(c.tp, c.sl).toFixed(1).padStart(7)}` +
    `${String(s.n).padStart(7)}${(s.grossWR.toFixed(1) + '%').padStart(8)}${(s.winRate.toFixed(1) + '%').padStart(8)}` +
    `${((s.grossEV >= 0 ? '+' : '') + s.grossEV.toFixed(3)).padStart(8)}${((s.ev >= 0 ? '+' : '') + s.ev.toFixed(3)).padStart(8)}` +
    `${(Number.isFinite(edgeWR) ? (edgeWR >= 0 ? '+' : '') + edgeWR.toFixed(1) : '-').padStart(8)}` +
    `${(si.n ? (si.ev >= 0 ? '+' : '') + si.ev.toFixed(3) : '-').padStart(8)}${(so.n ? (so.ev >= 0 ? '+' : '') + so.ev.toFixed(3) : '-').padStart(8)}${mark}`);
}

// ── 사전선언 판정 ─────────────────────────────────────────────
console.log(`\n── 사전선언 판정 (5개 전부 만족해야 채택 후보) ──`);
const pass = rows.filter(({ c, s, si, so, edgeWR }) =>
  c.sig !== 'random' && s.winRate >= 60 && s.winRate <= 70 && s.ev > 0 &&
  si.n && so.n && si.ev > 0 && so.ev > 0 && s.n >= MIN_TRADES && Number.isFinite(edgeWR) && edgeWR > 0);
if (!pass.length) {
  console.log(`  **채택 후보 0건**`);
  const band = rows.filter(({ c, s }) => c.sig !== 'random' && s.winRate >= 60 && s.winRate <= 70);
  const evpos = rows.filter(({ c, s }) => c.sig !== 'random' && s.ev > 0);
  const fmtx = (x) => `${x.c.name} tf${x.c.tf} ${x.c.tp}/${x.c.sl} 승률${x.s.winRate.toFixed(1)}%/EV${x.s.ev.toFixed(3)}`;
  console.log(`  · 승률 60~70% 진입: ${band.length}건 ${band.length ? '→ ' + band.slice(0, 3).map(fmtx).join(' · ') : ''}`);
  console.log(`  · EV>0 달성:        ${evpos.length}건 ${evpos.length ? '→ ' + evpos.slice(0, 3).map(fmtx).join(' · ') : ''}`);
  console.log(`  · **교집합 0건** → 목표(승률 60~70% ∧ EV>0)는 이 설정공간에서 미달성`);
} else {
  for (const x of pass) console.log(`  ★ ${x.c.name} tf${x.c.tf} ${x.c.tp}/${x.c.sl} — 승률 ${x.s.winRate.toFixed(1)}% · EV ${x.s.ev.toFixed(3)}% · IS ${x.si.ev.toFixed(3)} · OOS ${x.so.ev.toFixed(3)} · 엣지WR +${x.edgeWR.toFixed(1)}%p`);
}
console.log(`\n※ 표본 한계: 공통구간 2026-04-29~07-22 **56거래일** · 단일 국면(7월 폭락 포함). 워크포워드 창이 사실상 2개뿐이다.`);
