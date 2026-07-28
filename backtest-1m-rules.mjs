/**
 * backtest-1m-rules.mjs — **분봉 룰 소급 검증** (2026-07-27 야간 배치)
 *
 * 가능해진 배경: 토스 1분봉이 84거래일을 준다는 실측 → `backfill-1m-toss.mjs`로 data-1m/*.jsonl 확보.
 *   오늘까지 "분봉 룰은 소급 불가, 2~3주 전향 필요"라고 판단했던 제약이 사라졌다.
 *
 * 검증 대상
 *   진입: V2_intra(장중 V자) · C_self(종목자체 분봉추세) · A_hi120 · B_rs · D_nochase · V_bounce
 *   청산: base(-6%/-7%/+6·12%/10일) · atr(변동성비례) · tight(-3%/-4%/+3·6%/5일)
 *   → 진입×청산 조합별 성적 + 랜덤 비교군. **분봉 지표 개별 판별력**도 같이 낸다.
 *
 * 방법(룩어헤드 차단)
 *   ① 각 종목-일마다 분봉을 09:00부터 1분씩 리플레이 → 룰별 **최초 성립 분**에 진입(그 분 종가)
 *   ② 일봉 문맥(MA20/MA60/120고가/거래량/저점)은 **그 날짜 시점 값**으로 재계산(PIT)
 *   ③ 청산은 다음 거래일부터 일봉 고가/저가로 장중 레벨 접촉 복원(shadow-1m settle과 동일)
 *   ④ 비교군: 같은 종목-일 전체(랜덤 매수)의 이후 5일 여력/위험
 * 한계: 현재 상장 종목만(생존편향) · 84거래일(독립 표본 84일) · 백필 완료 종목만
 *
 * 실행: node backtest-1m-rules.mjs [--dir data-1m] [--out backtest-1m-result.txt]
 */
import { createReadStream, readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import readline from 'readline';
import { join } from 'path';
import { score } from './scan-1m-core.mjs';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DIR = String(argOf('--dir', 'data-1m'));
const OUT = String(argOf('--out', 'backtest-1m-result.txt'));
const MIN_BARS = Number(argOf('--minbars', 30));
const FWD = 5, COST = 0.33;
const out = [];
const say = (m) => { console.log(m); out.push(m); };

// ── 일봉 전체 로드 (PIT 문맥 계산용) ────────────────────────────────────────
const HIST = new Map();
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream('candles-daily.jsonl') });
  rl.on('line', (l) => { if (!l.trim()) return; try { const j = JSON.parse(l); if (j.c?.length >= 200) HIST.set(j.code, j); } catch {} });
  rl.on('close', res);
});
const mkt = HIST.get('005930');
const mIdx = new Map(mkt.d.map((d, i) => [d, i]));

/** 특정 날짜 인덱스 시점의 일봉 문맥 (loadDaily 반환 형태와 동일) */
function dailyAt(j, i) {
  let ma20 = 0; for (let k = i - 19; k <= i; k++) ma20 += j.c[k];
  let ma60 = 0; for (let k = i - 59; k <= i; k++) ma60 += j.c[k];
  let hi120 = 0; for (let k = i - 119; k <= i; k++) hi120 = Math.max(hi120, j.h[k]);
  let tr = 0; for (let k = i - 13; k <= i; k++) tr += Math.max(j.h[k] - j.l[k], Math.abs(j.h[k] - j.c[k - 1]), Math.abs(j.l[k] - j.c[k - 1]));
  let vol20 = 0; for (let k = i - 19; k <= i; k++) vol20 += j.v[k];
  let tv = 0; for (let k = i - 19; k <= i; k++) tv += j.c[k] * j.v[k];
  let low19 = Infinity, low19I = i; for (let k = i - 18; k <= i; k++) if (j.l[k] < low19) { low19 = j.l[k]; low19I = k; }
  return {
    prevClose: j.c[i], ma20: ma20 / 20, ma60: ma60 / 60, hi120,
    atrPct: (tr / 14) / j.c[i] * 100, vol20: vol20 / 20, turnover: tv / 20,
    ret20: j.c[i] / j.c[i - 20] - 1, low19, low19Ago: i - low19I + 1,
  };
}
const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const EXITS = {
  base: () => ({ trail: 6, hard: 7, tp1: 6, tp2: 12, maxHold: 10 }),
  atr: (a) => ({ trail: cl(1.5 * a, 3, 12), hard: cl(2.0 * a, 4, 14), tp1: cl(1.5 * a, 3, 12), tp2: cl(3.0 * a, 6, 24), maxHold: 10 }),
  tight: () => ({ trail: 3, hard: 4, tp1: 3, tp2: 6, maxHold: 5 }),
};
/** 진입 다음 거래일부터 일봉 고가/저가로 장중 레벨 접촉 복원 (shadow-1m settle 동일 로직) */
function simExit(j, ei, entry, e) {
  let runHi = entry, qty = 1, realized = 0, tp1 = false, tp2 = false;
  for (let i = ei; i < Math.min(j.c.length, ei + e.maxHold); i++) {
    const hiD = j.h[i], loD = j.l[i], c = j.c[i], oD = j.o[i];
    const hardLv = entry * (1 - e.hard / 100), trailLv = runHi * (1 - e.trail / 100);
    const lv = Math.max(hardLv, trailLv);
    if (loD <= lv) { const px = Math.min(lv, oD); return realized + qty * ((px / entry - 1) * 100) - COST; }
    if (!tp1 && hiD >= entry * (1 + e.tp1 / 100)) { realized += 0.5 * e.tp1; qty -= 0.5; tp1 = true; }
    else if (tp1 && !tp2 && hiD >= entry * (1 + e.tp2 / 100)) { realized += 0.25 * e.tp2; qty -= 0.25; tp2 = true; }
    runHi = Math.max(runHi, hiD);
    if (i === ei + e.maxHold - 1) return realized + qty * ((c / entry - 1) * 100) - COST;
  }
  return null;   // forward 데이터 부족
}

/**
 * ★ 분봉 청산 (2026-07-27 추가) — 일봉 청산의 두 결함을 없앤다.
 *   ① **진입 당일 청산**을 잡는다. 일봉으로는 그날 저가가 진입 전인지 후인지 몰라 당일을 제외해야 했는데,
 *      오늘 실측 청산 3건이 **전부 진입 당일 트레일**이었다(라이브봇은 30초 루프로 당일에도 판다).
 *   ② **고가/저가 순서 모호성** 제거. 일봉은 어느 쪽이 먼저인지 몰라 "하락 먼저"로 보수적 가정했다.
 * @param days [{day, bars}] 오래된순, @param si 진입 날짜 인덱스, @param bi 진입 분 인덱스(그 분 이후부터 판정)
 */
function simExitMinute(days, si, bi, entry, e) {
  let runHi = entry, qty = 1, realized = 0, tp1 = false, tp2 = false;
  for (let di = si; di < Math.min(days.length, si + e.maxHold); di++) {
    const bars = days[di].bars;
    for (let k = (di === si ? bi + 1 : 0); k < bars.length; k++) {
      const b = bars[k];
      const hardLv = entry * (1 - e.hard / 100), trailLv = runHi * (1 - e.trail / 100);
      const lv = Math.max(hardLv, trailLv);
      if (b.l <= lv) return { ret: realized + qty * ((Math.min(lv, b.o) / entry - 1) * 100) - COST, sameDay: di === si };
      if (!tp1 && b.h >= entry * (1 + e.tp1 / 100)) { realized += 0.5 * e.tp1; qty -= 0.5; tp1 = true; }
      else if (tp1 && !tp2 && b.h >= entry * (1 + e.tp2 / 100)) { realized += 0.25 * e.tp2; qty -= 0.25; tp2 = true; }
      runHi = Math.max(runHi, b.h);
    }
    if (di === si + e.maxHold - 1 || di === days.length - 1) {
      const last = bars.at(-1).c;
      return { ret: realized + qty * ((last / entry - 1) * 100) - COST, sameDay: false, expired: di < si + e.maxHold - 1 };
    }
  }
  return null;
}

const GATE = { A_hi120: 'gatesA', B_rs: 'gates', C_self: 'gatesC', D_nochase: 'gatesD', V_bounce: 'gatesV', V2_intra: 'gatesV2', V3_ubase: 'gatesV3' };
const RULES = Object.keys(GATE);
const acc = {};                       // rule → {n, up, dn, at:[], exits:{rule:[ret...]}}
for (const r of RULES) acc[r] = { n: 0, up: 0, dn: 0, at: [], days: new Set(), exits: { base: [], atr: [], tight: [] }, mexits: { base: [], atr: [], tight: [] }, sameDay: 0 };
const BASE = { n: 0, up: 0, dn: 0, exits: { base: [], atr: [], tight: [] }, mexits: { base: [], atr: [], tight: [] } };
const METRIC = {};                    // 지표명 → {버킷별 forward}

const files = readdirSync(DIR).filter(f => f.endsWith('.jsonl'));
say(`분봉 파일 ${files.length}종목 · 일봉 ${HIST.size}종목 · MIN_BARS ${MIN_BARS}`);
let codesUsed = 0, stockDays = 0;

for (const f of files) {
  const code = f.replace('.jsonl', '');
  const j = HIST.get(code);
  if (!j) continue;
  let rec;
  try { rec = JSON.parse(readFileSync(join(DIR, f), 'utf8')); } catch { continue; }
  if (!rec?.t?.length) continue;
  // 날짜별 그룹 (KST) + 정규장 09:00~15:30 만
  const byDay = new Map();
  for (let i = 0; i < rec.t.length; i++) {
    const k = new Date((rec.t[i] + 32400) * 1000);
    const hh = k.getUTCHours(), mm = k.getUTCMinutes();
    if (hh < 9 || hh > 15 || (hh === 15 && mm > 30)) continue;      // NXT·시간외 제외
    const day = k.toISOString().slice(0, 10).replace(/-/g, '');
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ hhmm: String(hh).padStart(2, '0') + String(mm).padStart(2, '0'), o: rec.o[i], h: rec.h[i], l: rec.l[i], c: rec.c[i], v: rec.v[i] });
  }
  codesUsed++;
  // 분봉 청산용: 날짜 오래된순 배열 (진입 이후 분봉을 이어서 걷는다)
  const dayList = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, bars]) => ({ day, bars: bars.slice().sort((x, y) => x.hhmm.localeCompare(y.hhmm)) }));
  const dayPos = new Map(dayList.map((x, i) => [x.day, i]));
  for (const [day, bars] of byDay) {
    if (bars.length < MIN_BARS + 5) continue;
    const di = j.d.indexOf(day);
    if (di < 130 || di + FWD >= j.c.length) continue;               // PIT 문맥·forward 확보 필요
    const mi = mIdx.get(day);
    if (mi == null || mi < 130) continue;
    stockDays++;
    const d = dailyAt(j, di - 1);                                   // ★ 전일까지의 문맥(당일 일봉은 미완성)
    const MKT_RET20 = mkt.c[mi - 1] / mkt.c[mi - 21] - 1;
    bars.sort((a, b) => a.hhmm.localeCompare(b.hhmm));

    // 비교군: 그날 종가 매수 → 이후 5일
    let fh = 0, fl = Infinity;
    for (let k = di + 1; k <= di + FWD; k++) { fh = Math.max(fh, j.h[k]); fl = Math.min(fl, j.l[k]); }
    BASE.n++; BASE.up += (fh / j.c[di] - 1) * 100; BASE.dn += (fl / j.c[di] - 1) * 100;
    for (const [er, ef] of Object.entries(EXITS)) { const v = simExit(j, di + 1, j.c[di], ef(d.atrPct)); if (v != null) BASE.exits[er].push(v); }
    { const dpi0 = dayPos.get(day); const lastBi = byDay.get(day).length - 1;
      for (const [er, ef] of Object.entries(EXITS)) { const m = simExitMinute(dayList, dpi0, lastBi, j.c[di], ef(d.atrPct)); if (m && !m.expired) BASE.mexits[er].push(m.ret); } }

    // 룰별 최초 성립 분 탐색
    const hit = new Set();
    for (let bi = MIN_BARS - 1; bi < bars.length && hit.size < RULES.length; bi++) {
      const cut = bars.slice(0, bi + 1);
      const s = score({ code, now: cut.at(-1).c, prevClose: d.prevClose, acmlVol: cut.reduce((a, b) => a + b.v, 0), bars: cut }, d, { MKT_RET20, elapsed: Math.max(1, Number(cut.at(-1).hhmm.slice(0, 2)) * 60 + Number(cut.at(-1).hhmm.slice(2, 4)) - 540) });
      for (const [rule, key] of Object.entries(GATE)) {
        if (hit.has(rule) || s[key].length) continue;
        hit.add(rule);
        const entry = s.now;
        const a = acc[rule];
        a.n++; a.at.push(cut.at(-1).hhmm); a.days.add(day);
        a.up += (fh / entry - 1) * 100; a.dn += (fl / entry - 1) * 100;
        for (const [er, ef] of Object.entries(EXITS)) { const v = simExit(j, di + 1, entry, ef(d.atrPct)); if (v != null) a.exits[er].push(v); }
        // 분봉 청산 (진입 당일 포함, 진입 분 이후부터)
        const dpi = dayPos.get(day);
        for (const [er, ef] of Object.entries(EXITS)) {
          const m = simExitMinute(dayList, dpi, bi, entry, ef(d.atrPct));
          if (m && !m.expired) { a.mexits[er].push(m.ret); if (er === 'base' && m.sameDay) a.sameDay++; }
        }
      }
    }
  }
}

// ── 리포트 ──────────────────────────────────────────────────────────────────
const avg = (x) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : 0);
const win = (x) => (x.length ? x.filter(v => v > 0).length / x.length * 100 : 0);
say(`\n=== 분봉 룰 소급 검증 (종목 ${codesUsed} · 종목-일 ${stockDays.toLocaleString()}) ===`);
const bUp = BASE.up / BASE.n, bDn = BASE.dn / BASE.n;
say(`비교군(그날 종가 랜덤매수 ${BASE.n.toLocaleString()}건): 여력 +${bUp.toFixed(2)}% / 위험 ${bDn.toFixed(2)}% / RR ${(bUp / Math.abs(bDn)).toFixed(2)}`);
say(`  청산 적용: base ${avg(BASE.exits.base).toFixed(2)}% · atr ${avg(BASE.exits.atr).toFixed(2)}% · tight ${avg(BASE.exits.tight).toFixed(2)}%`);

say('\n── 진입 룰별 (여력/위험은 진입가 기준 이후 5일) ──');
say('룰            성립건수 진입일 성립률   여력      위험      RR    중위성립');
for (const r of RULES) {
  const a = acc[r];
  if (!a.n) { say(`${r.padEnd(12)} 0건 (성립 없음)`); continue; }
  const up = a.up / a.n, dn = a.dn / a.n;
  const med = [...a.at].sort()[Math.floor(a.at.length / 2)];
  say(`${r.padEnd(12)} ${String(a.n).padStart(7)} ${String(a.days.size).padStart(5)}일 ${(a.n / stockDays * 100).toFixed(1).padStart(5)}%  +${up.toFixed(2)}%  ${dn.toFixed(2)}%  ${(up / Math.abs(dn)).toFixed(2).padStart(5)}  ${med}`);
}

say('\n── 진입 × 청산 조합 (실제 손익, 비용 0.33%p 차감) ──');
say('   일봉청산 = 다음 거래일부터 고가/저가 판정(진입 당일 제외, 고저 순서 모호)');
say('   **분봉청산** = 진입 분 이후 1분 단위 판정(당일 청산 포착·순서 확정) ← 라이브봇과 정합');
say('룰            청산룰 │ 일봉 건수  손익     승률 │ 분봉 건수  손익     승률   당일청산');
for (const r of RULES) {
  for (const er of ['base', 'atr', 'tight']) {
    const x = acc[r].exits[er], m = acc[r].mexits[er];
    if (!x.length && !m.length) continue;
    const sd = er === 'base' && m.length ? `${acc[r].sameDay}건(${(acc[r].sameDay / m.length * 100).toFixed(0)}%)` : '';
    say(`${r.padEnd(12)} ${er.padEnd(5)} │ ${String(x.length).padStart(6)} ${((avg(x) >= 0 ? '+' : '') + avg(x).toFixed(2) + '%').padStart(8)} ${win(x).toFixed(0).padStart(4)}% │ ${String(m.length).padStart(6)} ${((avg(m) >= 0 ? '+' : '') + avg(m).toFixed(2) + '%').padStart(8)} ${win(m).toFixed(0).padStart(4)}%  ${sd}`);
  }
}
say(`\n(랜덤 일봉) base ${avg(BASE.exits.base).toFixed(2)}% ${win(BASE.exits.base).toFixed(0)}% · atr ${avg(BASE.exits.atr).toFixed(2)}% ${win(BASE.exits.atr).toFixed(0)}% · tight ${avg(BASE.exits.tight).toFixed(2)}% ${win(BASE.exits.tight).toFixed(0)}%`);
say(`(랜덤 분봉) base ${avg(BASE.mexits.base).toFixed(2)}% ${win(BASE.mexits.base).toFixed(0)}% · atr ${avg(BASE.mexits.atr).toFixed(2)}% ${win(BASE.mexits.atr).toFixed(0)}% · tight ${avg(BASE.mexits.tight).toFixed(2)}% ${win(BASE.mexits.tight).toFixed(0)}%`);
say('\n⚠️ 생존편향(현재 상장 종목만) · 독립 표본은 종목수가 아니라 **진입일 수** · 백필 완료 종목만');
writeFileSync(OUT, out.join('\n') + '\n');
console.log(`\n결과 저장: ${OUT}`);
