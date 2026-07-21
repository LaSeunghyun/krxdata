#!/usr/bin/env node
/**
 * flow-snapshot.mjs — KIS 투자자 수급(외국인·기관·개인 순매수)을 유니버스 전체에 대해 매일 DB 저장.
 *   KIS getInvestorDaily는 최근 30일만 반환 → 매일 upsert로 저장하면 30일 넘는 행이 잔존해
 *   히스토리가 무한 축적된다(몇 달 뒤 예측력 검증·학습 가능). 장 마감 후 실행(수급 확정).
 *   유니버스: 지수 ETF(069500 KOSPI·229200 KOSDAQ) + 시총상위 유동주 40.
 *   테이블: stock_investor_flows (date, stock_code, close, frgn/orgn/prsn_amt_mil).
 *   실행: node flow-snapshot.mjs [--limit 40]
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getInvestorDaily, isKisConfigured } from './kis-api.js';
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const LIMIT = Number(argOf('--limit', '40'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function dbQuery(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(60_000) });
  const j = await r.json();
  if (!Array.isArray(j) && j?.message) throw new Error(j.message);
  return j;
}

if (!isKisConfigured()) { console.error('KIS 미설정'); process.exit(1); }

await dbQuery(`
  CREATE TABLE IF NOT EXISTS stock_investor_flows (
    date TEXT NOT NULL, stock_code TEXT NOT NULL, close NUMERIC,
    frgn_amt_mil BIGINT, orgn_amt_mil BIGINT, prsn_amt_mil BIGINT,
    snapshot_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (date, stock_code));
  SELECT 1;`);

const largeCaps = (await dbQuery(`SELECT stock_code FROM stock_analysis
  WHERE current_price>=2000 AND avg_turnover_20d>=3e9 ORDER BY market_cap_tril DESC LIMIT ${LIMIT}`)).map(r => r.stock_code);
const universe = ['069500', '229200', ...largeCaps.filter(c => c !== '069500' && c !== '229200')];

let ok = 0, fail = 0, rowsUp = 0;
for (const code of universe) {
  try {
    const flows = await getInvestorDaily(code); // 최근 30일
    const vals = flows.filter(f => f.date && f.close != null).map(f =>
      `('${f.date}','${code}',${Number(f.close) || 0},${Number(f.frgn_amt_mil) || 0},${Number(f.orgn_amt_mil) || 0},${Number(f.prsn_amt_mil) || 0})`);
    if (vals.length) {
      await dbQuery(`INSERT INTO stock_investor_flows (date,stock_code,close,frgn_amt_mil,orgn_amt_mil,prsn_amt_mil)
        VALUES ${vals.join(',')}
        ON CONFLICT (date,stock_code) DO UPDATE SET close=EXCLUDED.close,
          frgn_amt_mil=EXCLUDED.frgn_amt_mil, orgn_amt_mil=EXCLUDED.orgn_amt_mil, prsn_amt_mil=EXCLUDED.prsn_amt_mil`);
      rowsUp += vals.length;
    }
    ok++;
  } catch (e) { fail++; if (fail <= 3) console.error(`  ${code} 실패: ${String(e.message).slice(0, 80)}`); }
  await sleep(150); // KIS rate limit 여유
}
const total = await dbQuery(`SELECT count(*) n, count(DISTINCT date) d, count(DISTINCT stock_code) c,
  min(date) mn, max(date) mx FROM stock_investor_flows`);
console.log(`스냅샷 완료: 종목 ${ok}/${universe.length} 성공(${fail} 실패), 이번 upsert ${rowsUp}행`);
console.log(`누적: ${JSON.stringify(total[0])}`);
