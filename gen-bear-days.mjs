#!/usr/bin/env node
/**
 * gen-bear-days.mjs — forecast 엔진(buildForecast)을 과거 KOSPI 프록시(069500)에 적용해
 *   날짜별 "하락경보(bear)" 시계열 생성. look-ahead 없음: 날짜 D의 판정은 D-1까지의 일봉만 사용.
 *   출력: forecast-bear-days.json  { "YYYYMMDD": true/false, ... }
 *   용도: backtest-swing.mjs --forecastguard 가 읽어 이익보호 규칙 백테스트.
 *   bear 규칙 = stock-live isBearish 동일: call==='down' OR (prob_down-prob_up>=15 AND conf>=50)
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync } from 'fs';
import { getDailyCandles } from './toss-api.js';
import { buildForecast } from './forecast-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const PROBDIFF = 15, MINCONF = 50; // strategy-contract FORECAST_GUARD 기본과 동일
const isBearish = (f) => !!f && (f.call === 'down' || (f.probs.down - f.probs.up >= PROBDIFF && f.confidence >= MINCONF));

const bars = (await getDailyCandles('069500', 1200)).reverse(); // 오름차순
const day = bars.map(b => String(b.timestamp).slice(0, 10).replace(/-/g, ''));
const close = bars.map(b => b.close);
// 일간 종가수익률(%) — rets[i] = (close[i]/close[i-1]-1)*100
const rets = close.map((c, i) => i === 0 ? 0 : (c / close[i - 1] - 1) * 100);

const out = {};
let bearN = 0, total = 0;
for (let i = 130; i < day.length; i++) {   // 130봉 워밍업 후부터
  const hist = rets.slice(1, i);            // D-1까지 (look-ahead 없음)
  const f = buildForecast(hist);
  const bear = isBearish(f);
  out[day[i]] = bear;
  total++; if (bear) bearN++;
}
writeFileSync(join(__dirname, 'forecast-bear-days.json'), JSON.stringify(out));
console.log(`069500 ${day.length}봉 | bear-day ${bearN}/${total} (${(bearN / total * 100).toFixed(1)}%) | ${day[130]}~${day[day.length - 1]}`);
console.log(`저장: forecast-bear-days.json`);
