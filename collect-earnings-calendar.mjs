#!/usr/bin/env node
/**
 * collect-earnings-calendar.mjs - 영업(잠정)실적 공시 이력 수집 + 종목별 통상 발표 시기 도출 (2026-10-01).
 *   DART 에는 미래 실적발표 일정 API 가 없다. 대신 거래소공시(list.json pblntf_ty=I)의 "영업(잠정)실적" 접수일 이력에서
 *   종목-분기슬롯별 통상 접수 시점(슬롯 시작일 기준 일수 중앙값)을 구하고 다음 예상일을 계산한다.
 *   stock_disclosures 는 2026-04-23 이후만 있어(약 5개월) 표본이 부족 -> list.json 으로 2023-10-01 부터 직접 수집한다.
 *   테이블: stock_earnings_filings (PK rcept_no) / stock_earnings_calendar (PK stock_code, slot). 추가 전용.
 *   이력 2회 미만인 (종목,슬롯)은 법정 제출기한(상한)을 source='statutory_deadline' 로 채운다. 잠정실적 공시는 임의 공시라 전 종목이 내지 않는다.
 *   실행: node collect-earnings-calendar.mjs [--since 20231001] [--dry-run] [--recompute-only]
 *   일 증분: 기본 최근 10일 창만 수집 후 전체 재계산.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { listAll } from './lib/dart.mjs';
import { makeDbQuery, splitWindows } from './lib/retry.mjs';
import { isEarningsPrelimTitle, sqlStr, sqlNum, isStockCode, kstToday } from './lib/parsers.mjs';
import { deriveCalendar, statutoryFallback } from './lib/earnings-calendar.mjs';
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry-run');
const RECOMPUTE = process.argv.includes('--recompute-only');
const today = kstToday();
const todayIso = `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}`;
const since = argOf('--since', new Date(Date.now() + 9 * 3_600_000 - 10 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, ''));
const dbQuery = makeDbQuery({ ref: process.env.SUPABASE_PROJECT_REF, key: process.env.SUPABASE_MANAGEMENT_KEY });

const DDL = `
CREATE TABLE IF NOT EXISTS stock_earnings_filings (
  rcept_no TEXT PRIMARY KEY, stock_code TEXT NOT NULL, corp_code TEXT, rcept_dt DATE NOT NULL, report_nm TEXT,
  is_consolidated BOOLEAN, snapshot_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS stock_earnings_filings_idx ON stock_earnings_filings (stock_code, rcept_dt);
CREATE TABLE IF NOT EXISTS stock_earnings_calendar (
  stock_code TEXT NOT NULL, slot TEXT NOT NULL CHECK (slot IN ('Q1','Q2','Q3','Q4')),
  source TEXT NOT NULL, n_obs INT NOT NULL, median_offset_days INT, min_offset_days INT, max_offset_days INT,
  last_filed DATE, next_expected DATE, updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (stock_code, slot));
SELECT 1;`;

if (!DRY) await dbQuery(DDL);

if (!RECOMPUTE) {
  let kept = 0;
  for (const [bgn, end] of splitWindows(since, today, 85)) {
    const list = await listAll({ bgn, end, ty: 'I', onPage: (p, t) => { if (p % 25 === 0) console.log(`  ${bgn}~${end} 페이지 ${p}/${t}`); } });
    const hits = list.filter(x => isEarningsPrelimTitle(x.report_nm) && isStockCode(x.stock_code) && /^\d{8}$/.test(x.rcept_dt));
    kept += hits.length;
    console.log(`창 ${bgn}~${end}: 거래소공시 ${list.length}건 중 영업(잠정)실적 ${hits.length}건`);
    if (!DRY) for (let i = 0; i < hits.length; i += 200) {
      const vals = hits.slice(i, i + 200).map(x => `(${sqlStr(x.rcept_no)},${sqlStr(x.stock_code)},${sqlStr(x.corp_code)},'${x.rcept_dt.slice(0, 4)}-${x.rcept_dt.slice(4, 6)}-${x.rcept_dt.slice(6, 8)}',${sqlStr(x.report_nm.replace(/\s+/g, ' ').trim())},${/연결/.test(x.report_nm)})`);
      await dbQuery(`INSERT INTO stock_earnings_filings (rcept_no,stock_code,corp_code,rcept_dt,report_nm,is_consolidated) VALUES ${vals.join(',')} ON CONFLICT (rcept_no) DO NOTHING`);
    }
  }
  console.log(`수집 완료: 잠정실적 ${kept}건`);
}

if (DRY) { console.log('dry-run: 재계산 생략'); process.exit(0); }

const filings = await dbQuery(`SELECT stock_code, to_char(rcept_dt,'YYYY-MM-DD') rcept_dt FROM stock_earnings_filings`);
const universe = (await dbQuery(`SELECT stock_code FROM stock_analysis`)).map(r => r.stock_code).filter(isStockCode);
const derived = deriveCalendar(filings, { today: todayIso, minObs: 2, maxYears: 3 });
const fallback = statutoryFallback(universe, derived, { today: todayIso });
const all = [...derived, ...fallback];
for (let i = 0; i < all.length; i += 500) {
  const vals = all.slice(i, i + 500).map(r => `(${sqlStr(r.stock_code)},${sqlStr(r.slot)},${sqlStr(r.source)},${r.n_obs},${sqlNum(r.median_offset_days)},${sqlNum(r.min_offset_days)},${sqlNum(r.max_offset_days)},${sqlStr(r.last_filed)},${sqlStr(r.next_expected)})`);
  await dbQuery(`INSERT INTO stock_earnings_calendar (stock_code,slot,source,n_obs,median_offset_days,min_offset_days,max_offset_days,last_filed,next_expected)
    VALUES ${vals.join(',')} ON CONFLICT (stock_code,slot) DO UPDATE SET source=EXCLUDED.source, n_obs=EXCLUDED.n_obs, median_offset_days=EXCLUDED.median_offset_days,
      min_offset_days=EXCLUDED.min_offset_days, max_offset_days=EXCLUDED.max_offset_days, last_filed=EXCLUDED.last_filed, next_expected=EXCLUDED.next_expected, updated_at=NOW()`);
}
const stats = await dbQuery(`SELECT source, count(*) rows, count(DISTINCT stock_code) stocks FROM stock_earnings_calendar GROUP BY 1`);
const fl = await dbQuery(`SELECT count(*) n, count(DISTINCT stock_code) c, min(rcept_dt) mn, max(rcept_dt) mx FROM stock_earnings_filings`);
console.log(`캘린더: ${JSON.stringify(stats)} / 이력 ${JSON.stringify(fl[0])} / 유니버스 ${universe.length}종목`);
