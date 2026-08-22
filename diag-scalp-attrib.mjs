#!/usr/bin/env node
/**
 * diag-scalp-attrib.mjs — 횡단면 잔차 스캘핑 **승/패 귀인 분해** (2026-08-06)
 *
 * ── 왜 이걸 만드나 ────────────────────────────────────────────────────────────
 * 섀도우 라이브 2일(base n=6)에서 승률 33%·EV −1.58% 가 나왔다(백테 67.2%·+0.103%).
 * n=6 은 이항검정으로 p≈0.095 라 **통계적으로는 아직 기각 불가**다. 그러나 "표본 부족"으로
 * 닫으면 배선 결함을 놓친다. 그래서 두 갈래로 나눈다:
 *   (a) 백테 안에서 **무엇이 승자를 만드는가**(조건부 분해) — 라이브 패자가 어느 버킷인지 대조용
 *   (b) 라이브에만 있고 백테엔 없는 **구조 차이**를 재현해 측정 (유니버스·개장첫봉·시장요인 N)
 *
 * ── 측정 설정 = 라이브 base 변형과 동일 ───────────────────────────────────────
 *   잔차 ≤ −5% · 패시브 시가−0.1%(대기 5분) · TP 2% · 무손절 · 상한 10분 · 비용 0.30%
 *
 * 각 거래마다 아래 특징을 함께 적재해 분위별 승률/EV 를 낸다. 사후 체리피킹을 막기 위해
 * **모든 축을 한 번에 출력**하고, 축별로 무작위 대조군(같은 수의 무작위 진입) 을 함께 낸다.
 *
 * 실행: node diag-scalp-attrib.mjs [--limit N] [--mktn N] [--unitop N] [--firstbar]
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
const HOLD = Number(argOf('--hold', 10));
const TP = Number(argOf('--tp', 2));
const T0 = argOf('--start', '0900'), T1 = argOf('--end', '1510');
const FLAT = '1520';
const LIMIT = Number(argOf('--limit', 0));
const IS_END = '2026-06-12';
/** 라이브 유니버스는 **시총 상위 150**. jsonl 은 시총 내림차순이므로 앞 N 줄로 재현된다. */
const UNITOP = Number(argOf('--unitop', 0));   // 0 = 전 281종목
const MKTN = Number(argOf('--mktn', 0));       // 시장요인 계산 종목수. 0 = 전 종목
/**
 * ★ --firstbar : 라이브가 09:05 스캔에서 내는 신호를 재현한다.
 *   라이브는 09:00:05 스냅샷 대비 09:05:05 스냅샷으로 잔차를 잰다 = **시초가 대비 첫 5분**.
 *   백테는 `i>=1` 이라 09:00 봉을 신호로 쓰지 않는다(이전 봉이 없다) → 이 신호 유형은
 *   **백테에서 한 번도 검증된 적이 없다.** 라이브 11건 중 8건이 09:05/09:10 스캔이다.
 *   이 플래그는 09:00봉을 "이전 봉 = 시초가" 로 취급해 그 케이스만 따로 측정한다.
 */
const FIRSTBAR = ARGV.includes('--firstbar');

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

/** 무손절 + TP + 시간청산 (라이브 base 와 동일) */
function simExit(b1, eIdx, ePx, tp, maxMin, flatHm) {
  const TPx = ePx * (1 + tp / 100);
  const d0 = day(b1[eIdx].t);
  for (let i = eIdx; i < b1.length && i - eIdx < maxMin; i++) {
    const b = b1[i];
    if (day(b.t) !== d0) break;
    if (b.h >= TPx) return { ret: tp, why: 'TP', min: i - eIdx };
    if (hm(b.t) >= flatHm) return { ret: (b.c / ePx - 1) * 100, why: 'EOD', min: i - eIdx };
  }
  const last = Math.min(b1.length - 1, eIdx + maxMin - 1);
  return { ret: (b1[last].c / ePx - 1) * 100, why: 'TIME', min: last - eIdx };
}

// ══ 1패스: 시장요인 + 그날 시장 방향 ══════════════════════════════════
const mkt = new Map();      // "YYYY-MM-DD HHMM" → {s,n}
const mktDay = new Map();   // "YYYY-MM-DD" → {s,n}  (당일 시가→종가 평균)
/**
 * ★ 첫 봉 전용 시장요인. 1패스의 `mkt` 은 i>=1 만 담아서 09:00 키가 **없다** →
 *   firstbar 모드에서 `mr == null` 로 전 신호가 조용히 사라진다(신호 0건 = 거짓 음성).
 *   라이브가 09:05 스캔에서 쓰는 시장요인은 "전 종목의 시초가 대비 5분 수익 평균"이므로
 *   그것과 같은 정의로 따로 쌓는다.
 */
const mktFirst = new Map(); // "YYYY-MM-DD" → {s,n}  (첫 봉: 시초가 대비 종가)
{
  let n = 0;
  const rl = createInterface({ input: createReadStream(FILE) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (LIMIT && n >= LIMIT) break;
    if (MKTN && n >= MKTN) break;
    let j; try { j = JSON.parse(line); } catch { continue; }
    n++;
    const bars = aggregate([...j.bars].reverse(), TF);
    const dayOpen = new Map(), dayClose = new Map();
    for (let i = 0; i < bars.length; i++) {
      const d = day(bars[i].t);
      if (!dayOpen.has(d)) dayOpen.set(d, bars[i].o);
      dayClose.set(d, bars[i].c);
      if (i === 0 || day(bars[i].t) !== day(bars[i - 1].t) || !(bars[i - 1].c > 0)) {
        // 당일 첫 봉 = 시초가 대비 (라이브 09:05 스캔의 시장요인 정의)
        if (bars[i].o > 0) { const of = mktFirst.get(d) ?? { s: 0, n: 0 }; of.s += bars[i].c / bars[i].o - 1; of.n++; mktFirst.set(d, of); }
        continue;
      }
      const k = d + ' ' + hm(bars[i].t);
      const o = mkt.get(k) ?? { s: 0, n: 0 };
      o.s += bars[i].c / bars[i - 1].c - 1; o.n++; mkt.set(k, o);
    }
    for (const [d, op] of dayOpen) {
      const cl = dayClose.get(d);
      if (!(op > 0) || !(cl > 0)) continue;
      const o = mktDay.get(d) ?? { s: 0, n: 0 };
      o.s += cl / op - 1; o.n++; mktDay.set(d, o);
    }
  }
  console.log(`[1패스] 시장요인 ${mkt.size.toLocaleString()} 시점 · ${mktDay.size} 일 (${n}종목)`);
}
const MKT_MIN = MKTN ? Math.max(5, Math.floor(MKTN * 0.5)) : 20;
const mktRet = (k) => { const o = mkt.get(k); return o && o.n >= MKT_MIN ? o.s / o.n : null; };
const mktDayRet = (d) => { const o = mktDay.get(d); return o && o.n >= 20 ? o.s / o.n : null; };
const mktFirstRet = (d) => { const o = mktFirst.get(d); return o && o.n >= MKT_MIN ? o.s / o.n : null; };

// ══ 2패스: 신호 + 특징 + 결과 ═════════════════════════════════════════
const trades = [];
let nStock = 0, nUsed = 0, nFire = 0, nFilled = 0;
{
  const rl = createInterface({ input: createReadStream(FILE) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (LIMIT && nStock >= LIMIT) break;
    if (UNITOP && nStock >= UNITOP) break;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const rank = nStock;            // jsonl 순서 = 시총 내림차순
    nStock++;
    const b1 = [...j.bars].reverse();
    if (b1.length < 500) continue;
    nUsed++;
    const bars = aggregate(b1, TF);

    // 당일 첫 봉 인덱스 맵 (시가 갭·당일 누적 계산용)
    const dayFirst = new Map();
    for (let i = 0; i < bars.length; i++) if (!dayFirst.has(day(bars[i].t))) dayFirst.set(day(bars[i].t), i);

    const iStart = FIRSTBAR ? 0 : 1;
    for (let i = iStart; i < bars.length - 1; i++) {
      const t = hm(bars[i].t);
      if (t < T0 || t >= T1) continue;
      const d = day(bars[i].t);
      const f0 = dayFirst.get(d);
      const isFirstBar = i === f0;
      if (FIRSTBAR && !isFirstBar) continue;          // firstbar 모드는 첫 봉만
      if (!FIRSTBAR && isFirstBar) continue;          // 기본 모드는 첫 봉 제외(=기존 백테와 동일)
      if (day(bars[i + 1].t) !== d) continue;

      // 잔차: 기본 = 직전 봉 종가 대비 / firstbar = 시초가(당일 첫 봉 시가) 대비
      let prevRef;
      if (isFirstBar) prevRef = bars[i].o;
      else { if (day(bars[i - 1].t) !== d || !(bars[i - 1].c > 0)) continue; prevRef = bars[i - 1].c; }
      if (!(prevRef > 0)) continue;
      const mr = isFirstBar ? mktFirstRet(d) : mktRet(d + ' ' + hm(bars[i].t));
      if (mr == null) continue;
      const resid = (bars[i].c / prevRef - 1) - mr;
      if (!(resid <= -RESID)) continue;
      nFire++;

      // ── 특징 (전부 신호 확정 시점까지의 정보만 — 룩어헤드 금지) ──
      const openPx = bars[f0].o;
      const dayRet = openPx > 0 ? (bars[i].c / openPx - 1) * 100 : NaN;      // 당일 시가 대비 누적
      const prevResid = (i - 1 > f0 && day(bars[i - 1].t) === d && bars[i - 2] && day(bars[i - 2].t) === d && bars[i - 2].c > 0)
        ? ((bars[i - 1].c / bars[i - 2].c - 1) - (mktRet(d + ' ' + hm(bars[i - 1].t)) ?? 0)) * 100 : NaN;  // 직전 봉 잔차(연속하락?)
      const rng = bars[i].h - bars[i].l;
      const barPos = rng > 0 ? (bars[i].c - bars[i].l) / rng : 0.5;           // 봉내 종가 위치(0=저점마감)
      // 거래량 배수: 당일 직전 봉들 평균 대비
      let vs = 0, vn = 0;
      for (let k = f0; k < i; k++) { vs += bars[k].v; vn++; }
      const volRatio = vn > 0 && vs > 0 ? bars[i].v / (vs / vn) : NaN;
      // 최근 20분 평균 고저폭(%) = 변동성
      let ar = 0, an = 0;
      for (let k = Math.max(f0, i - 4); k <= i; k++) { if (bars[k].c > 0) { ar += (bars[k].h - bars[k].l) / bars[k].c; an++; } }
      const atrPct = an > 0 ? ar / an * 100 : NaN;
      const gapPct = (() => {
        // 전일 마지막 봉 대비 시가 갭
        const pi = f0 - 1;
        if (pi < 0 || !(bars[pi].c > 0)) return NaN;
        return (openPx / bars[pi].c - 1) * 100;
      })();
      const mdr = mktDayRet(d);

      // ── 진입: 패시브 지정가 (다음 봉 시가 −PASSIVE%) ──
      const sigIdx = i + 1;
      let eIdx = bars[sigIdx].i0;
      const eb = b1[eIdx];
      if (!eb || day(eb.t) !== d) continue;
      const lim = eb.o * (1 - PASSIVE / 100);
      let fi = -1;
      for (let k = eIdx; k < Math.min(b1.length, eIdx + FILLWIN); k++) {
        if (day(b1[k].t) !== day(eb.t)) break;
        if (b1[k].l < lim) { fi = k; break; }
      }
      if (fi < 0) continue;                     // 미체결 = 거래 없음
      nFilled++;
      const r = simExit(b1, fi, lim, TP, HOLD, FLAT);
      trades.push({
        d, code: j.code ?? String(rank), rank, hm: hm(bars[i].t),
        resid: resid * 100, dayRet, prevResid, barPos, volRatio, atrPct, gapPct,
        mktRet: mr * 100, mktDay: mdr == null ? NaN : mdr * 100,
        net: r.ret - COST, why: r.why, min: r.min,
      });
    }
  }
}

// ══ 분해 출력 ═════════════════════════════════════════════════════════
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const fmt = (v, d = 2) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) : '-');

function stat(tr) {
  if (!tr.length) return { n: 0 };
  const w = tr.filter(t => t.net > 0);
  return { n: tr.length, wr: w.length / tr.length * 100, ev: avg(tr.map(t => t.net)),
    tp: tr.filter(t => t.why === 'TP').length / tr.length * 100,
    med: (() => { const s = tr.map(t => t.net).sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; })() };
}

console.log(`\n${'='.repeat(96)}`);
console.log(`횡단면 잔차 스캘핑 승/패 귀인 — 잔차 ≤ −${(RESID * 100).toFixed(0)}% · 패시브 −${PASSIVE}% · TP${TP} 무손절 상한${HOLD}분 · 비용 ${COST}%`);
console.log(`${nUsed}종목${UNITOP ? ` (시총상위 ${UNITOP} 제한)` : ''}${MKTN ? ` · 시장요인 ${MKTN}종목` : ''}${FIRSTBAR ? ' · **개장 첫봉(시초가대비) 모드**' : ''} · ${T0}~${T1}`);
const all = stat(trades);
console.log(`신호 ${nFire} · 체결 ${nFilled}(${(nFilled / Math.max(1, nFire) * 100).toFixed(1)}%) · 거래 ${all.n} · 순승률 ${all.wr?.toFixed(1)}% · EV ${fmt(all.ev, 3)}% · 중위 ${fmt(all.med, 3)} · TP율 ${all.tp?.toFixed(0)}%`);
console.log('='.repeat(96));

if (!trades.length) { console.log('거래 0건'); process.exit(0); }

/** 축을 분위로 잘라 승률·EV 를 낸다. 단조성이 있으면 진짜 판별자, 들쭉날쭉하면 노이즈. */
function bucketBy(label, key, nq = 5, asc = true) {
  const ok = trades.filter(t => Number.isFinite(t[key]));
  if (ok.length < 20) { console.log(`\n[${label}] 표본 부족(${ok.length})`); return; }
  const sorted = [...ok].sort((a, b) => (asc ? a[key] - b[key] : b[key] - a[key]));
  const size = Math.floor(sorted.length / nq);
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);
  console.log(`${'분위'.padStart(6)}${'구간'.padStart(20)}${'n'.padStart(6)}${'순승률'.padStart(9)}${'EV%'.padStart(10)}${'중위'.padStart(9)}${'TP율'.padStart(7)}`);
  for (let q = 0; q < nq; q++) {
    const seg = sorted.slice(q * size, q === nq - 1 ? sorted.length : (q + 1) * size);
    const s = stat(seg);
    const lo = seg[0][key], hi = seg[seg.length - 1][key];
    console.log(`${('Q' + (q + 1)).padStart(6)}${`${lo.toFixed(2)}~${hi.toFixed(2)}`.padStart(20)}${String(s.n).padStart(6)}` +
      `${(s.wr.toFixed(1) + '%').padStart(9)}${fmt(s.ev, 3).padStart(10)}${fmt(s.med, 2).padStart(9)}${(s.tp.toFixed(0) + '%').padStart(7)}`);
  }
}

bucketBy('① 잔차 크기 (깊을수록 Q1)', 'resid', 5, true);
bucketBy('② 당일 누적수익 (많이 빠진 종목일수록 Q1)', 'dayRet', 5, true);
bucketBy('③ 직전봉 잔차 (연속하락일수록 Q1)', 'prevResid', 5, true);
bucketBy('④ 신호봉 종가위치 (0=저점마감)', 'barPos', 5, true);
bucketBy('⑤ 거래량 배수', 'volRatio', 5, true);
bucketBy('⑥ 변동성 atr%', 'atrPct', 5, true);
bucketBy('⑦ 시가 갭%', 'gapPct', 5, true);
bucketBy('⑧ 그 시점 시장 5분수익%', 'mktRet', 5, true);
bucketBy('⑨ 그날 시장 방향%', 'mktDay', 5, true);
bucketBy('⑩ 시총 순위 (0=최대형주)', 'rank', 5, true);

// 시간대
console.log(`\n── ⑪ 시간대 ${'─'.repeat(50)}`);
const byHm = new Map();
for (const t of trades) {
  const k = t.hm < '0930' ? '0900-0930' : t.hm < '1000' ? '0930-1000' : t.hm < '1100' ? '1000-1100'
    : t.hm < '1300' ? '1100-1300' : t.hm < '1430' ? '1300-1430' : '1430-1510';
  (byHm.get(k) ?? byHm.set(k, []).get(k)).push(t);
}
console.log(`${'구간'.padStart(12)}${'n'.padStart(6)}${'순승률'.padStart(9)}${'EV%'.padStart(10)}${'TP율'.padStart(7)}`);
for (const k of [...byHm.keys()].sort()) {
  const s = stat(byHm.get(k));
  console.log(`${k.padStart(12)}${String(s.n).padStart(6)}${(s.wr.toFixed(1) + '%').padStart(9)}${fmt(s.ev, 3).padStart(10)}${(s.tp.toFixed(0) + '%').padStart(7)}`);
}

// 청산사유
console.log(`\n── ⑫ 청산사유 ${'─'.repeat(48)}`);
for (const why of ['TP', 'TIME', 'EOD']) {
  const seg = trades.filter(t => t.why === why);
  if (!seg.length) continue;
  console.log(`${why.padStart(6)}: n=${String(seg.length).padStart(4)} (${(seg.length / trades.length * 100).toFixed(1)}%) · EV ${fmt(avg(seg.map(t => t.net)), 3)}% · 평균보유 ${avg(seg.map(t => t.min)).toFixed(1)}분`);
}

// 손실 꼬리
const sortedNet = [...trades].sort((a, b) => a.net - b.net);
const worst = sortedNet.slice(0, Math.max(1, Math.floor(trades.length * 0.05)));
console.log(`\n── ⑬ 최악 5% (n=${worst.length}) ${'─'.repeat(40)}`);
console.log(`  평균 ${fmt(avg(worst.map(t => t.net)), 2)}% · 전체 EV 기여 ${fmt(worst.reduce((a, b) => a + b.net, 0) / trades.length, 3)}%p`);
console.log(`  특징 평균: 잔차 ${fmt(avg(worst.map(t => t.resid)), 2)} (전체 ${fmt(avg(trades.map(t => t.resid)), 2)}) · ` +
  `당일누적 ${fmt(avg(worst.map(t => t.dayRet)), 2)} (전체 ${fmt(avg(trades.filter(t => Number.isFinite(t.dayRet)).map(t => t.dayRet)), 2)}) · ` +
  `종가위치 ${avg(worst.map(t => t.barPos)).toFixed(2)} (전체 ${avg(trades.map(t => t.barPos)).toFixed(2)})`);
console.log(`  최악 5% 제외 시 EV ${fmt(avg(sortedNet.slice(worst.length).map(t => t.net)), 3)}%`);

// IS/OOS
const si = stat(trades.filter(t => t.d <= IS_END)), so = stat(trades.filter(t => t.d > IS_END));
console.log(`\n── ⑭ IS/OOS ${'─'.repeat(50)}`);
console.log(`  IS  n=${si.n} 승률 ${si.wr?.toFixed(1)}% EV ${fmt(si.ev, 3)}`);
console.log(`  OOS n=${so.n} 승률 ${so.wr?.toFixed(1)}% EV ${fmt(so.ev, 3)}`);

// 일자별 (라이브 2일이 얼마나 흔한 날인지 보기 위함)
const byDay = new Map();
for (const t of trades) (byDay.get(t.d) ?? byDay.set(t.d, []).get(t.d)).push(t);
const dayStats = [...byDay.entries()].map(([d, tr]) => ({ d, ...stat(tr) })).filter(x => x.n >= 3);
const badDays = dayStats.filter(x => x.wr <= 40).length;
console.log(`\n── ⑮ 일자 분포 (n≥3 인 ${dayStats.length}일) ${'─'.repeat(35)}`);
console.log(`  승률 ≤40% 인 날: ${badDays}일 (${(badDays / dayStats.length * 100).toFixed(0)}%) · EV<0 인 날: ${dayStats.filter(x => x.ev < 0).length}일 (${(dayStats.filter(x => x.ev < 0).length / dayStats.length * 100).toFixed(0)}%)`);
console.log(`  일별 EV 중위 ${fmt([...dayStats.map(x => x.ev)].sort((a, b) => a - b)[Math.floor(dayStats.length / 2)], 3)} · 최악 ${fmt(Math.min(...dayStats.map(x => x.ev)), 2)} · 최선 ${fmt(Math.max(...dayStats.map(x => x.ev)), 2)}`);
