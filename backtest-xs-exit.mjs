#!/usr/bin/env node
/**
 * backtest-xs-exit.mjs — 횡단면 잔차 스캘핑 **청산 규칙 격자** (2026-08-06)
 *
 * ── 왜 ────────────────────────────────────────────────────────────────────────
 * 사용자 제안: "시간으로 청산하지 말고 반등이 끝난 것 같을 때 팔자."
 * 기존 측정이 이미 이 방향을 지지한다:
 *   · TP 도달 시 평균 보유 **2.1분** — 이기는 거래는 빠르다
 *   · hold30 EV **+0.248** > hold10 **+0.103** — 시간을 더 주면 좋아진다(10분이 회복을 자른다)
 *   · `timeonly` 15분 EV **+0.384** = 격자 최고 — TP 2% 고정이 상방을 자른다
 * ⇒ 현행은 위(TP 2%)·아래(TIME 10분)를 **둘 다 자르고 있다**. 트레일은 둘 다 푼다.
 *
 * ── 진입은 검증본 고정 (이 파일은 청산만 스윕한다) ────────────────────────────
 *   잔차 ≤ −5% · 패시브 지정가 시가−0.1% · 체결대기 5분 · 09:00~15:10 · 281종목 · 비용 0.30%
 *   ※ 당일 첫 봉(09:00~09:04)을 기준선으로 하는 신호는 **제외**(백테 원래 동작. 2026-08-06 라이브 불일치의 원인)
 *
 * ── 청산 모드 ─────────────────────────────────────────────────────────────────
 *   tp        : 현행 대조군. TP 고정 + 시간상한, 무손절
 *   time      : 시간상한만
 *   trail     : **진입 후 고점 대비 `trail`% 하락 시 청산** = "반등이 끝난 것 같을 때"
 *               `arm` = 트레일 발동 최소 수익(%). arm>0 이면 그 전까지는 **무손절로 버틴다**
 *               (arm=0 은 진입 직후부터 트레일 = 사실상 손절 겸용. 비교군으로 둔다)
 *   trailtp   : 트레일 + TP 상한 동시(반등이 크면 TP 에서 끊음 — 트레일이 이익을 얼마나 반납하는지 대조)
 *
 * ── 룩어헤드 방지 (중요) ──────────────────────────────────────────────────────
 * 1분봉은 봉 **내부 경로**를 모른다. 같은 봉에서 신고가와 트레일선 이탈이 같이 있으면 순서를 알 수 없다.
 *   → **트레일선은 직전 봉까지의 고가로 긋고, 현재 봉 저가로 판정**한 뒤, 그 다음에 현재 봉 고가로 고점을 갱신한다.
 *   (당일 고가로 선을 올리고 당일 저가로 판정하면 룩어헤드다 — shadow-1m 에서 이미 겪은 함정)
 * 체결가도 낙관하지 않는다: 봉 시가가 이미 트레일선 아래면 **시가 체결**(갭 하락분을 그대로 받는다).
 *
 * ── 사전선언 판정 (사후 조정 금지) ────────────────────────────────────────────
 *   ① 비용차감 EV > 0   ② IS·OOS 둘 다 EV > 0   ③ n ≥ 300   ④ 무작위 대조군 대비 EV 우위
 *   ⑤ 현행 채택본(tp2/10분, EV +0.103) 대비 개선
 *   ※ 승률 60~70% 밴드는 **주 기준에서 뺀다** — 트레일은 승률↓·손익비↑ 구조라 밴드를 강요하면
 *     좋은 설정을 버린다(`timeonly` 15분이 승률 51%인데 EV 최고였던 것과 같은 이유). 표에는 병기한다.
 *
 * 실행: node backtest-xs-exit.mjs [--limit N] [--confirm]
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, 'candles-1m.jsonl');
const ARGV = process.argv.slice(2);
const argOf = (f, d) => { const i = ARGV.indexOf(f); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };

const TF = 5;
const RESID = Number(argOf('--resid', 5)) / 100;
const COST = Number(argOf('--cost', 0.30));
const PASSIVE = Number(argOf('--passive', 0.1));
const FILLWIN = Number(argOf('--fillwin', 5));
const T0 = argOf('--start', '0900'), T1 = argOf('--end', '1510');
const FLAT = argOf('--flat', '1520');
const LIMIT = Number(argOf('--limit', 0));
const IS_END = '2026-06-12';
const MIN_TRADES = 300;
/**
 * "반등 타이밍에 사라" 의 진입측 해석 — 두 가지이고 **정보 확정 시점이 다르다**.
 *
 * --confirm  : **신호 봉이 양봉**(급락했지만 봉 안에서 반등 마감)일 때만 진입.
 *              신호 봉 종가에 확정되므로 **지연 0**. 원본 `backtest-xs-scalp.mjs --confirm` 과 같은 정의.
 * --confirm2 : 신호 다음 봉(i+1)을 **관찰**해 양봉이면 그 다음 봉(i+2) 시가에 진입 = 진짜 "반등 시작 확인".
 *              룩어헤드 없이 하려면 진입이 **5분 뒤로 밀린다.**
 *              ⚠️ 지연 실측: 1분에 EV 64% 감쇠, 2분이면 음수(손익분기 ≈106초) → 이미 죽었을 개연성이 높다.
 *
 * 🚨 **1차 구현이 룩어헤드였다(2026-08-06 발각·수정).** `bars[i+1].c > bars[i+1].o` 로 썼는데
 *    `bars[i+1]` 은 **진입 봉**이다 — 그 봉이 양봉인지는 봉이 끝나야 아는데 봉 **시작에 진입**했다.
 *    증상: EV +2.200(현행의 20배) · **OOS(+2.538) > IS(+1.910)**. 결과가 너무 좋고 OOS 가 IS 보다 높으면
 *    성능이 아니라 **미래 정보 유입**을 먼저 의심할 것. 폐기 로그 = `xs-exit-confirm-INVALID-lookahead.log`
 */
const CONFIRM = ARGV.includes('--confirm');
const CONFIRM2 = ARGV.includes('--confirm2');

const hm = (t) => t.slice(11, 13) + t.slice(14, 16);
const day = (t) => t.slice(0, 10);

function aggregate(b1, tf) {
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

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 청산 시뮬. 봉 단위 판정 순서 = **손절 → 트레일 → TP → EOD → (고점 갱신)**.
 * 고점 갱신을 마지막에 두는 것이 룩어헤드 방지의 핵심이다.
 */
function simExit(b1, eIdx, ePx, cfg, flatHm) {
  const { mode, tp, trail, arm, maxMin, stop } = cfg;
  const d0 = day(b1[eIdx].t);
  let hi = ePx;                       // 진입 후 고점(직전 봉까지)
  const TPx = tp ? ePx * (1 + tp / 100) : Infinity;
  for (let i = eIdx; i < b1.length && i - eIdx < maxMin; i++) {
    const b = b1[i];
    if (day(b.t) !== d0) break;
    if (stop) {
      const SLx = ePx * (1 - stop / 100);
      if (b.l <= SLx) return { ret: (Math.min(SLx, b.o) / ePx - 1) * 100, why: 'STOP', min: i - eIdx, hi };
    }
    if (mode === 'trail' || mode === 'trailtp') {
      const armed = hi >= ePx * (1 + arm / 100);          // 발동 조건: 고점이 arm% 이상
      if (armed) {
        const TRx = hi * (1 - trail / 100);
        // 봉 시가가 이미 선 아래면 시가 체결(갭 하락을 낙관하지 않는다)
        if (b.l <= TRx) return { ret: (Math.min(TRx, b.o) / ePx - 1) * 100, why: 'TRAIL', min: i - eIdx, hi };
      }
    }
    if ((mode === 'tp' || mode === 'trailtp') && b.h >= TPx) return { ret: tp, why: 'TP', min: i - eIdx, hi };
    if (hm(b.t) >= flatHm) return { ret: (b.c / ePx - 1) * 100, why: 'EOD', min: i - eIdx, hi };
    if (b.h > hi) hi = b.h;                                // ★ 마지막에 갱신
  }
  const last = Math.min(b1.length - 1, eIdx + maxMin - 1);
  return { ret: (b1[last].c / ePx - 1) * 100, why: 'TIME', min: last - eIdx, hi };
}

// ══ 1패스: 시장요인 ═══════════════════════════════════════════
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
      if (day(bars[i].t) !== day(bars[i - 1].t) || !(bars[i - 1].c > 0)) continue;
      const k = day(bars[i].t) + ' ' + hm(bars[i].t);
      const o = mkt.get(k) ?? { s: 0, n: 0 };
      o.s += bars[i].c / bars[i - 1].c - 1; o.n++; mkt.set(k, o);
    }
  }
  console.log(`[1패스] 시장요인 ${mkt.size.toLocaleString()} 시점 (${n}종목)`);
}
const mktRet = (k) => { const o = mkt.get(k); return o && o.n >= 20 ? o.s / o.n : null; };

// ══ 설정 격자 ═════════════════════════════════════════════════
const CFGS = [];
const MAXMIN = [10, 30, 60, 120, 390];
// 대조군 — 현행 채택본과 timeonly
for (const mm of [10, 30]) CFGS.push({ mode: 'tp', tp: 2, trail: 0, arm: 0, maxMin: mm, stop: 0, tag: `현행 TP2/${mm}분` });
for (const mm of [15, 30, 60]) CFGS.push({ mode: 'time', tp: 0, trail: 0, arm: 0, maxMin: mm, stop: 0, tag: `시간만 ${mm}분` });
// 트레일 격자
for (const trail of [0.3, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0]) {
  for (const arm of [0, 0.5, 1.0]) {
    for (const mm of MAXMIN) CFGS.push({ mode: 'trail', tp: 0, trail, arm, maxMin: mm, stop: 0, tag: `트레일${trail}/발동${arm}/${mm}분` });
  }
}
// 트레일 + TP 상한 (트레일이 반납하는 이익 대조)
for (const trail of [0.5, 1.0, 2.0]) for (const mm of [30, 120]) CFGS.push({ mode: 'trailtp', tp: 3, trail, arm: 0.5, maxMin: mm, stop: 0, tag: `트레일${trail}+TP3/${mm}분` });
// 트레일 + 하드손절 (무손절 전제를 깨는 축 — 검정용)
for (const trail of [1.0, 2.0]) for (const stop of [2, 3]) CFGS.push({ mode: 'trail', tp: 0, trail, arm: 0.5, maxMin: 120, stop, tag: `트레일${trail}+손절${stop}/120분` });

const ALL = [];
for (const kind of ['xs', 'random']) for (const c of CFGS) ALL.push({ ...c, kind });
const res = ALL.map(() => []);
const RND = ALL.map((_, i) => mulberry32(9182 + i));

// ══ 2패스 ═════════════════════════════════════════════════════
let nStock = 0, nUsed = 0, nFire = 0, nFilled = 0;
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
    const dayFirst = new Map();
    for (let i = 0; i < bars.length; i++) if (!dayFirst.has(day(bars[i].t))) dayFirst.set(day(bars[i].t), i);

    for (let i = 1; i < bars.length - 1; i++) {
      const t = hm(bars[i].t);
      if (t < T0 || t >= T1) continue;
      const d = day(bars[i].t);
      if (i === dayFirst.get(d)) continue;                       // 개장 첫 봉 기준선 제외
      if (day(bars[i + 1].t) !== d || day(bars[i - 1].t) !== d || !(bars[i - 1].c > 0)) continue;
      const mr = mktRet(d + ' ' + hm(bars[i].t));
      if (mr == null) continue;
      const resid = (bars[i].c / bars[i - 1].c - 1) - mr;
      // ★ 신호 조건은 **신호 봉 종가까지의 정보만** 쓴다(bars[i]). bars[i+1] 은 진입 봉이라 보면 룩어헤드다.
      const fireXs = resid <= -RESID && (!CONFIRM || bars[i].c > bars[i].o);
      if (fireXs) nFire++;

      /**
       * 진입 봉: 기본 i+1. `--confirm2` 면 i+1 을 **관찰만** 하고 양봉일 때 i+2 에 진입(5분 지연).
       * 관찰 봉이 음봉이면 거래 자체가 없다(반등이 시작되지 않은 것).
       */
      let entryBar = i + 1;
      if (CONFIRM2) {
        if (i + 2 >= bars.length || day(bars[i + 2].t) !== d) continue;
        if (!(bars[i + 1].c > bars[i + 1].o)) continue;
        entryBar = i + 2;
      }
      const eIdx0 = bars[entryBar].i0;
      const eb = b1[eIdx0];
      if (!eb || day(eb.t) !== d) continue;
      const lim = eb.o * (1 - PASSIVE / 100);
      let fi = -1;
      for (let k = eIdx0; k < Math.min(b1.length, eIdx0 + FILLWIN); k++) {
        if (day(b1[k].t) !== day(eb.t)) break;
        if (b1[k].l < lim) { fi = k; break; }
      }
      if (fi < 0) continue;
      if (fireXs) nFilled++;
      if (!(lim > 0)) continue;

      for (let ci = 0; ci < ALL.length; ci++) {
        const c = ALL[ci];
        const fire = c.kind === 'random' ? RND[ci]() < 0.0015 : fireXs;
        if (!fire) continue;
        const r = simExit(b1, fi, lim, c, FLAT);
        res[ci].push({ d, ret: r.ret, why: r.why, min: r.min });
      }
    }
  }
}

// ══ 통계 ══════════════════════════════════════════════════════
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const fmt = (v, d = 3) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) : '-');
function st(tr) {
  if (!tr.length) return { n: 0 };
  const net = tr.map(t => t.ret - COST);
  const w = net.filter(v => v > 0), l = net.filter(v => v <= 0);
  const gp = w.reduce((a, b) => a + b, 0), gl = -l.reduce((a, b) => a + b, 0);
  return { n: tr.length, wr: w.length / tr.length * 100, ev: avg(net), pf: gl > 0 ? gp / gl : Infinity,
    avgW: w.length ? avg(w) : NaN, avgL: l.length ? avg(l) : NaN, hold: avg(tr.map(t => t.min)) };
}

console.log(`\n=== 청산 규칙 격자 — 잔차 ≤ −${(RESID * 100).toFixed(0)}% · 패시브 −${PASSIVE}% · 비용 ${COST}%${CONFIRM ? ' · **반등확인 진입**' : ''} ===`);
console.log(`${nUsed}종목 · 신호 ${nFire} · 체결 ${nFilled}(${(nFilled / Math.max(1, nFire) * 100).toFixed(1)}%) · IS/OOS ${IS_END}\n`);

const rndBy = new Map();
for (let i = 0; i < ALL.length; i++) if (ALL[i].kind === 'random') rndBy.set(ALL[i].tag, st(res[i]));

const rows = [];
for (let i = 0; i < ALL.length; i++) {
  const c = ALL[i];
  if (c.kind !== 'xs') continue;
  const s = st(res[i]); if (!s.n) continue;
  const si = st(res[i].filter(t => t.d <= IS_END));
  const so = st(res[i].filter(t => t.d > IS_END));
  const r = rndBy.get(c.tag);
  rows.push({ c, s, si, so, redge: r && r.n ? s.ev - r.ev : NaN, tr: res[i] });
}
rows.sort((a, b) => b.s.ev - a.s.ev);

console.log(`${'설정'.padStart(22)}${'n'.padStart(6)}${'승률'.padStart(8)}${'EV%'.padStart(9)}${'PF'.padStart(6)}${'평균익'.padStart(8)}${'평균손'.padStart(8)}${'보유분'.padStart(7)}${'IS'.padStart(9)}${'OOS'.padStart(9)}${'vs무작위'.padStart(10)}`);
for (const { c, s, si, so, redge } of rows.slice(0, 26)) {
  const pass = s.ev > 0 && si.n && so.n && si.ev > 0 && so.ev > 0 && s.n >= MIN_TRADES && redge > 0 && s.ev > 0.103;
  console.log(`${c.tag.padStart(22)}${String(s.n).padStart(6)}${(s.wr.toFixed(1) + '%').padStart(8)}${fmt(s.ev).padStart(9)}${s.pf.toFixed(2).padStart(6)}` +
    `${fmt(s.avgW, 2).padStart(8)}${fmt(s.avgL, 2).padStart(8)}${s.hold.toFixed(1).padStart(7)}` +
    `${fmt(si.ev).padStart(9)}${fmt(so.ev).padStart(9)}${fmt(redge).padStart(10)}${pass ? '  ★' : ''}`);
}

console.log(`\n── 사전선언 판정 (EV>0 ∧ IS·OOS>0 ∧ n≥${MIN_TRADES} ∧ 무작위우위 ∧ 현행(+0.103) 초과) ──`);
const pass = rows.filter(({ s, si, so, redge }) =>
  s.ev > 0 && si.n && so.n && si.ev > 0 && so.ev > 0 && s.n >= MIN_TRADES && redge > 0 && s.ev > 0.103);
if (pass.length) {
  for (const x of pass.slice(0, 10)) console.log(`  ★ ${x.c.tag} — EV ${fmt(x.s.ev)}% · 승률 ${x.s.wr.toFixed(1)}% · IS ${fmt(x.si.ev)} / OOS ${fmt(x.so.ev)} · PF ${x.s.pf.toFixed(2)} · n=${x.s.n}`);
  console.log(`  (통과 ${pass.length}건 / 전체 ${rows.length}설정 — 다중비교 주의: 격자가 크면 우연 통과가 섞인다. 인접 설정 플래토 여부를 볼 것)`);
} else {
  console.log(`  통과 0건. EV>0 ${rows.filter(r => r.s.ev > 0).length}건 · 현행 초과 ${rows.filter(r => r.s.ev > 0.103).length}건`);
}

// 청산사유 분해 — 최상위 3설정
console.log(`\n── 최상위 3설정 청산사유 분해 ──`);
for (const { c, s, tr } of rows.slice(0, 3)) {
  const by = new Map();
  for (const t of tr) { const k = t.why; const o = by.get(k) ?? []; o.push(t.ret - COST); by.set(k, o); }
  console.log(`  [${c.tag}] n=${s.n} EV ${fmt(s.ev)}`);
  for (const [k, v] of [...by.entries()].sort((a, b) => b[1].length - a[1].length))
    console.log(`     ${k.padEnd(6)} n=${String(v.length).padStart(4)} (${(v.length / s.n * 100).toFixed(0)}%) · EV ${fmt(avg(v))}`);
}
