/**
 * optimize-1m-exit.mjs — 분봉 진입(V2_intra·V3_ubase 등)에 **가장 맞는 청산 구조**를 데이터로 찾는다.
 * 2026-07-27, 사용자 지시: "청산 조건은 전체 일자를 다 보면서 분석해서 판단해".
 *
 * 왜 파라미터 난사를 안 하나: 1,000건에 1,200조합을 돌리면 최고 조합은 거의 확실히 과최적화다(오늘 위양성 5건).
 *   그래서 ① **구조 비교 먼저**(트레일만 / 고정손절만 / 손절+목표 / 시간청산 / 당일청산 …)
 *          ② 승자 구조에서만 파라미터 소폭 스윕
 *          ③ **전반 42일(IS) / 후반 42일(OOS) 분리** — OOS에서 무너지면 기각
 *
 * 진입 판정은 backtest-1m-rules.mjs와 동일(분봉 1분 리플레이 + 전일까지 일봉 문맥).
 * 청산은 전부 **분봉**으로 시뮬레이션한다(진입 당일 청산 포착·고저 순서 확정 — 일봉은 2.4%p 낙관 편향 실측).
 *
 * 실행: node optimize-1m-exit.mjs [--rules V2_intra,V3_ubase] [--dir data-1m] [--out optimize-1m-result.txt]
 */
import { createReadStream, readdirSync, readFileSync, writeFileSync } from 'fs';
import readline from 'readline';
import { join } from 'path';
import { score } from './scan-1m-core.mjs';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DIR = String(argOf('--dir', 'data-1m'));
const OUT = String(argOf('--out', 'optimize-1m-result.txt'));
const WANT = String(argOf('--rules', 'V2_intra,V3_ubase,A_hi120,B_rs')).split(',');
const FROM = String(argOf('--from', ''));   // 공통구간 제한(예 20260325) — 종목별 데이터 깊이가 달라
//   전반 구간엔 중소형주만 남는다(대형주 60,000봉=84일 vs 중소형 154일). IS/OOS 오염 제거용.
const MIN_BARS = 30, COST = 0.33, MAXDAYS = 10;
const out = [];
const say = (m) => { console.log(m); out.push(m); };

const GATE = { A_hi120: 'gatesA', B_rs: 'gates', C_self: 'gatesC', D_nochase: 'gatesD', V_bounce: 'gatesV', V2_intra: 'gatesV2', V3_ubase: 'gatesV3' };

// ── 일봉(PIT 문맥) ──────────────────────────────────────────────────────────
const HIST = new Map();
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream('candles-daily.jsonl') });
  rl.on('line', (l) => { if (!l.trim()) return; try { const j = JSON.parse(l); if (j.c?.length >= 200) HIST.set(j.code, j); } catch {} });
  rl.on('close', res);
});
const mkt = HIST.get('005930');
const mIdx = new Map(mkt.d.map((d, i) => [d, i]));
function dailyAt(j, i) {
  let ma20 = 0; for (let k = i - 19; k <= i; k++) ma20 += j.c[k];
  let ma60 = 0; for (let k = i - 59; k <= i; k++) ma60 += j.c[k];
  let hi120 = 0; for (let k = i - 119; k <= i; k++) hi120 = Math.max(hi120, j.h[k]);
  let tr = 0; for (let k = i - 13; k <= i; k++) tr += Math.max(j.h[k] - j.l[k], Math.abs(j.h[k] - j.c[k - 1]), Math.abs(j.l[k] - j.c[k - 1]));
  let vol20 = 0; for (let k = i - 19; k <= i; k++) vol20 += j.v[k];
  let tv = 0; for (let k = i - 19; k <= i; k++) tv += j.c[k] * j.v[k];
  let low19 = Infinity, low19I = i; for (let k = i - 18; k <= i; k++) if (j.l[k] < low19) { low19 = j.l[k]; low19I = k; }
  return { prevClose: j.c[i], ma20: ma20 / 20, ma60: ma60 / 60, hi120, atrPct: (tr / 14) / j.c[i] * 100, vol20: vol20 / 20, turnover: tv / 20, ret20: j.c[i] / j.c[i - 20] - 1, low19, low19Ago: i - low19I + 1 };
}

// ── 진입 트리거 수집 + 진입 이후 분봉 경로 저장 ──────────────────────────────
// ★ OOM 수정(2026-07-28): 트리거마다 3,900봉 경로를 JS 배열로 들면 4,400건 × 3배열에서 1GB를 넘긴다(VM RAM 956MB).
//   → **룰 하나씩** 수집·분석하고(파일은 룰마다 다시 읽는다) 경로는 **Int32Array**로 저장한다.
const files = readdirSync(DIR).filter(f => f.endsWith('.jsonl'));
let stockDays = 0;
function collect(RULE) {
 const acc = [];
 stockDays = 0;
 for (const f of files) {
  const code = f.replace('.jsonl', '');
  const j = HIST.get(code);
  if (!j) continue;
  let rec; try { rec = JSON.parse(readFileSync(join(DIR, f), 'utf8')); } catch { continue; }
  if (!rec?.t?.length) continue;
  const byDay = new Map();
  for (let i = 0; i < rec.t.length; i++) {
    const k = new Date((rec.t[i] + 32400) * 1000);
    const hh = k.getUTCHours(), mm = k.getUTCMinutes();
    if (hh < 9 || hh > 15 || (hh === 15 && mm > 30)) continue;
    const day = k.toISOString().slice(0, 10).replace(/-/g, '');
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ hhmm: String(hh).padStart(2, '0') + String(mm).padStart(2, '0'), o: rec.o[i], h: rec.h[i], l: rec.l[i], c: rec.c[i], v: rec.v[i] });
  }
  const dayList = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, bars]) => ({ day, bars: bars.slice().sort((x, y) => x.hhmm.localeCompare(y.hhmm)) }));
  const dayPos = new Map(dayList.map((x, i) => [x.day, i]));

  for (const { day, bars } of dayList) {
    if (FROM && day < FROM) continue;
    if (bars.length < MIN_BARS + 5) continue;
    const di = j.d.indexOf(day);
    if (di < 130) continue;
    const mi = mIdx.get(day); if (mi == null || mi < 130) continue;
    stockDays++;
    const d = dailyAt(j, di - 1);
    const MKT_RET20 = mkt.c[mi - 1] / mkt.c[mi - 21] - 1;
    let hit = false;
    for (let bi = MIN_BARS - 1; bi < bars.length && !hit; bi++) {
      const cut = bars.slice(0, bi + 1);
      const s = score({ code, now: cut.at(-1).c, prevClose: d.prevClose, acmlVol: cut.reduce((a, b) => a + b.v, 0), bars: cut }, d, { MKT_RET20, elapsed: Math.max(1, Number(cut.at(-1).hhmm.slice(0, 2)) * 60 + Number(cut.at(-1).hhmm.slice(2, 4)) - 540) });
      {
        const rule = RULE;
        if (s[GATE[rule]].length) continue;
        hit = true;
        // 진입 이후 분봉 경로(최대 MAXDAYS 거래일) 평탄화 + 일 경계 기록
        const dpi = dayPos.get(day);
        const H = [], L = [], C = [], dayEnd = [];
        for (let k = bi + 1; k < bars.length; k++) { H.push(bars[k].h); L.push(bars[k].l); C.push(bars[k].c); }
        dayEnd.push(H.length);
        for (let dd = dpi + 1; dd < Math.min(dayList.length, dpi + MAXDAYS); dd++) {
          for (const b of dayList[dd].bars) { H.push(b.h); L.push(b.l); C.push(b.c); }
          dayEnd.push(H.length);
        }
        if (H.length < 30) continue;                    // forward 경로 부족
        acc.push({ code, day, entry: s.now, atrPct: d.atrPct, H: Int32Array.from(H), L: Int32Array.from(L), C: Int32Array.from(C), dayEnd: Int32Array.from(dayEnd), full: dayEnd.length >= MAXDAYS });
      }
    }
  }
 }
 return acc;
}

// ── 청산 구조 정의 ──────────────────────────────────────────────────────────
// e: {trail, hard, tp, tpAll, maxDays, sameDayClose}  (0/null = 미사용)
function simulate(t, e) {
  const { entry, H, L, C, dayEnd } = t;
  const lim = Math.max(1, e.maxDays ? (dayEnd[Math.min(e.maxDays, dayEnd.length) - 1] || H.length) : H.length);
  let runHi = entry, qty = 1, realized = 0, tpDone = false;
  for (let i = 0; i < lim; i++) {
    const hardLv = e.hard ? entry * (1 - e.hard / 100) : 0;
    const trailLv = e.trail ? runHi * (1 - e.trail / 100) : 0;
    const lv = Math.max(hardLv, trailLv);
    if (lv > 0 && L[i] <= lv) return realized + qty * ((lv / entry - 1) * 100) - COST;
    if (e.tp && !tpDone && H[i] >= entry * (1 + e.tp / 100)) {
      if (e.tpAll) return realized + qty * e.tp - COST;                 // 목표가 전량 청산
      realized += 0.5 * e.tp; qty -= 0.5; tpDone = true;                 // 절반 익절
    }
    runHi = Math.max(runHi, H[i]);
  }
  return realized + qty * ((C[lim - 1] / entry - 1) * 100) - COST;
}
/** 사후 최적(상한): 경로 최고가에 청산 */
const hindsight = (t) => (Math.max(...t.H) / t.entry - 1) * 100 - COST;

const STRUCT = [];
// S1 트레일만
for (const trail of [4, 6, 8, 12]) STRUCT.push({ name: `S1 트레일${trail}`, trail, hard: 0, tp: 0, maxDays: 10 });
// S2 고정손절만 (트레일 없음 = 여력을 끝까지 열어둠)
for (const hard of [4, 7, 10, 14]) STRUCT.push({ name: `S2 손절${hard}`, trail: 0, hard, tp: 0, maxDays: 10 });
// S3 손절 + 목표가 전량
for (const hard of [7, 10]) for (const tp of [5, 8, 12, 20]) STRUCT.push({ name: `S3 손절${hard}+목표${tp}전량`, trail: 0, hard, tp, tpAll: true, maxDays: 10 });
// S4 현행 계열 (트레일+부분익절)
for (const trail of [4, 6, 8]) for (const tp of [6, 12]) STRUCT.push({ name: `S4 트레일${trail}+익절${tp}절반`, trail, hard: 7, tp, maxDays: 10 });
// S5 시간청산 (손절만 두고 N거래일 만기)
for (const days of [1, 2, 3, 5]) STRUCT.push({ name: `S5 손절7+${days}일만기`, trail: 0, hard: 7, tp: 0, maxDays: days });
// S6 당일 종가 청산 (오버나이트 회피)
STRUCT.push({ name: 'S6 당일종가청산', trail: 0, hard: 0, tp: 0, maxDays: 1 });
STRUCT.push({ name: 'S6 손절7+당일종가', trail: 0, hard: 7, tp: 0, maxDays: 1 });
// S7 ATR 비례
STRUCT.push({ name: 'S7 ATR트레일1.5x', atrTrail: 1.5, hard: 0, tp: 0, maxDays: 10 });
STRUCT.push({ name: 'S7 ATR손절2x', atrHard: 2.0, trail: 0, tp: 0, maxDays: 10 });

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const win = (a) => (a.length ? a.filter(v => v > 0).length / a.length * 100 : 0);

for (const rule of WANT) {
  const ts0 = collect(rule);
  const ts = ts0.filter(t => t.full);                 // 경로 10일 확보분만(만기 비교 공정)
  if (ts.length < 10) { say(`
### ${rule}: 경로 확보 ${ts.length}건 — 표본 부족, 스킵`); continue; }
  const days = [...new Set(ts.map(t => t.day))].sort();
  const mid = days[Math.floor(days.length / 2)];
  const IS = ts.filter(t => t.day < mid), OOS = ts.filter(t => t.day >= mid);
  const codes = [...new Set(ts.map(t => t.code))];
  say(`
### ${rule} — 트리거 ${ts.length}건 / 진입일 ${days.length}일 / 종목 ${codes.length} (IS ${IS.length}건·${days.filter(d => d < mid).length}일 / OOS ${OOS.length}건·${days.filter(d => d >= mid).length}일)`);
  say(`사후최적(상한) 평균 +${avg(ts.map(hindsight)).toFixed(2)}%`);
  const mk = (st, t) => ({ ...st, trail: st.atrTrail ? Math.min(15, Math.max(2, st.atrTrail * t.atrPct)) : st.trail, hard: st.atrHard ? Math.min(20, Math.max(3, st.atrHard * t.atrPct)) : st.hard });
  const rows = STRUCT.map(st => {
    const all = ts.map(t => simulate(t, mk(st, t)));
    return { st, name: st.name, all: avg(all), w: win(all), is: avg(IS.map(t => simulate(t, mk(st, t)))), oos: avg(OOS.map(t => simulate(t, mk(st, t)))) };
  }).sort((a, b) => b.all - a.all);
  say('청산 구조                    전체     승률 │ IS(전반)  OOS(후반)  일관성');
  for (const r of rows) {
    const consist = (r.is > 0 && r.oos > 0) ? '○ 둘다+' : (r.is > 0 || r.oos > 0) ? '△ 한쪽만' : '✗ 둘다-';
    say(`${r.name.padEnd(26)} ${((r.all >= 0 ? '+' : '') + r.all.toFixed(2) + '%').padStart(8)} ${r.w.toFixed(0).padStart(4)}% │ ${((r.is >= 0 ? '+' : '') + r.is.toFixed(2) + '%').padStart(8)} ${((r.oos >= 0 ? '+' : '') + r.oos.toFixed(2) + '%').padStart(9)}  ${consist}`);
  }
  // ★ 종목 부트스트랩 10회 (10시드 MC 상당) — IS·OOS 둘 다 + 인 구조만
  const cand = rows.filter(r => r.is > 0 && r.oos > 0).slice(0, 3);
  if (!cand.length) { say('→ IS·OOS 둘 다 + 인 구조 없음 → 부트스트랩 생략(채택 후보 0)'); continue; }
  say(`
── 종목 부트스트랩 10회 (종목 ${codes.length}개 중 80% 무작위, 10시드 MC 상당) ──`);
  say('구조                        시드별 평균손익(10회)                     승/패  중위');
  for (const r of cand) {
    const seeds = [];
    for (let sd = 1; sd <= 10; sd++) {
      let h = sd * 2654435761 >>> 0;
      const pick = new Set(codes.filter(() => { h = (h * 1103515245 + 12345) >>> 0; return (h >>> 16) % 100 < 80; }));
      const sub = ts.filter(t => pick.has(t.code));
      seeds.push(sub.length ? avg(sub.map(t => simulate(t, mk(r.st, t)))) : 0);
    }
    const pos = seeds.filter(v => v > 0).length;
    const med = [...seeds].sort((a, b) => a - b)[5];
    say(`${r.name.padEnd(26)} ${seeds.map(v => (v >= 0 ? '+' : '') + v.toFixed(2)).join(' ')}  ${pos}/10  ${med.toFixed(2)}%`);
  }
}
say('\n⚠️ 채택 기준: **IS·OOS 둘 다 + AND 부트스트랩 8/10 이상**. 단일경로 최고값은 과최적화 후보다.');
say('⚠️ 생존편향 · 독립 표본 크기는 진입일 수 · 청산은 전부 분봉 시뮬레이션');
writeFileSync(OUT, out.join('\n') + '\n');
console.log(`\n결과 저장: ${OUT}`);
