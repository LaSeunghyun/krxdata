#!/usr/bin/env node
/**
 * flow-snapshot.mjs — KIS 투자자 수급(외국인·기관·개인 순매수)을 유니버스 전체에 대해 매일 DB 저장.
 *   KIS getInvestorDaily는 최근 30일만 반환 → 매일 upsert로 저장하면 30일 넘는 행이 잔존해
 *   히스토리가 무한 축적된다(몇 달 뒤 예측력 검증·학습 가능). 장 마감 후 실행(수급 확정).
 *   유니버스: 지수 ETF(069500 KOSPI·229200 KOSDAQ) + 시총상위 유동주 N.
 *   테이블: stock_investor_flows (date, stock_code, close, frgn/orgn/prsn_amt_mil).
 *   실행: node flow-snapshot.mjs [--limit 40] [--dry-run]
 *
 * 2026-10-01 개정 (9/30 실행: 422종목 중 184 실패):
 *   원인은 KIS 가 아니라 Supabase Management API 의 "ThrottlerException: Too Many Requests" 였다
 *   (KIS 오류는 "KIS <tr_id>:" 접두가 붙는데 로그엔 없었다). 종목당 DB 1회 upsert = 422회 호출이 원인.
 *   대응: (1) DB 쓰기를 20종목 묶음으로 줄임 (2) KIS/DB 모두 지수 백오프 재시도
 *         (3) 실패 항목 2차 패스 (4) 성공률 로그, 95% 미만이면 exit 2.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getInvestorDaily, isKisConfigured } from './kis-api.js';
import { makeDbQuery, withBackoff, fetchThenFlush, isThrottleError } from './lib/retry.mjs';
import { parseFlowRows, isStockCode } from './lib/parsers.mjs';
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const LIMIT = Number(argOf('--limit', '40'));
const DRY = process.argv.includes('--dry-run');
const PACE = Number(argOf('--pace', '150'));
const dbQuery = makeDbQuery({ ref: process.env.SUPABASE_PROJECT_REF, key: process.env.SUPABASE_MANAGEMENT_KEY });

if (!isKisConfigured()) { console.error('KIS 미설정'); process.exit(1); }

// 장중 가드(앱키 공유): KST 평일 09:00-15:30 에 대량(limit>3) 호출 금지. 크론은 18:00 KST 라 영향 없음.
{
  const k = new Date(Date.now() + 9 * 3_600_000);
  const hm = k.getUTCHours() * 60 + k.getUTCMinutes(), wd = k.getUTCDay();
  if (wd >= 1 && wd <= 5 && hm >= 540 && hm < 930 && LIMIT > 3 && !process.argv.includes('--force-market-hours')) {
    console.error('장중(KST 09:00-15:30) 대량 호출 금지. 종료.'); process.exit(3);
  }
}

await dbQuery(`
  CREATE TABLE IF NOT EXISTS stock_investor_flows (
    date TEXT NOT NULL, stock_code TEXT NOT NULL, close NUMERIC,
    frgn_amt_mil BIGINT, orgn_amt_mil BIGINT, prsn_amt_mil BIGINT,
    snapshot_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (date, stock_code));
  SELECT 1;`);

const largeCaps = (await dbQuery(`SELECT stock_code FROM stock_analysis
  WHERE current_price>=2000 AND avg_turnover_20d>=3e9 ORDER BY market_cap_tril DESC LIMIT ${LIMIT}`)).map(r => r.stock_code);
const universe = ['069500', '229200', ...largeCaps.filter(c => c !== '069500' && c !== '229200')].filter(isStockCode);

const log = (m) => console.log(m);
const t0 = Date.now();
const res = await fetchThenFlush(universe, {
  // KIS 레이트리밋은 kis-api.js 내부(4회)에 더해 여기서 한 번 더 백오프. throttle 이 아닌 오류는 즉시 실패.
  fetchOne: async (code) => {
    // kis-api.js 가 레이트리밋('KIS <tr>:' 접두)을 이미 4회 재시도한다. 바깥 재시도는 그 외(네트워크) 오류만 1회로 제한해 호출 곱셈을 막는다.
    const flows = await withBackoff(() => getInvestorDaily(code), { retries: 1, base: 800, shouldRetry: (e) => isThrottleError(e) && !/^KIS \w+:/.test(String(e?.message)) });
    return parseFlowRows(flows).map(f => ({ code, ...f }));
  },
  flushRows: async (rows) => {
    if (DRY) return;
    const vals = rows.map(f => `('${f.date}','${f.code}',${f.close},${f.frgn},${f.orgn},${f.prsn})`);
    await dbQuery(`INSERT INTO stock_investor_flows (date,stock_code,close,frgn_amt_mil,orgn_amt_mil,prsn_amt_mil)
      VALUES ${vals.join(',')}
      ON CONFLICT (date,stock_code) DO UPDATE SET close=EXCLUDED.close,
        frgn_amt_mil=EXCLUDED.frgn_amt_mil, orgn_amt_mil=EXCLUDED.orgn_amt_mil, prsn_amt_mil=EXCLUDED.prsn_amt_mil`);
  },
  chunkSize: 20, pace: PACE, passes: 2, passPauseMs: 20_000, log,
});

for (const f of res.failed.slice(0, 5)) console.error(`  ${f.item} 실패: ${String(f.error).slice(0, 100)}`);
const pct = (res.rate * 100).toFixed(1);
console.log(`스냅샷 완료${DRY ? '(dry-run, DB 미기록)' : ''}: 종목 ${res.flushed}/${res.total} 성공(${res.failed.length} 실패, 0행 응답 ${res.empty}, 성공률 ${pct}%, 0행 포함 ${(res.rateIncludingEmpty * 100).toFixed(1)}%), 이번 upsert ${res.rows}행, ${Math.round((Date.now() - t0) / 1000)}초`);
const total = await dbQuery(`SELECT count(*) n, count(DISTINCT date) d, count(DISTINCT stock_code) c,
  min(date) mn, max(date) mx FROM stock_investor_flows`);
const latest = await dbQuery(`SELECT max(date) mx, count(DISTINCT stock_code) c FROM stock_investor_flows
  WHERE date=(SELECT max(date) FROM stock_investor_flows)`);
console.log(`누적: ${JSON.stringify(total[0])} / 최신일 종목수: ${JSON.stringify(latest[0])}`);
if (res.rate < 0.95) { console.error(`성공률 ${pct}% < 95%`); process.exit(2); }
