/**
 * research-vshape-1m.mjs — **장중(분봉) V자 반등** 스캔 (2026-07-27, 사용자 정정 요청)
 *
 * ⚠️ V_bounce(일봉)와 다른 질문이다. 이건 **오늘 하루 안에서** 떨어졌다가 바닥 다지고 회복한 모양을 찾는다.
 * 노타(486990) 오늘 실측 템플릿:
 *   시가 21,350 → 오전고가 21,700 → 저가 19,680(10:56, **-9.31%**) → 3시간 횡보 → 종가 22,050(**저점 +12.04%**)
 *   낙폭 회복률 117%(오전 고가 돌파) · 저점 위치 전체의 30% 지점
 * 조건: ① 저점 전 고가→저점 낙폭 ≤ -DROP% ② 저점 위치 LOWMIN~LOWMAX% 구간 ③ 저점→종가 반등 ≥ REB%
 *       ④ 낙폭 회복률 ≥ REC% ⑤ 종가 > 시가
 * 실행: node research-vshape-1m.mjs [--drop 5] [--reb 5] [--rec 70] [--base 1520]
 */
import 'dotenv/config';
import { loadDaily } from './scan-1m-core.mjs';
import { getMinuteBars } from './kis-api.js';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DROP = Number(argOf('--drop', 5));       // 장중 낙폭 최소치(%)
const REB = Number(argOf('--reb', 5));         // 저점→현재 반등 최소치(%)
const REC = Number(argOf('--rec', 70));        // 낙폭 회복률 최소치(%)
const LOWMIN = Number(argOf('--lowmin', 10));  // 저점 위치 하한(%)
const LOWMAX = Number(argOf('--lowmax', 80));  // 저점 위치 상한(%)
const BASE = String(argOf('--base', '1520'));
const MAXN = Number(argOf('--max', 0));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 150)}`);
  return r.json();
};
const NAME = new Map();
for (const r of await dbQuery('SELECT stock_code, corp_name FROM stocks')) NAME.set(r.stock_code, String(r.corp_name ?? '').replace(/&amp;/g, '&'));
const nm = (c) => `${NAME.get(c) ?? '?'}(${c})`;

const { daily } = await loadDaily();
const baseMin = Number(BASE.slice(0, 2)) * 60 + Number(BASE.slice(2, 4));
const hm = (t) => String(Math.floor(t / 60)).padStart(2, '0') + String(t % 60).padStart(2, '0');
const calls = Math.ceil((baseMin - 540) / 30);
let codes = [...daily.keys()];
if (MAXN > 0) codes = codes.slice(0, MAXN);
console.log(`유동성 통과 ${codes.length}종목 · 기준 ${BASE} · ${calls}콜/종목 · 조건 낙폭≤-${DROP}% 반등≥${REB}% 회복률≥${REC}% 저점위치 ${LOWMIN}~${LOWMAX}%`);

/** 분봉 배열에서 장중 V자 지표 추출 */
function vshape(bars) {
  const o = bars[0].o, c = bars.at(-1).c;
  let lo = Infinity, loI = 0;
  for (let i = 0; i < bars.length; i++) if (bars[i].l < lo) { lo = bars[i].l; loI = i; }
  let preHi = 0; for (let i = 0; i <= loI; i++) preHi = Math.max(preHi, bars[i].h);
  const dayHi = Math.max(...bars.map(b => b.h));
  const drop = (lo / preHi - 1) * 100;                  // 저점까지 낙폭(음수)
  const reb = (c / lo - 1) * 100;                        // 저점→현재 반등
  const rec = preHi > lo ? (c - lo) / (preHi - lo) * 100 : 0;  // 낙폭 회복률
  const lowPos = loI / (bars.length - 1) * 100;           // 저점 시각 위치(%)
  // 바닥 다지기: 저점 이후 저점±1% 구간에 머문 분봉 수
  let baseMin2 = 0; for (let i = loI; i < bars.length; i++) if (bars[i].c <= lo * 1.01) baseMin2++;
  return { o, c, lo, loI, loHHMM: bars[loI].hhmm, preHi, dayHi, drop, reb, rec, lowPos, baseHold: baseMin2 };
}

const hits = [];
let done = 0, fail = 0;
for (const code of codes) {
  try {
    const seen = new Set(), bars = [];
    for (let k = 0; k < calls; k++) {
      const a = await getMinuteBars(code, hm(baseMin - 30 * k) + '00');
      await sleep(150);
      for (const b of a.bars) if (!seen.has(b.hhmm)) { seen.add(b.hhmm); bars.push(b); }
      if (!a.bars.length) break;
    }
    bars.sort((x, y) => x.hhmm.localeCompare(y.hhmm));
    if (bars.length < 60) { fail++; continue; }
    const v = vshape(bars);
    if (v.drop <= -DROP && v.reb >= REB && v.rec >= REC && v.lowPos >= LOWMIN && v.lowPos <= LOWMAX && v.c > v.o) {
      hits.push({ code, ...v, dayRet: (v.c / daily.get(code).prevClose - 1) * 100, turnover: daily.get(code).turnover });
    }
  } catch { fail++; }
  if (++done % 100 === 0) console.log(`  ${done}/${codes.length} (실패 ${fail}, 적합 ${hits.length})`);
}
console.log(`\n조회 ${done}종목 / 실패 ${fail} → 장중 V자 ${hits.length}종목\n`);

hits.sort((a, b) => b.reb - a.reb);
console.log('종목                        시가      저점(시각)      낙폭     반등     회복률  저점위치  바닥유지  당일비');
for (const h of hits) {
  console.log(`${nm(h.code).padEnd(24)} ${h.o.toLocaleString().padStart(8)}  ${h.lo.toLocaleString().padStart(8)}(${h.loHHMM})  ${h.drop.toFixed(2).padStart(6)}%  ${('+' + h.reb.toFixed(2) + '%').padStart(7)}  ${h.rec.toFixed(0).padStart(4)}%  ${h.lowPos.toFixed(0).padStart(6)}%  ${String(h.baseHold).padStart(5)}분  ${((h.dayRet >= 0 ? '+' : '') + h.dayRet.toFixed(1) + '%').padStart(6)}`);
}
if (!hits.length) { console.log('  (해당 없음)'); process.exit(0); }

const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log('\n=== 공통점 ===');
console.log(`낙폭      평균 ${avg(hits.map(h => h.drop)).toFixed(2)}%  중위 ${med(hits.map(h => h.drop)).toFixed(2)}%`);
console.log(`반등      평균 +${avg(hits.map(h => h.reb)).toFixed(2)}%  중위 +${med(hits.map(h => h.reb)).toFixed(2)}%`);
console.log(`회복률    평균 ${avg(hits.map(h => h.rec)).toFixed(0)}%  (100%↑ = 오전 고가 돌파)  100%↑ ${hits.filter(h => h.rec >= 100).length}/${hits.length}종목`);
console.log(`저점위치  평균 ${avg(hits.map(h => h.lowPos)).toFixed(0)}% 지점  중위 ${med(hits.map(h => h.lowPos)).toFixed(0)}%`);
console.log(`바닥유지  평균 ${avg(hits.map(h => h.baseHold)).toFixed(0)}분  중위 ${med(hits.map(h => h.baseHold)).toFixed(0)}분`);
console.log(`당일비    평균 ${avg(hits.map(h => h.dayRet)).toFixed(2)}%  | 양봉마감 ${hits.filter(h => h.dayRet > 0).length}/${hits.length}종목`);
console.log(`거래대금  중위 ${Math.round(med(hits.map(h => h.turnover)) / 1e8).toLocaleString()}억`);
