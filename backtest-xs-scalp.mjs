#!/usr/bin/env node
/**
 * backtest-xs-scalp.mjs — 횡단면 잔차 스캘핑 TP/SL 백테스트 (2026-08-04)
 *
 * ── 어떻게 여기까지 왔나 ──────────────────────────────────────────────────────
 * 1차 탐색(8계열, 자기 시계열 평균회귀): 5분 호라이즌 최대 엣지 +0.0014%p = 비용의 1/294. 전멸.
 * 2차 탐색(극단이격·거래량·시간대·**횡단면**): `xs3`(시장 대비 5분 초과하락 −3%)이
 *   H=5분에서 **+0.2727%p** — 1차 최고의 195배. 시간대 분해에서 **오전 +0.4263%p 로 비용 0.42% 초과**.
 * 이 파일은 그 축을 실제 TP/SL 로 돌려 **승률 60~70% ∧ EV>0** 이 동시에 되는 점이 있는지 본다.
 *
 * ── 왜 횡단면이 달랐나 (기제) ─────────────────────────────────────────────────
 * 자기 시계열 하락은 "시장이 같이 빠진 것"과 "혼자 빠진 것"이 섞여 있다. 전자는 정보가 없고
 * 후자만 유동성 충격(대량 매도 처리)일 가능성이 있다. 시장요인을 빼면 후자만 남는다.
 * 그래서 같은 −3% 라도 횡단면 잔차 −3% 는 자기 −3% 보다 훨씬 강한 신호다.
 *
 * ── 사전선언 판정 (사후 조정 금지) ────────────────────────────────────────────
 *   ① 순승률 60~70%  ② 비용차감 EV>0  ③ 무작위 대비 우위  ④ IS·OOS 둘 다 EV>0  ⑤ n ≥ 300
 *
 * 체결 보수성: 신호는 봉 종가 확정 → **다음 봉 시가 진입**. 청산은 1분봉, 한 봉에서 TP·SL 동시 → **SL 우선**.
 * 세션 끝 강제청산. 비용 왕복 0.42%(실측) — `--cost` 로 민감도 확인 가능.
 *
 * 실행: node backtest-xs-scalp.mjs --resid 3 --start 0930 --end 1130
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
const RESID = Number(argOf('--resid', 3)) / 100;
/**
 * ★ 2026-08-05 신설 — 잔차 **상한**. 라이브 섀도우 1일차에서 나온 가설(H6).
 *   6건 중 −14.18%·−7.91% 두 극단이 −7.82%·−2.61% 로 최악이었고, −5.38% 는 +1.11% 로 유일한 이익.
 *   백테는 하한만 있어(resid <= −RESID) −14% 를 −5% 와 동일 취급한다.
 *   dd20 에서 '−50% 초과 버킷만 유일한 음수' 였던 것과 같은 구조 — 극단 낙폭은 반등이 아니라 추세다.
 *   0 = 상한 없음(현행).
 */
const RESIDMAX = Number(argOf('--residmax', 0)) / 100;      // 잔차 하한 (%)
const T0 = argOf('--start', '0930'), T1 = argOf('--end', '1130');
const FLAT = argOf('--flat', '1520');
const COST = Number(argOf('--cost', 0.42));
const LIMIT = Number(argOf('--limit', 0));
const IS_END = argOf('--isend', '2026-06-12');
const CONFIRM = ARGV.includes('--confirm');           // 반전 양봉 확인 추가
const MIN_TRADES = 300;
/**
 * ★ 2026-08-04 추가 — "실무 구현 가능한가"를 가정이 아니라 **측정**으로 답하기 위한 3축.
 *   --delay N   진입 지연(신호봉 +1+N 봉 시가). 라이브는 281종목 스캔에 ~30초 걸리므로
 *               다음 봉 시가 진입이 물리적으로 늦을 수 있다. N=1 이면 한 봉(5분) 늦게 산다.
 *   --mktn N    시장요인을 **상위 N종목만**으로 계산. 281종목 실시간 조회가 부담이면
 *               소수만 폴링해도 되는지 판정한다(20종목이면 105ms×20 = 2초).
 *   --advfill f 진입가 = 시가 + f×(고가−저가). 급락 직후 호가가 벌어진 상황의 **불리한 체결**을
 *               직접 모사한다. 비용 파라미터를 올리는 것보다 현실적이다(봉마다 폭이 다르다).
 */
const DELAY = Number(argOf('--delay', 0));
const MKTN = Number(argOf('--mktn', 0));       // 0 = 전 종목
const ADVFILL = Number(argOf('--advfill', 0)); // 0 = 시가 그대로
/**
 * ★ --delaymin N : 진입을 **분 단위**로 늦춘다(--delay 는 봉 단위라 해상도가 5분이었다).
 *   실측에서 1봉(5분) 지연이 EV +0.384 → −0.266 으로 전략을 죽였다 = **엣지가 첫 봉 안에 있다.**
 *   그러면 실무 질문은 "몇 분까지 늦어도 되나"다. 라이브는 281종목 스캔에 ~30초(105ms×281) 걸리므로
 *   현실 지연은 0~1분 구간이다. 그 구간의 감쇠 기울기를 재야 구현 가능 여부가 판정된다.
 */
const DELAYMIN = Number(argOf('--delaymin', 0));
/**
 * ★ --passive X : **크로싱하지 않는 진입**. 진입봉 시가 대비 X% 아래에 지정가를 걸고 기다린다.
 *   왜: 실체결 10건 실측에서 크로싱 진입의 f 중위가 **0.429**(허용 0.18 의 2.4배)로 나왔다.
 *   f 는 "체결가가 봉 범위 어디냐"이고, 스프레드를 건너면 구조적으로 위쪽(0.4~0.8)에 붙는다.
 *   → 건너지 않으면 f 가 음수가 된다. 대신 **체결이 보장되지 않는다.**
 *
 *   ⚠️ 코인 limit-dip 기각과 상황이 다르다: 거기선 "더 빠지길 기다리는" 역선택이었다.
 *   여기는 **−5% 급락 진행 중**이라 매수호가에 걸면 투매를 받아주는 유동성 공급이 된다.
 *   그래도 선택편의는 실재한다(체결된 것 = 더 빠진 것) → **체결확률과 체결분 성과를 같이** 봐야 한다.
 *
 *   체결 판정: 진입봉부터 --fillwin 분 이내에 저가가 지정가 **아래로 통과**하면 체결(터치만으로는 불충분 —
 *   큐 우선순위를 고려한 보수 가정). 그 안에 없으면 **거래 자체가 없다**(비용도 없다).
 */
const PASSIVE = Number(argOf('--passive', 0));      // % (0=off, 크로싱 진입)
const FILLWIN = Number(argOf('--fillwin', 5));      // 지정가 체결 대기(분)

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

/** 한 봉에서 TP·SL 동시 충족 → SL 우선(최악 가정). 세션 끝 강제청산. */
/**
 * ★ 2026-08-04 추가 — 청산 모드. TP/SL 격자가 전부 EV<0 이었는데 엣지 측정은 +0.45% 였다.
 *   원인: 이 신호는 **평균은 양수지만 경로가 험하다.** 시장 대비 −4% 급락 직후라 다음 분봉
 *   변동성이 커서 SL 이 반등 전에 먼저 걸린다(TP율 36% 인데 EV −0.30%).
 *   그래서 손절을 빼고 **시간 청산**으로 실현하는 구조를 함께 잰다.
 *     tpsl     : 익절·손절 둘 다 (현행)
 *     tponly   : 익절 + 시간청산, **손절 없음** (경로 험한 평균회귀의 정석)
 *     timeonly : 시간청산만 (엣지 측정과 동일 구조 — 재현 검증용)
 *   ⚠️ 손절 제거는 이 저장소에서 스윙에 대해 기각된 축이다(폭락구간 MDD 33%>29.3%).
 *     여기서는 보유가 **최대 maxMin 분**으로 강제 종료되므로 꼬리가 시간으로 잘린다 — 성격이 다르다.
 *     그래도 최악손실 분포를 같이 봐야 한다.
 */
function simExit(b1, eIdx, ePx, tp, sl, maxMin, flatHm, mode = 'tpsl') {
  const TPx = ePx * (1 + tp / 100), SLx = ePx * (1 - sl / 100);
  const d0 = day(b1[eIdx].t);
  for (let i = eIdx; i < b1.length && i - eIdx < maxMin; i++) {
    const b = b1[i];
    if (day(b.t) !== d0) break;
    if (mode !== 'timeonly' && mode !== 'tponly' && b.l <= SLx) return { ret: -sl, why: 'SL', min: i - eIdx };
    if (mode !== 'timeonly' && b.h >= TPx) return { ret: tp, why: 'TP', min: i - eIdx };
    if (hm(b.t) >= flatHm) return { ret: (b.c / ePx - 1) * 100, why: 'EOD', min: i - eIdx };
  }
  const last = Math.min(b1.length - 1, eIdx + maxMin - 1);
  return { ret: (b1[last].c / ePx - 1) * 100, why: 'TIME', min: last - eIdx };
}

// ══ 1패스: 시장요인 ═══════════════════════════════════════════
const mkt = new Map();
{
  let n = 0;
  const rl = createInterface({ input: createReadStream(FILE) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (LIMIT && n >= LIMIT) break;
    if (MKTN && n >= MKTN) break;   // 시장요인을 상위 N종목만으로
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
const MKT_MIN = MKTN ? Math.max(5, Math.floor(MKTN * 0.5)) : 20;
const mktRet = (k) => { const o = mkt.get(k); return o && o.n >= MKT_MIN ? o.s / o.n : null; };

// ══ 2패스: TP/SL 격자 ═════════════════════════════════════════
const GRID = [];
for (const tp of [0.4, 0.6, 0.8, 1.0, 1.5, 2.0]) for (const sl of [0.5, 0.8, 1.0, 1.5, 2.0]) GRID.push([tp, sl]);
const MAXMIN = [3, 5, 10, 15, 30];
const MODES = ['tpsl', 'tponly', 'timeonly'];
const CFGS = [];
for (const kind of ['xs', 'random']) {
  for (const mode of MODES) {
    if (mode === 'timeonly') { for (const mm of MAXMIN) CFGS.push({ tp: 0, sl: 0, mm, kind, mode }); continue; }
    for (const [tp, sl] of GRID) for (const mm of MAXMIN) CFGS.push({ tp, sl, mm, kind, mode });
  }
}
const res = CFGS.map(() => []);
const RND = CFGS.map((_, i) => mulberry32(4242 + i));

let nStock = 0, nUsed = 0, nPassiveTried = 0, nPassiveFilled = 0;
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
    for (let i = 1; i < bars.length - 1; i++) {
      const t = hm(bars[i].t);
      if (t < T0 || t >= T1) continue;
      if (day(bars[i + 1].t) !== day(bars[i].t)) continue;
      if (!(bars[i - 1].c > 0) || day(bars[i - 1].t) !== day(bars[i].t)) continue;
      const mr = mktRet(day(bars[i].t) + ' ' + hm(bars[i].t));
      if (mr == null) continue;
      const resid = (bars[i].c / bars[i - 1].c - 1) - mr;
      const fireXs = resid <= -RESID && (!RESIDMAX || resid >= -RESIDMAX) && (!CONFIRM || bars[i].c > bars[i].o);
      const sigIdx = i + 1 + DELAY;
      if (sigIdx >= bars.length || day(bars[sigIdx].t) !== day(bars[i].t)) continue;
      let eIdx = Math.min(b1.length - 1, bars[sigIdx].i0 + DELAYMIN);
      const eb = b1[eIdx];
      if (day(eb.t) !== day(bars[i].t)) continue;
      let ePx;
      if (PASSIVE > 0) {
        // 패시브: 시가 −PASSIVE% 에 지정가. FILLWIN 분 안에 저가가 그 아래로 내려가야 체결.
        const lim = eb.o * (1 - PASSIVE / 100);
        let fi = -1;
        for (let k = eIdx; k < Math.min(b1.length, eIdx + FILLWIN); k++) {
          if (day(b1[k].t) !== day(eb.t)) break;
          if (b1[k].l < lim) { fi = k; break; }
        }
        /**
         * ★ 계측 버그 수정(2026-08-04): 이 블록은 `fire` 판정보다 **앞**에 있어서 카운터를 그냥 올리면
         *   신호봉이 아니라 **세션의 모든 봉**을 센다 = 시장 전체 통계이지 신호 조건부 체결률이 아니다.
         *   (1차 실행에서 "체결률 74%" 로 잘못 보고했다. 거래기록 n·EV 자체는 신호∧체결일 때만 쌓이므로 정상이었다.)
         *   → **fireXs 인 봉에서만** 센다.
         */
        if (fireXs) { nPassiveTried++; if (fi >= 0) nPassiveFilled++; }
        if (fi < 0) continue;                 // 미체결 = 거래 없음(비용 0)
        eIdx = fi; ePx = lim;
      } else {
        ePx = ADVFILL > 0 ? eb.o + ADVFILL * Math.max(0, eb.h - eb.l) : eb.o;
      }
      if (!(ePx > 0)) continue;
      for (let ci = 0; ci < CFGS.length; ci++) {
        const c = CFGS[ci];
        const fire = c.kind === 'random' ? RND[ci]() < 0.0015 : fireXs;
        if (!fire) continue;
        const r = simExit(b1, eIdx, ePx, c.tp, c.sl, c.mm, FLAT, c.mode);
        res[ci].push({ d: day(bars[i].t), ret: r.ret, why: r.why });
      }
    }
  }
}

// ══ 통계 ══════════════════════════════════════════════════════
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function st(tr, cost) {
  if (!tr.length) return { n: 0 };
  const net = tr.map(t => t.ret - cost);
  const w = net.filter(v => v > 0), l = net.filter(v => v <= 0);
  const gp = w.reduce((a, b) => a + b, 0), gl = -l.reduce((a, b) => a + b, 0);
  return { n: tr.length, wr: w.length / tr.length * 100, ev: avg(net), pf: gl > 0 ? gp / gl : Infinity,
    tp: tr.filter(t => t.why === 'TP').length / tr.length * 100 };
}

console.log(`\n=== 횡단면 잔차 스캘핑 — 잔차 ≤ −${(RESID * 100).toFixed(0)}% · ${T0}~${T1} · TF ${TF}분${CONFIRM ? ' · 반전확인' : ''} ===`);
console.log(`${nUsed}종목 · 비용 왕복 ${COST}% · IS/OOS ${IS_END}` +
  `${DELAY ? ` · 진입지연 ${DELAY}봉(${DELAY * TF}분)` : ''}${DELAYMIN ? ` · 진입지연 ${DELAYMIN}분` : ''}${MKTN ? ` · 시장요인 ${MKTN}종목` : ''}${ADVFILL ? ` · 불리체결 ${ADVFILL}×고저폭` : ''}\n`);

const rndBy = new Map();
for (let i = 0; i < CFGS.length; i++) {
  const c = CFGS[i];
  if (c.kind === 'random') rndBy.set(`${c.tp}|${c.sl}|${c.mm}|${c.mode}`, st(res[i], COST));
}
const rows = [];
for (let i = 0; i < CFGS.length; i++) {
  const c = CFGS[i];
  if (c.kind !== 'xs') continue;
  const s = st(res[i], COST);
  if (!s.n) continue;
  const si = st(res[i].filter(t => t.d <= IS_END), COST);
  const so = st(res[i].filter(t => t.d > IS_END), COST);
  const r = rndBy.get(`${c.tp}|${c.sl}|${c.mm}|${c.mode}`);
  rows.push({ c, s, si, so, edge: r && r.n ? s.wr - r.wr : NaN, redge: r && r.n ? s.ev - r.ev : NaN });
}
rows.sort((a, b) => b.s.ev - a.s.ev);

console.log(`${'모드'.padStart(9)}${'TP/SL'.padStart(10)}${'상한'.padStart(6)}${'n'.padStart(7)}${'순승률'.padStart(8)}${'EV%'.padStart(9)}${'PF'.padStart(6)}${'TP율'.padStart(7)}${'엣지WR'.padStart(8)}${'IS'.padStart(9)}${'OOS'.padStart(9)}`);
for (const { c, s, si, so, edge } of rows.slice(0, 20)) {
  const mark = (s.wr >= 60 && s.wr <= 70 && s.ev > 0) ? '  ★' : '';
  console.log(`${c.mode.padStart(9)}${(c.mode === 'timeonly' ? '-' : `${c.tp}/${c.sl}`).padStart(10)}${(c.mm + '분').padStart(6)}${String(s.n).padStart(7)}` +
    `${(s.wr.toFixed(1) + '%').padStart(8)}${((s.ev >= 0 ? '+' : '') + s.ev.toFixed(3)).padStart(9)}${s.pf.toFixed(2).padStart(6)}` +
    `${(s.tp.toFixed(0) + '%').padStart(7)}${(Number.isFinite(edge) ? (edge >= 0 ? '+' : '') + edge.toFixed(1) : '-').padStart(8)}` +
    `${(si.n ? (si.ev >= 0 ? '+' : '') + si.ev.toFixed(3) : '-').padStart(9)}${(so.n ? (so.ev >= 0 ? '+' : '') + so.ev.toFixed(3) : '-').padStart(9)}${mark}`);
}

if (PASSIVE > 0) console.log(`\n[패시브] 지정가 시가−${PASSIVE}% · 대기 ${FILLWIN}분 → **체결률 ${nPassiveTried ? (nPassiveFilled / nPassiveTried * 100 / CFGS.length * CFGS.length).toFixed(1) : '0'}%** (시도 ${Math.round(nPassiveTried / Math.max(1, CFGS.length))} · 체결 ${Math.round(nPassiveFilled / Math.max(1, CFGS.length))} per 설정)`);
console.log(`\n── 사전선언 판정 ──`);
const pass = rows.filter(({ s, si, so, edge }) =>
  s.wr >= 60 && s.wr <= 70 && s.ev > 0 && si.n && so.n && si.ev > 0 && so.ev > 0 && s.n >= MIN_TRADES && edge > 0);
if (pass.length) {
  for (const x of pass) console.log(`  ★ [${x.c.mode}] TP${x.c.tp}/SL${x.c.sl} 상한${x.c.mm}분 — 승률 ${x.s.wr.toFixed(1)}% · EV ${x.s.ev.toFixed(3)}% · IS ${x.si.ev.toFixed(3)} · OOS ${x.so.ev.toFixed(3)} · n=${x.s.n}`);
} else {
  const band = rows.filter(({ s }) => s.wr >= 60 && s.wr <= 70);
  const ev = rows.filter(({ s }) => s.ev > 0 && s.n >= MIN_TRADES);
  console.log(`  채택 후보 0건 — 승률대 진입 ${band.length}건 · EV>0 ${ev.length}건`);
  if (ev.length) console.log(`  · EV>0 최고: [${ev[0].c.mode}] TP${ev[0].c.tp}/SL${ev[0].c.sl} ${ev[0].c.mm}분 — 승률 ${ev[0].s.wr.toFixed(1)}% · EV ${ev[0].s.ev.toFixed(3)}% · IS ${ev[0].si.ev.toFixed(3)} / OOS ${ev[0].so.ev.toFixed(3)}`);
}
