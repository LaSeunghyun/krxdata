/**
 * scan-1m-now.mjs — "지금" 1분봉 기준 스윙 후보 조회 (표시 전용). 계산은 scan-1m-core.mjs가 단일 원본.
 * 2026-07-27. 실행: node scan-1m-now.mjs [--top 15] [--budget 6090000] [--max 0]
 *
 * A안 = 라이브 hi120 정합(120일고가 -10% 이내 + 시장 상대강세)
 * B안 = 완화(상대강세 리더십, 고가근접 제외)
 * C안 = 시장(삼전) 참조 0 — 종목 자체 분봉 추세 + 종목 자체 일봉 레짐만
 */
import 'dotenv/config';
import { scanNow } from './scan-1m-core.mjs';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const TOP = Number(argOf('--top', 15));
const BUDGET = Number(argOf('--budget', 6_090_000));
const SLOTS = 5;
const perSlot = Math.floor(BUDGET / SLOTS);

const { scored, meta } = await scanNow({ maxN: Number(argOf('--max', 0)), log: (m) => console.log(m) });
console.log(`\n시장(005930 프록시): 현재 ${meta.mktNow.toLocaleString()} · 20일 ${(meta.mktRet20 * 100).toFixed(1)}% · MA20 ${Math.round(meta.mkt.ma20).toLocaleString()} · 120일고가 ${meta.mkt.hi120.toLocaleString()}(${(meta.mktNow / meta.mkt.hi120 * 100).toFixed(1)}%)`);
console.log(`슬롯예산 ${perSlot.toLocaleString()}원 (현금 ${BUDGET.toLocaleString()} / ${SLOTS}슬롯)`);

const showAB = (list, label) => {
  console.log(`\n=== ${label}: ${list.length}종목 ===`);
  if (!list.length) { console.log('  (해당 없음)'); return; }
  console.log('순위 종목      점수  현재가    전일比  VWAP프리 위치  10분모멘텀 거래량배 120고가비 상대강세 1mATR  수량  하드손절 익절1');
  for (const [i, s] of list.slice(0, TOP).entries()) {
    console.log(`${String(i + 1).padStart(2)}  ${s.code}  ${s.score.toFixed(1).padStart(5)}  ${s.now.toLocaleString().padStart(8)}  ${((s.dayRet >= 0 ? '+' : '') + s.dayRet.toFixed(2) + '%').padStart(7)}  ${((s.vwapPrem >= 0 ? '+' : '') + s.vwapPrem.toFixed(2) + '%').padStart(7)}  ${(s.pos * 100).toFixed(0).padStart(3)}%  ${((s.mom10 >= 0 ? '+' : '') + s.mom10.toFixed(2) + '%').padStart(7)}   ${s.volPace.toFixed(2)}x   ${(s.hiProx * 100).toFixed(1).padStart(5)}%  ${((s.rs20 >= 0 ? '+' : '') + s.rs20.toFixed(1) + '%p').padStart(7)}  ${s.atr1Pct.toFixed(3)}%  ${String(Math.floor(perSlot / s.now)).padStart(4)}  ${Math.round(s.now * 0.93).toLocaleString().padStart(8)}  ${Math.round(s.now * 1.06).toLocaleString().padStart(8)}`);
  }
};
showAB(scored.filter(s => !s.gatesA.length).sort((a, b) => b.score - a.score), 'A안 — 라이브 hi120 정합(120일고가 -10% 이내)');
showAB(scored.filter(s => !s.gates.length).sort((a, b) => b.score - a.score), 'B안 — 완화(상대강세 리더십)');

const passC = scored.filter(s => !s.gatesC.length).sort((a, b) => b.scoreC - a.scoreC);
console.log(`\n=== C안 — 시장(삼전) 기준 배제, 종목 자체 분봉+일봉만: ${passC.length}종목 ===`);
if (!passC.length) console.log('  (해당 없음)');
else {
  console.log('순위 종목      점수C 현재가    전일比  저점상승 VWAP기울기 상승봉 상승거래량 되돌림 1mATR  120고가비 수량');
  for (const [i, s] of passC.slice(0, TOP).entries()) {
    console.log(`${String(i + 1).padStart(2)}  ${s.code}  ${s.scoreC.toFixed(1).padStart(5)}  ${s.now.toLocaleString().padStart(8)}  ${((s.dayRet >= 0 ? '+' : '') + s.dayRet.toFixed(2) + '%').padStart(7)}  ${s.higherLows}/2      ${((s.vwapSlope >= 0 ? '+' : '') + s.vwapSlope.toFixed(2) + '%').padStart(7)}  ${(s.upBars * 100).toFixed(0).padStart(3)}%   ${(s.upVolFrac * 100).toFixed(0).padStart(3)}%     ${s.pullback.toFixed(2)}%  ${s.atr1Pct.toFixed(3)}%  ${(s.hiProx * 100).toFixed(1).padStart(5)}%  ${String(Math.floor(perSlot / s.now)).padStart(4)}`);
  }
}
for (const [label, key] of [['A안', 'gatesA'], ['C안', 'gatesC']]) {
  const rej = {};
  for (const s of scored) for (const g of s[key]) rej[g] = (rej[g] ?? 0) + 1;
  console.log(`탈락 사유(${label}, 총 ${scored.length}종목): ${Object.entries(rej).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
}
