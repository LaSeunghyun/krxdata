/**
 * diag-entry-timing.mjs — 진입 직후 경로 진단 (2026-07-29 사용자 지적)
 *   "대부분 진입 후 5~10분 안에 2% 이상 빠진다 — 진입 시점이 잘못된 게 아닌가"
 *
 * 방법: 저널의 당일 매수건마다 KIS 분봉으로 **진입 시각 이후** 경로를 재고,
 *   같은 종목·같은 날의 **모든 분(무작위 시점)** 평균과 비교한다.
 *   - 진입 성적이 무작위 시점과 같다 → 타이밍 문제가 아니라 종목이 빠지는 것
 *   - 진입 성적이 유의하게 나쁘다 → **진입 시점 자체가 나쁘다**(국소 고점 매수 등)
 * 추가 측정: 진입가가 직전 N분 구간에서 어디였나(위치 %), 지정가 프리미엄(+0.5%) 영향.
 *
 * 실행: node diag-entry-timing.mjs [--date 2026-07-29]
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { getMinuteBars } from './kis-api.js';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DATE = String(argOf('--date', new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)));
const JOURNAL = String(argOf('--journal', 'stock-live-journal.json'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const j = JSON.parse(readFileSync(JOURNAL, 'utf8'));
const buys = (j.trades || []).filter(x => x.side === 'BUY' && String(x.ts).slice(0, 10) === DATE);
if (!buys.length) { console.log(`${DATE} 매수 기록 없음`); process.exit(0); }
console.log(`${DATE} 매수 ${buys.length}건 진단 — KIS 분봉(당일만 조회 가능)\n`);

/** 당일 전 구간 1분봉 (기준시각까지) */
async function fullDay(code, baseHHMM) {
  const bm = Number(baseHHMM.slice(0, 2)) * 60 + Number(baseHHMM.slice(2, 4));
  const hm = (t) => String(Math.floor(t / 60)).padStart(2, '0') + String(t % 60).padStart(2, '0');
  const seen = new Set(), bars = [];
  for (let t = bm; t >= 540; t -= 30) {
    const a = await getMinuteBars(code, hm(t) + '00');
    await sleep(150);
    if (!a.bars.length) break;
    for (const b of a.bars) if (!seen.has(b.hhmm)) { seen.add(b.hhmm); bars.push(b); }
  }
  return bars.sort((x, y) => x.hhmm.localeCompare(y.hhmm));
}

const nowKst = new Date(Date.now() + 9 * 3600_000);
const nowHM = String(nowKst.getUTCHours()).padStart(2, '0') + String(nowKst.getUTCMinutes()).padStart(2, '0');
const rows = [];
const barCache = new Map();

for (const b of buys) {
  const at = String(b.ts).slice(11, 16).replace(':', '');   // HHMM
  let bars = barCache.get(b.code);
  if (!bars) { try { bars = await fullDay(b.code, nowHM); barCache.set(b.code, bars); } catch (e) { console.log(`${b.name} 분봉 실패: ${String(e.message).slice(0, 50)}`); continue; } }
  const i = bars.findIndex(x => x.hhmm >= at);
  if (i < 0) { console.log(`${b.name} 진입시각 ${at} 이후 봉 없음`); continue; }
  const entry = Number(b.px);
  const fwd = (n) => { const k = Math.min(i + n, bars.length - 1); return k > i ? (bars[k].c / entry - 1) * 100 : null; };
  // 진입 후 최저/최고
  let lo = Infinity, hi = 0;
  for (let k = i; k < bars.length; k++) { if (bars[k].l < lo) lo = bars[k].l; if (bars[k].h > hi) hi = bars[k].h; }
  // 진입가의 직전 30분 구간 내 위치 (1=구간 고점 부근)
  const pre = bars.slice(Math.max(0, i - 30), i + 1);
  const pHi = Math.max(...pre.map(x => x.h)), pLo = Math.min(...pre.map(x => x.l));
  const pos = pHi > pLo ? (entry - pLo) / (pHi - pLo) : 0.5;
  rows.push({
    name: b.name, code: b.code, at, entry, i, bars,
    f5: fwd(5), f10: fwd(10), f30: fwd(30),
    dd: (lo / entry - 1) * 100, up: (hi / entry - 1) * 100, pos,
  });
}

console.log('종목            진입시각 진입가     +5분    +10분   +30분  진입후최저 진입후최고 직전30분위치');
for (const r of rows) {
  const f = (v) => (v == null ? '    -' : ((v >= 0 ? '+' : '') + v.toFixed(2) + '%').padStart(7));
  console.log(`${r.name.padEnd(14)} ${r.at}   ${r.entry.toLocaleString().padStart(8)} ${f(r.f5)} ${f(r.f10)} ${f(r.f30)}  ${(r.dd.toFixed(2) + '%').padStart(8)}  ${('+' + r.up.toFixed(2) + '%').padStart(8)}  ${(r.pos * 100).toFixed(0).padStart(3)}%`);
}

// ── 비교군: 같은 종목·같은 날의 모든 분에서 진입했다면 ──────────────────────
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
console.log('\n=== 진입 시점 vs 무작위 시점 (같은 종목·같은 날) ===');
console.log('종목            진입 +5분 / 무작위 +5분 │ 진입 +10분 / 무작위 +10분 │ 진입위치 / 평균위치');
const dEntry5 = [], dRand5 = [], dEntry10 = [], dRand10 = [], dPos = [], dPosR = [];
for (const r of rows) {
  const bars = r.bars;
  const r5 = [], r10 = [], posR = [];
  for (let k = 30; k < bars.length - 10; k++) {
    r5.push((bars[k + 5].c / bars[k].c - 1) * 100);
    r10.push((bars[k + 10].c / bars[k].c - 1) * 100);
    const pre = bars.slice(k - 30, k + 1);
    const pHi = Math.max(...pre.map(x => x.h)), pLo = Math.min(...pre.map(x => x.l));
    posR.push(pHi > pLo ? (bars[k].c - pLo) / (pHi - pLo) : 0.5);
  }
  const m5 = avg(r5), m10 = avg(r10), mp = avg(posR);
  if (r.f5 != null) { dEntry5.push(r.f5); dRand5.push(m5); }
  if (r.f10 != null) { dEntry10.push(r.f10); dRand10.push(m10); }
  dPos.push(r.pos); dPosR.push(mp);
  const f = (v) => ((v >= 0 ? '+' : '') + v.toFixed(2) + '%').padStart(7);
  console.log(`${r.name.padEnd(14)} ${f(r.f5 ?? 0)} / ${f(m5)} │ ${f(r.f10 ?? 0)} / ${f(m10)} │ ${(r.pos * 100).toFixed(0)}% / ${(mp * 100).toFixed(0)}%`);
}
console.log('\n── 종합 ──');
console.log(`진입 +5분  평균 ${(avg(dEntry5) >= 0 ? '+' : '') + avg(dEntry5).toFixed(2)}%  vs  무작위 ${(avg(dRand5) >= 0 ? '+' : '') + avg(dRand5).toFixed(2)}%  → 차이 ${(avg(dEntry5) - avg(dRand5)).toFixed(2)}%p`);
console.log(`진입 +10분 평균 ${(avg(dEntry10) >= 0 ? '+' : '') + avg(dEntry10).toFixed(2)}%  vs  무작위 ${(avg(dRand10) >= 0 ? '+' : '') + avg(dRand10).toFixed(2)}%  → 차이 ${(avg(dEntry10) - avg(dRand10)).toFixed(2)}%p`);
console.log(`진입 시점 위치 평균 ${(avg(dPos) * 100).toFixed(0)}%  vs  무작위 시점 평균 ${(avg(dPosR) * 100).toFixed(0)}%  (100%=직전 30분 고점)`);
console.log(`\n※ 지정가 프리미엄: limitBuyPx = 현재가 × 1.005 → 진입가에 이미 +0.5%가 얹혀 있다(체결 유도용).`);
console.log('※ 차이가 0에 가까우면 타이밍 문제가 아니라 종목이 빠지는 것. 유의하게 음수면 진입 시점이 나쁘다.');
