#!/usr/bin/env node
/**
 * collect-kis-extra.mjs - KIS 신용잔고·공매도·대차거래 일별 수집 (2026-10-01).
 *   엔드포인트 실측(2026-10-01, 삼성전자 005930): 셋 다 이 앱키로 권한 OK.
 *     신용잔고  FHPST04760000 /quotations/daily-credit-balance (30행/호출, 키=deal_date)
 *     공매도    FHPST04830000 /quotations/daily-short-sale     (기간 지정, 최대 100행)
 *     대차거래  HHPST074500C0 /quotations/daily-loan-trans     (기간 지정, 최대 100행)
 *   테이블: stock_credit_balance / stock_short_sale / stock_lending (모두 PK (date, stock_code), 추가 전용).
 *   KIS 앱키는 flow-snapshot·forecast·섀도우와 공유 -> 호출마다 백오프, 장중(KST 09:00-15:30) 대량 호출은 거부한다.
 *   실행: node collect-kis-extra.mjs [--limit 420] [--only credit,short,loan] [--days 45] [--credit-pages 1] [--dry-run] [--force-market-hours]
 *   초기 백필: --days 200 --credit-pages 4
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { kisGetRetry } from './kis-extra.mjs';
import { makeDbQuery, fetchThenFlush } from './lib/retry.mjs';
import { parseCreditRows, parseShortRows, parseLoanRows, sqlNum, isStockCode, kstToday } from './lib/parsers.mjs';
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const LIMIT = Number(argOf('--limit', '420'));
const DAYS = Number(argOf('--days', '45'));
const CREDIT_PAGES = Number(argOf('--credit-pages', '1'));
const ONLY = new Set(String(argOf('--only', 'credit,short,loan')).split(','));
const PACE = Number(argOf('--pace', '200'));
const DRY = process.argv.includes('--dry-run');
const dbQuery = makeDbQuery({ ref: process.env.SUPABASE_PROJECT_REF, key: process.env.SUPABASE_MANAGEMENT_KEY });

// 장중 가드: KST 09:00-15:30 평일 대량 호출 금지(앱키 공유). 소량 검증(--limit<=3)은 허용.
const kstNow = new Date(Date.now() + 9 * 3_600_000);
const hm = kstNow.getUTCHours() * 60 + kstNow.getUTCMinutes();
const weekday = kstNow.getUTCDay() >= 1 && kstNow.getUTCDay() <= 5;
if (weekday && hm >= 9 * 60 && hm < 15 * 60 + 30 && LIMIT > 3 && !process.argv.includes('--force-market-hours')) {
  console.error('장중(KST 09:00-15:30) 대량 호출 금지. 종료.'); process.exit(3);
}

const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
const today = kstToday();
const startStr = ymd(Date.now() + 9 * 3_600_000 - DAYS * 86_400_000);

const DDL = `
CREATE TABLE IF NOT EXISTS stock_credit_balance (
  date TEXT NOT NULL, stock_code TEXT NOT NULL, stlm_date TEXT, close NUMERIC,
  loan_new_shares BIGINT, loan_rdmp_shares BIGINT, loan_balance_shares BIGINT,
  loan_new_amt NUMERIC, loan_rdmp_amt NUMERIC, loan_balance_amt NUMERIC,
  loan_balance_rate NUMERIC, loan_gvrt NUMERIC,
  stln_new_shares BIGINT, stln_rdmp_shares BIGINT, stln_balance_shares BIGINT,
  stln_balance_amt NUMERIC, stln_balance_rate NUMERIC,
  snapshot_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (date, stock_code));
CREATE TABLE IF NOT EXISTS stock_short_sale (
  date TEXT NOT NULL, stock_code TEXT NOT NULL, close NUMERIC, volume BIGINT,
  short_vol BIGINT, short_vol_ratio NUMERIC, short_acc_vol BIGINT, short_acc_vol_ratio NUMERIC,
  short_amt NUMERIC, short_amt_ratio NUMERIC, short_acc_amt NUMERIC, short_acc_amt_ratio NUMERIC, avg_price NUMERIC,
  snapshot_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (date, stock_code));
CREATE TABLE IF NOT EXISTS stock_lending (
  date TEXT NOT NULL, stock_code TEXT NOT NULL, close NUMERIC,
  new_shares BIGINT, rdmp_shares BIGINT, balance_chg BIGINT, balance_shares BIGINT, balance_amt_mil NUMERIC,
  snapshot_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (date, stock_code));
SELECT 1;`;

const TYPES = {
  credit: {
    table: 'stock_credit_balance', cols: ['loan_new_shares', 'loan_rdmp_shares', 'loan_balance_shares', 'loan_new_amt', 'loan_rdmp_amt', 'loan_balance_amt', 'loan_balance_rate', 'loan_gvrt', 'stln_new_shares', 'stln_rdmp_shares', 'stln_balance_shares', 'stln_balance_amt', 'stln_balance_rate', 'stlm_date', 'close'],
    async fetch(code) {
      const all = []; let d1 = today;
      for (let p = 0; p < CREDIT_PAGES; p++) {
        const j = await kisGetRetry('/uapi/domestic-stock/v1/quotations/daily-credit-balance', 'FHPST04760000',
          { FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '20476', FID_INPUT_ISCD: code, FID_INPUT_DATE_1: d1 });
        const rows = parseCreditRows(j);
        all.push(...rows);
        if (!rows.length) break;
        const oldest = rows.map(r => r.stlm_date || r.date).sort()[0];
        d1 = ymd(Date.UTC(+oldest.slice(0, 4), +oldest.slice(4, 6) - 1, +oldest.slice(6, 8)) - 86_400_000);
      }
      return all;
    },
  },
  short: {
    table: 'stock_short_sale', cols: ['close', 'volume', 'short_vol', 'short_vol_ratio', 'short_acc_vol', 'short_acc_vol_ratio', 'short_amt', 'short_amt_ratio', 'short_acc_amt', 'short_acc_amt_ratio', 'avg_price'],
    async fetch(code) {
      const j = await kisGetRetry('/uapi/domestic-stock/v1/quotations/daily-short-sale', 'FHPST04830000',
        { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code, FID_INPUT_DATE_1: startStr, FID_INPUT_DATE_2: today });
      return parseShortRows(j);
    },
  },
  loan: {
    table: 'stock_lending', cols: ['close', 'new_shares', 'rdmp_shares', 'balance_chg', 'balance_shares', 'balance_amt_mil'],
    async fetch(code) {
      const j = await kisGetRetry('/uapi/domestic-stock/v1/quotations/daily-loan-trans', 'HHPST074500C0',
        { MRKT_DIV_CLS_CODE: '3', MKSC_SHRN_ISCD: code, START_DATE: startStr, END_DATE: today, CTS: '' });
      return parseLoanRows(j);
    },
  },
};

function insertSql(t, rows) {
  const cols = ['date', 'stock_code', ...t.cols];
  const vals = rows.map(r => `('${r.date}','${r.code}',${t.cols.map(c => c === 'stlm_date' ? (r[c] ? `'${r[c]}'` : 'NULL') : sqlNum(r[c])).join(',')})`);
  const upd = t.cols.map(c => `${c}=EXCLUDED.${c}`).join(',');
  return `INSERT INTO ${t.table} (${cols.join(',')}) VALUES ${vals.join(',')} ON CONFLICT (date,stock_code) DO UPDATE SET ${upd}`;
}

if (!DRY) await dbQuery(DDL);
const codes = (await dbQuery(`SELECT stock_code FROM stock_analysis
  WHERE current_price>=2000 AND avg_turnover_20d>=3e9 ORDER BY market_cap_tril DESC LIMIT ${LIMIT}`)).map(r => r.stock_code).filter(isStockCode);
console.log(`유니버스 ${codes.length}종목, 대상 ${[...ONLY].join(',')}, 기간 ${startStr}~${today}${DRY ? ' (dry-run)' : ''}`);

let worst = 1;
for (const [name, t] of Object.entries(TYPES)) {
  if (!ONLY.has(name)) continue;
  const t0 = Date.now();
  const res = await fetchThenFlush(codes, {
    fetchOne: async (code) => (await t.fetch(code)).map(r => ({ code, ...r })),
    flushRows: async (rows) => { if (!DRY) await dbQuery(insertSql(t, rows)); },
    chunkSize: 20, pace: PACE, passes: 2, passPauseMs: 20_000, log: (m) => console.log(`[${name}]${m}`),
  });
  for (const f of res.failed.slice(0, 3)) console.error(`  [${name}] ${f.item} 실패: ${String(f.error).slice(0, 120)}`);
  console.log(`[${name}] 성공 ${res.flushed}/${res.total} (${(res.rate * 100).toFixed(1)}%), ${res.rows}행, ${Math.round((Date.now() - t0) / 1000)}초`);
  worst = Math.min(worst, res.rate);
  if (!DRY) {
    const s = await dbQuery(`SELECT count(*) n, count(DISTINCT stock_code) c, max(date) mx FROM ${t.table}`);
    console.log(`[${name}] 누적 ${JSON.stringify(s[0])}`);
  }
}
if (worst < 0.95) { console.error(`성공률 ${(worst * 100).toFixed(1)}% < 95%`); process.exit(2); }
