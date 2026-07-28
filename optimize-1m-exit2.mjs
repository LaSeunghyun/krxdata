/**
 * optimize-1m-exit2.mjs — 청산 구조 최적화 **단일패스 재작성** (2026-07-28)
 *
 * v1의 문제: OOM을 피하려 룰마다 234파일(560MB)을 재읽기 + score() 리플레이를 룰마다 반복 →
 *   C_self 하나에 1시간+, 7룰이면 하루. 실제 병목은 파일 I/O가 아니라 **score() 리플레이 7회 중복**이었다.
 * v2 해법: **한 번 읽고 한 번 리플레이하면서 7룰 게이트를 동시에 판정**하고,
 *   트리거가 잡히면 **그 자리에서 30개 청산 구조를 다 돌려 스칼라 수익률만 누적**한다(경로는 즉시 폐기).
 *   → 메모리는 스칼라 배열뿐(수MB), 작업량은 1/7.
 *
 * 검증 절차(v1과 동일): 구조 비교 → IS(전반)/OOS(후반) 분리 → 종목 부트스트랩 10회.
 *   채택 기준: **IS·OOS 둘 다 + AND 부트스트랩 8/10 이상**.
 * 청산은 전부 분봉 시뮬레이션(진입 당일 청산 포착·고저 순서 확정).
 *
 * 실행: node optimize-1m-exit2.mjs [--from 20260325] [--out optimize2-result.txt]
 */
import { createReadStream, readdirSync, readFileSync, writeFileSync } from 'fs';
import readline from 'readline';
import { join } from 'path';
import { score } from './scan-1m-core.mjs';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DIR = String(argOf('--dir', 'data-1m'));
const OUT = String(argOf('--out', 'optimize2-result.txt'));
const FROM = String(argOf('--from', ''));
const MIN_BARS = 30, COST = 0.33, MAXDAYS = 10;
const out = [];
const say = (m) => { console.log(m); out.push(m); };

const GATE = { A_hi120: 'gatesA', B_rs: 'gates', C_self: 'gatesC', D_nochase: 'gatesD', V_bounce: 'gatesV', V2_intra: 'gatesV2', V3_ubase: 'gatesV3' };
const RULES = Object.keys(GATE);

// ── 청산 구조 ────────────────────────────────────────────────────────────────
const STRUCT = [];
for (const trail of [4, 6, 8, 12]) STRUCT.push({ name: `S1 트레일${trail}`, trail, hard: 0, tp: 0, maxDays: 10 });
for (const hard of [4, 7, 10, 14]) STRUCT.push({ name: `S2 손절${hard}`, trail: 0, hard, tp: 0, maxDays: 10 });
for (const hard of [7, 10]) for (const tp of [5, 8, 12, 20]) STRUCT.push({ name: `S3 손절${hard}+목표${tp}전량`, trail: 0, hard, tp, tpAll: true, maxDays: 10 });
for (const trail of [4, 6, 8]) for (const tp of [6, 12]) STRUCT.push({ name: `S4 트레일${trail}+익절${tp}절반`, trail, hard: 7, tp, maxDays: 10 });
for (const days of [1, 2, 3, 5]) STRUCT.push({ name: `S5 손절7+${days}일만기`, trail: 0, hard: 7, tp: 0, maxDays: days });
STRUCT.push({ name: 'S6 당일종가청산', trail: 0, hard: 0, tp: 0, maxDays: 1 });
STRUCT.push({ name: 'S6 손절7+당일종가', trail: 0, hard: 7, tp: 0, maxDays: 1 });
STRUCT.push({ name: 'S7 ATR손절2x', atrHard: 2.0, trail: 0, tp: 0, maxDays: 10 });
STRUCT.push({ name: 'S7 ATR트레일1.5x', atrTrail: 1.5, hard: 0, tp: 0, maxDays: 10 });

function simulate(H, L, C, dayEnd, entry, e) {
  const lim = Math.max(1, e.maxDays ? (dayEnd[Math.min(e.maxDays, dayEnd.length) - 1] || H.length) : H.length);
  let runHi = entry, qty = 1, realized = 0, tpDone = false;
  const hardLv = e.hard ? entry * (1 - e.hard / 100) : 0;
  for (let i = 0; i < lim; i++) {
    const trailLv = e.trail ? runHi * (1 - e.trail / 100) : 0;
    const lv = hardLv > trailLv ? hardLv : trailLv;
    if (lv > 0 && L[i] <= lv) return realized + qty * ((lv / entry - 1) * 100) - COST;
    if (e.tp && !tpDone && H[i] >= entry * (1 + e.tp / 100)) {
      if (e.tpAll) return realized + qty * e.tp - COST;
      realized += 0.5 * e.tp; qty -= 0.5; tpDone = true;
    }
    if (H[i] > runHi) runHi = H[i];
  }
  return realized + qty * ((C[lim - 1] / entry - 1) * 100) - COST;
}

// ── 일봉 PIT ────────────────────────────────────────────────────────────────
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

// ── 단일패스 ────────────────────────────────────────────────────────────────
const acc = {};   // rule → { day:[], code:[], up:[], dn:[], rets: [구조별 배열] }
for (const r of RULES) acc[r] = { day: [], code: [], up: [], dn: [], rets: STRUCT.map(() => []) };
const files = readdirSync(DIR).filter(f => f.endsWith('.jsonl'));
let stockDays = 0, done = 0;
const t0 = Date.now();

for (const f of files) {
  const code = f.replace('.jsonl', '');
  const j = HIST.get(code);
  if (!j) { done++; continue; }
  let rec; try { rec = JSON.parse(readFileSync(join(DIR, f), 'utf8')); } catch { done++; continue; }
  if (!rec?.t?.length) { done++; continue; }
  const byDay = new Map();
  for (let i = 0; i < rec.t.length; i++) {
    const k = new Date((rec.t[i] + 32400) * 1000);
    const hh = k.getUTCHours(), mm = k.getUTCMinutes();
    if (hh < 9 || hh > 15 || (hh === 15 && mm > 30)) continue;
    const day = k.toISOString().slice(0, 10).replace(/-/g, '');
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ hhmm: String(hh).padStart(2, '0') + String(mm).padStart(2, '0'), o: rec.o[i], h: rec.h[i], l: rec.l[i], c: rec.c[i], v: rec.v[i] });
  }
  const dayList = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, bars]) => ({ day, bars: bars.sort((x, y) => x.hhmm.localeCompare(y.hhmm)) }));

  for (let dpi = 0; dpi < dayList.length; dpi++) {
    const { day, bars } = dayList[dpi];
    if (FROM && day < FROM) continue;
    if (bars.length < MIN_BARS + 5) continue;
    const di = j.d.indexOf(day);
    if (di < 130) continue;
    const mi = mIdx.get(day); if (mi == null || mi < 130) continue;
    stockDays++;
    const d = dailyAt(j, di - 1);
    const MKT_RET20 = mkt.c[mi - 1] / mkt.c[mi - 21] - 1;
    const hit = new Set();
    const cut = [];                                  // ★ slice 대신 누적 배열(O(n²) 할당 제거)
    let vSum = 0;
    for (let bi = 0; bi < bars.length && hit.size < RULES.length; bi++) {
      cut.push(bars[bi]); vSum += bars[bi].v;
      if (bi < MIN_BARS - 1) continue;
      const t = bars[bi].hhmm;
      const s = score({ code, now: bars[bi].c, prevClose: d.prevClose, acmlVol: vSum, bars: cut }, d,
        { MKT_RET20, elapsed: Math.max(1, Number(t.slice(0, 2)) * 60 + Number(t.slice(2, 4)) - 540) });
      for (const rule of RULES) {
        if (hit.has(rule) || s[GATE[rule]].length) continue;
        hit.add(rule);
        // 경로 구성 → 즉시 30구조 평가 → 경로 폐기 (메모리 상수)
        const H = [], L = [], C = [], dayEnd = [];
        for (let k = bi + 1; k < bars.length; k++) { H.push(bars[k].h); L.push(bars[k].l); C.push(bars[k].c); }
        dayEnd.push(H.length);
        for (let dd = dpi + 1; dd < Math.min(dayList.length, dpi + MAXDAYS); dd++) {
          for (const b of dayList[dd].bars) { H.push(b.h); L.push(b.l); C.push(b.c); }
          dayEnd.push(H.length);
        }
        if (H.length < 30 || dayEnd.length < MAXDAYS) continue;   // forward 10일 미확보분 제외
        const a = acc[rule], entry = s.now;
        let mx = 0, mn = Infinity;
        for (let k = 0; k < H.length; k++) { if (H[k] > mx) mx = H[k]; if (L[k] < mn) mn = L[k]; }
        a.day.push(day); a.code.push(code);
        a.up.push((mx / entry - 1) * 100); a.dn.push((mn / entry - 1) * 100);
        for (let si = 0; si < STRUCT.length; si++) {
          const st = STRUCT[si];
          const e = st.atrTrail || st.atrHard
            ? { ...st, trail: st.atrTrail ? Math.min(15, Math.max(2, st.atrTrail * d.atrPct)) : st.trail, hard: st.atrHard ? Math.min(20, Math.max(3, st.atrHard * d.atrPct)) : st.hard }
            : st;
          a.rets[si].push(simulate(H, L, C, dayEnd, entry, e));
        }
      }
    }
  }
  if (++done % 25 === 0) {
    const el = (Date.now() - t0) / 1000;
    say(`  ${done}/${files.length} · 종목-일 ${stockDays.toLocaleString()} · 트리거 ${RULES.map(r => acc[r].day.length).reduce((a, b) => a + b, 0).toLocaleString()} · ${el.toFixed(0)}s (남은 예상 ${((el / done) * (files.length - done) / 60).toFixed(0)}분)`);
  }
}

// ── 리포트 ──────────────────────────────────────────────────────────────────
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const win = (a) => (a.length ? a.filter(v => v > 0).length / a.length * 100 : 0);
say(`\n=== 청산 구조 최적화 (종목-일 ${stockDays.toLocaleString()}${FROM ? ` · ${FROM}~ 제한` : ''}) ===`);

for (const rule of RULES) {
  const a = acc[rule];
  if (a.day.length < 30) { say(`\n### ${rule}: 트리거 ${a.day.length}건 — 표본 부족, 스킵`); continue; }
  const days = [...new Set(a.day)].sort();
  const mid = days[Math.floor(days.length / 2)];
  const codes = [...new Set(a.code)];
  const isIdx = [], oosIdx = [];
  a.day.forEach((dd, i) => (dd < mid ? isIdx : oosIdx).push(i));
  say(`\n### ${rule} — 트리거 ${a.day.length}건 / 진입일 ${days.length}일 / 종목 ${codes.length} (IS ${isIdx.length} / OOS ${oosIdx.length})`);
  say(`여력 +${avg(a.up).toFixed(2)}% / 위험 ${avg(a.dn).toFixed(2)}% / RR ${(avg(a.up) / Math.abs(avg(a.dn))).toFixed(2)} · 사후최적 상한 +${(avg(a.up) - COST).toFixed(2)}%`);
  const rows = STRUCT.map((st, si) => ({
    st, si, name: st.name, all: avg(a.rets[si]), w: win(a.rets[si]),
    is: avg(isIdx.map(i => a.rets[si][i])), oos: avg(oosIdx.map(i => a.rets[si][i])),
  })).sort((x, y) => y.all - x.all);
  say('청산 구조                    전체     승률 │ IS       OOS      일관성');
  for (const r of rows.slice(0, 12)) {
    const c = (r.is > 0 && r.oos > 0) ? '○ 둘다+' : (r.is > 0 || r.oos > 0) ? '△ 한쪽만' : '✗ 둘다-';
    say(`${r.name.padEnd(26)} ${((r.all >= 0 ? '+' : '') + r.all.toFixed(2) + '%').padStart(8)} ${r.w.toFixed(0).padStart(4)}% │ ${((r.is >= 0 ? '+' : '') + r.is.toFixed(2) + '%').padStart(8)} ${((r.oos >= 0 ? '+' : '') + r.oos.toFixed(2) + '%').padStart(8)}  ${c}`);
  }
  if (rows.length > 12) say(`… 하위 ${rows.length - 12}개 생략 (최하 ${rows.at(-1).name} ${rows.at(-1).all.toFixed(2)}%)`);
  const cand = rows.filter(r => r.is > 0 && r.oos > 0).slice(0, 3);
  if (!cand.length) { say('→ IS·OOS 둘 다 + 인 구조 없음 → 채택 후보 0'); continue; }
  say(`── 종목 부트스트랩 10회 (종목 ${codes.length}개 중 80%) ──`);
  for (const r of cand) {
    const seeds = [];
    for (let sd = 1; sd <= 10; sd++) {
      let h = (sd * 2654435761) >>> 0;
      const pick = new Set(codes.filter(() => { h = (h * 1103515245 + 12345) >>> 0; return (h >>> 16) % 100 < 80; }));
      const idx = []; a.code.forEach((cc, i) => { if (pick.has(cc)) idx.push(i); });
      seeds.push(idx.length ? avg(idx.map(i => a.rets[r.si][i])) : 0);
    }
    const pos = seeds.filter(v => v > 0).length;
    say(`${r.name.padEnd(26)} ${seeds.map(v => (v >= 0 ? '+' : '') + v.toFixed(2)).join(' ')}  ${pos}/10`);
  }
}
say('\n⚠️ 채택 기준: IS·OOS 둘 다 + AND 부트스트랩 8/10 이상. 생존편향 · 독립 표본은 진입일 수.');
writeFileSync(OUT, out.join('\n') + '\n');
console.log(`\n결과 저장: ${OUT}`);
