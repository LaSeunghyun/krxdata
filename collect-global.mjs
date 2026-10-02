#!/usr/bin/env node
/**
 * collect-global.mjs - 해외 지표 일봉 수집: SOX(필라델피아 반도체), SPX, COMP(나스닥), VIX, USD/KRW (2026-10-01).
 *   소스: KIS 해외지수/환율 일봉 FHKST03030100 /overseas-price/v1/quotations/inquire-daily-chartprice
 *         (한투 공식 OpenAPI, 이미 발급된 앱키로 실측 OK. 스크래핑 아님.)
 *   FID_COND_MRKT_DIV_CODE: N=해외지수, X=환율. 한 호출 최대 100행.
 *   KST 오늘 이후(장중 미확정) 행은 저장하지 않는다 -> 이른 아침(KST 08:00 전후) 실행이 전제.
 *   테이블: global_indicators (date TEXT YYYYMMDD, code, PK(date, code)) 추가 전용.
 *   실행: node collect-global.mjs [--days 15] [--dry-run]   (초기 백필: --days 400)
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { kisGetRetry } from './kis-extra.mjs';
import { makeDbQuery, runWithSecondPass } from './lib/retry.mjs';
import { parseGlobalRows, sqlNum, kstToday } from './lib/parsers.mjs';
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const DAYS = Number(argOf('--days', '15'));
const DRY = process.argv.includes('--dry-run');
const dbQuery = makeDbQuery({ ref: process.env.SUPABASE_PROJECT_REF, key: process.env.SUPABASE_MANAGEMENT_KEY });

const INDICATORS = [
  { code: 'SOX', mkt: 'N', name: '필라델피아 반도체지수' },
  { code: 'SPX', mkt: 'N', name: 'S&P500' },
  { code: 'COMP', mkt: 'N', name: '나스닥 종합' },
  { code: 'VIX', mkt: 'N', name: 'VIX 지수' },
  { code: 'FX@KRW', mkt: 'X', name: '원/달러(KMB)' },
];
const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
const today = kstToday();
const startMs = Date.now() + 9 * 3_600_000 - DAYS * 86_400_000;

if (!DRY) await dbQuery(`CREATE TABLE IF NOT EXISTS global_indicators (
  date TEXT NOT NULL, code TEXT NOT NULL, name TEXT, open NUMERIC, high NUMERIC, low NUMERIC, close NUMERIC NOT NULL,
  snapshot_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (date, code)); SELECT 1;`);

let total = 0;
const res = await runWithSecondPass(INDICATORS, async (ind) => {
  // 100행 상한 -> 130일 단위 창으로 분할
  const rows = [];
  for (let s = startMs; s < Date.now() + 9 * 3_600_000; s += 130 * 86_400_000) {
    const e = Math.min(s + 130 * 86_400_000, Date.now() + 9 * 3_600_000);
    const j = await kisGetRetry('/uapi/overseas-price/v1/quotations/inquire-daily-chartprice', 'FHKST03030100',
      { FID_COND_MRKT_DIV_CODE: ind.mkt, FID_INPUT_ISCD: ind.code, FID_INPUT_DATE_1: ymd(s), FID_INPUT_DATE_2: ymd(e), FID_PERIOD_DIV_CODE: 'D' });
    rows.push(...parseGlobalRows(j, { today }));
    await new Promise(r => setTimeout(r, 250));
  }
  if (!rows.length) throw new Error(`${ind.code}: 유효 행 0`);
  const uniq = [...new Map(rows.map(r => [r.date, r])).values()];
  if (!DRY) {
    const vals = uniq.map(r => `('${r.date}','${ind.code}','${ind.name}',${sqlNum(r.open)},${sqlNum(r.high)},${sqlNum(r.low)},${sqlNum(r.close)})`);
    await dbQuery(`INSERT INTO global_indicators (date,code,name,open,high,low,close) VALUES ${vals.join(',')}
      ON CONFLICT (date,code) DO UPDATE SET open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, close=EXCLUDED.close, name=EXCLUDED.name`);
  }
  total += uniq.length;
  console.log(`  ${ind.code}: ${uniq.length}행 (${uniq.map(r => r.date).sort().at(0)}~${uniq.map(r => r.date).sort().at(-1)})`);
}, { passes: 2, passPauseMs: 10_000, log: console.log });

console.log(`해외지표 ${res.ok}/${INDICATORS.length} 지표 성공, ${total}행${DRY ? ' (dry-run)' : ''}`);
for (const f of res.failed) console.error(`  ${f.item.code} 실패: ${f.error.slice(0, 120)}`);
if (!DRY) console.log(JSON.stringify(await dbQuery(`SELECT code, count(*) n, max(date) mx FROM global_indicators GROUP BY 1 ORDER BY 1`)));
if (res.failed.length) process.exit(2);
