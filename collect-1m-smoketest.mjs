/**
 * collect-1m-smoketest.mjs — 스캘핑 시뮬레이션용 1분봉 1회성 수집 (2026-07-24).
 * 토스 1분봉은 과거 약 8거래일까지만 페이지네이션됨(실측) → 이 정도로 소량 유동성 상위종목만 수집,
 * 라이브봇(signalScanLoop)과의 레이트리밋 경합 최소화 위해 종목당 호출 사이 추가 지연을 둔다.
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { getCandles1m } from './toss-api.js';

const STOCKS = [
  ['005930', '삼성전자'], ['000660', 'SK하이닉스'], ['373220', 'LG에너지솔루션'],
  ['207940', '삼성바이오로직스'], ['005380', '현대차'], ['000270', '기아'],
  ['005490', 'POSCO홀딩스'], ['035420', 'NAVER'], ['035720', '카카오'], ['068270', '셀트리온'],
];
const BARS_WANTED = 1200; // 약 3거래일(390분/일 기준)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const out = [];
for (const [code, name] of STOCKS) {
  try {
    const cd = await getCandles1m(code, BARS_WANTED, null);
    out.push({ code, name, bars: cd });
    console.log(`${name}(${code}): ${cd.length}봉 수집 (${cd[cd.length - 1]?.timestamp} ~ ${cd[0]?.timestamp})`);
  } catch (e) {
    console.log(`${name}(${code}): 실패 - ${e.message}`);
  }
  await sleep(500); // 라이브봇 신호스캔과의 레이트리밋 경합 완화용 추가 여유
}

writeFileSync('./candles-1m-smoketest.json', JSON.stringify(out));
console.log(`저장 완료: ${out.length}종목`);
