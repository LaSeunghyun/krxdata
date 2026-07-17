#!/usr/bin/env node
/**
 * backtest-listing-drift.mjs — 신규상장 코인의 상장 후 N일 드리프트 이벤트 스터디
 *   "상장빔" 자체(분 단위 스나이핑)는 백테스트 불가하나, 상장 후 일 단위 드리프트/페이드는 일봉으로 검증 가능.
 *   방법: 전 KRW 마켓 일봉 조회 → 첫 캔들 일자가 기준일 이후면 신규상장으로 간주 →
 *         상장 첫날 종가 매수 가정, +1/+3/+7일 후 종가 수익률 집계 (비용 0.2% 왕복 차감 별도 표기)
 *   한계(명시): 상폐 코인 누락(생존편향, 결과를 유리하게 왜곡) / 첫날 종가는 상장빔 고점일 수 있음.
 *
 * 실행: node backtest-listing-drift.mjs [--since 20250101]
 */
import { getKrwMarkets, getDailyCandles } from './upbit-api.js';

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SINCE = argOf('--since', '20250101');
const COST = 0.002; // 왕복 0.2%
const dayOf = (ts) => String(ts).slice(0, 10).replace(/-/g, '');

const markets = await getKrwMarkets();
console.log(`KRW 마켓 ${markets.length}개 스캔 (상장일 = 첫 일봉 ≥ ${SINCE})...`);

const events = [];
let done = 0;
for (const m of markets) {
  try {
    const candles = (await getDailyCandles(m.market, 600)).reverse(); // 오름차순
    if (!candles.length) continue;
    const first = dayOf(candles[0].timestamp);
    if (first >= SINCE && candles.length >= 2) {
      const c = candles.map(b => b.close);
      const ev = { market: m.market, name: m.korean_name, listDay: first, n: candles.length };
      ev.d1 = c.length > 1 ? c[1] / c[0] - 1 : null;
      ev.d3 = c.length > 3 ? c[3] / c[0] - 1 : null;
      ev.d7 = c.length > 7 ? c[7] / c[0] - 1 : null;
      // 첫날 캔들 내부: 고가 대비 종가 (상장빔 고점에서 얼마나 밀렸나)
      ev.day1CloseVsHigh = candles[0].close / candles[0].high - 1;
      events.push(ev);
    }
  } catch { /* 미커버 스킵 */ }
  if (++done % 50 === 0) console.log(`  ${done}/${markets.length}`);
}

console.log(`\n=== 신규상장 이벤트 ${events.length}건 (${SINCE} 이후) — 생존편향 있음(상폐 누락, 결과 유리 왜곡) ===`);
function stats(key) {
  const v = events.map(e => e[key]).filter(x => x != null);
  if (!v.length) return null;
  const sorted = [...v].sort((a, b) => a - b);
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const win = v.filter(x => x > 0).length / v.length;
  return { n: v.length, mean: mean * 100, median: median * 100, win: win * 100 };
}
for (const [key, label] of [['d1', '상장1일종가→+1일'], ['d3', '→+3일'], ['d7', '→+7일'], ['day1CloseVsHigh', '첫날 종가 vs 고가']]) {
  const s = stats(key);
  if (s) console.log(`${label.padEnd(18)} n=${s.n}  평균 ${s.mean.toFixed(1)}%  중앙값 ${s.median.toFixed(1)}%  승률 ${s.win.toFixed(0)}%`);
}
const s3 = stats('d3');
if (s3) console.log(`\n전략화 판정 (첫날종가 매수→+3일 매도, 왕복 0.2% 차감): 평균 net ${(s3.mean - COST * 100).toFixed(1)}%/건, 중앙값 net ${(s3.median - COST * 100).toFixed(1)}%/건`);
console.log('개별 이벤트 (최근 15건):');
for (const e of events.slice(-15)) {
  console.log(`  ${e.listDay} ${e.market.padEnd(12)} ${(e.name ?? '').padEnd(10)} +1d ${e.d1 != null ? (e.d1 * 100).toFixed(1) + '%' : '-'} | +3d ${e.d3 != null ? (e.d3 * 100).toFixed(1) + '%' : '-'} | +7d ${e.d7 != null ? (e.d7 * 100).toFixed(1) + '%' : '-'}`);
}
