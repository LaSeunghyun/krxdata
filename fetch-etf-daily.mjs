#!/usr/bin/env node
/**
 * fetch-etf-daily.mjs — 지수 ETF 일봉 수집 → etf-daily-<code>.json (2026-08-08, 연구용)
 *
 * 왜: 베타 회귀에 실제 거래 가능한 시장 프록시가 필요하다. 등가중 합성지수는 거래 불가.
 * ⚠️ ETF 는 KRX 정규장만 존재(종목과 달리 NXT 없음) — 종목 일봉과 세션 정의가 다르다.
 * 읽기 전용. 라이브 봇과 계정을 공유하므로 rateSlot 은 toss-api 가 관리한다.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync } from 'fs';
import { getDailyCandles } from './toss-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const CODES = process.argv.slice(2).length ? process.argv.slice(2)
  : ['069500', '229200', '122630', '233740'];

for (const code of CODES) {
  try {
    const bars = await getDailyCandles(code, 1300);
    writeFileSync(join(__dirname, `etf-daily-${code}.json`), JSON.stringify(bars));
    console.log(`${code} bars=${bars.length} sample=${JSON.stringify(bars[0])}`);
  } catch (e) {
    console.log(`${code} ERR ${e.message}`);
  }
}
