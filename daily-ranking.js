#!/usr/bin/env node
/**
 * daily-ranking.js
 * 매일 9시 실행: 전체 저평가 종목 랭킹 계산 + DB 저장 + 순위 변동 리포트
 */
import { readFileSync } from 'fs';
import { writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import {
  ANALYSIS_YEAR_NUM as YEAR,
  ANALYSIS_YEAR_PREV as YEAR_PREV,
  ANALYSIS_YEAR_PREV2 as YEAR_PREV2,
  FETCH_TIMEOUT_MS,
} from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_FILE = join(__dirname, '.update-status.json');
dotenv.config({ path: join(__dirname, '.env') });

// server.js가 자식으로 실행할 때(KRX_MANAGED=1)는 부모가 stdout을 파싱해
// 상태파일을 단독 기록한다. 동시 read-modify-write 경합을 막기 위해 자식은 기록하지 않음.
const STATUS_MANAGED = process.env.KRX_MANAGED === '1';

function loadStatus() {
  try {
    if (existsSync(STATUS_FILE)) return JSON.parse(readFileSync(STATUS_FILE, 'utf-8'));
  } catch {}
  return { running: false, progress: 0, total: 2610, current: '대기 중', log: [] };
}

function patchStatus(patch) {
  if (STATUS_MANAGED) return; // 부모(server.js)가 단독 기록
  try {
    const prev = loadStatus();
    writeFileSync(STATUS_FILE, JSON.stringify({ ...prev, ...patch }, null, 2), 'utf-8');
  } catch {}
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
const PUBLIC_KEY = process.env.PUBLIC_DATA_API_KEY;
const PUBLIC_BASE = "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService";
const DART_KEY = process.env.DART_API_KEY;

const SUPABASE_MANAGEMENT_KEY = process.env.SUPABASE_MANAGEMENT_KEY;
const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF;

const _missing = [
  ["SUPABASE_URL", SUPABASE_URL],
  ["SUPABASE_KEY(또는 SUPABASE_SERVICE_KEY)", SUPABASE_KEY],
  ["PUBLIC_DATA_API_KEY", PUBLIC_KEY],
  ["DART_API_KEY", DART_KEY],
  ["SUPABASE_MANAGEMENT_KEY", SUPABASE_MANAGEMENT_KEY],
  ["SUPABASE_PROJECT_REF", SUPABASE_PROJECT_REF],
].filter(([, v]) => !v).map(([k]) => k);
if (_missing.length) {
  console.error(`환경변수 미설정: ${_missing.join(", ")} — .env를 확인하세요.`);
  process.exit(1);
}

function today() { return new Date().toISOString().slice(0,10).replace(/-/g,''); }
function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate()-n);
  return d.toISOString().slice(0,10).replace(/-/g,'');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// 타임아웃 내장 fetch — API 무응답 시 withConcurrency 전체가 멈추는 것 방지
function fetchT(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
}
export function shouldRefresh52w(argv = process.argv.slice(2)) {
  const skipPrice = argv.includes('--skip-price');
  return !skipPrice || argv.includes('--refresh-52w');
}

export function shouldRunPriceUpdate(argv = process.argv.slice(2)) {
  return !argv.includes('--skip-price') || argv.includes('--refresh-52w');
}

async function dbQuery(sql) {
  const res = await fetchT(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_MANAGEMENT_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: sql })
  }, 60_000);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(data?.message ?? 'DB 쿼리 오류');
  return data;
}

async function upsert(table, rows, onConflict) {
  const res = await fetchT(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': `resolution=merge-duplicates,return=representation`,
      'on-conflict': onConflict
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error(`upsert ${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

// 공공데이터 API 현재가 + 52주 고저가 조회
async function getPublicDataQuote(stockCode, fetch52w = false) {
  try {
    const url = new URL(`${PUBLIC_BASE}/getStockPriceInfo`);
    url.searchParams.set("serviceKey", decodeURIComponent(PUBLIC_KEY));
    url.searchParams.set("resultType", "json");
    url.searchParams.set("numOfRows", fetch52w ? "260" : "5");
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("beginBasDt", fetch52w ? daysAgo(365) : daysAgo(7));
    url.searchParams.set("endBasDt", today());
    url.searchParams.set("likeIsinCd", `KR7${stockCode}`);
    const r = await fetchT(url.toString());
    const data = await r.json();
    const items = data?.response?.body?.items?.item ?? [];
    const arr = Array.isArray(items) ? items : [items];
    const filtered = arr.filter(r => r.srtnCd === stockCode).sort((a, b) => b.basDt.localeCompare(a.basDt));
    const item = filtered[0];
    if (!item) return null;
    const price = parseInt(item.clpr, 10);
    let marketCap = parseInt(item.mrktTotAmt, 10);
    // mrktTotAmt 누락 시 상장주식수×종가로 추산, 그래도 안 되면 0 (NaN이 SQL에 흘러들어 배치 전체가 깨지는 것 방지)
    if (!Number.isFinite(marketCap)) {
      const shares = parseInt(item.lstgStCnt ?? "0", 10);
      marketCap = Number.isFinite(shares) && Number.isFinite(price) ? shares * price : 0;
    }
    const result = {
      price,
      market_cap: marketCap,
      base_date: item.basDt
    };
    if (fetch52w && filtered.length > 1) {
      const prices = filtered.map(i => parseInt(i.clpr, 10)).filter(p => p > 0);
      result.high_52w = Math.max(...prices);
      result.low_52w  = Math.min(...prices);
    }
    return result;
  } catch { return null; }
}

// 수동 세마포어: 최대 concurrency개 태스크를 동시 실행
async function withConcurrency(tasks, limit) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = Promise.resolve().then(task).finally(() => executing.delete(p));
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.allSettled(results);
}

// STEP 1: 전체 종목 현재가 + 52주 고저가 업데이트
// 수정: 순차 for-of → withConcurrency(10) 병렬화로 30분→3분 목표
// 52주 갱신: full 모드는 항상 실행, ranking 모드는 --refresh-52w일 때만 강제 실행
async function updatePrices() {
  const stocks = await dbQuery(`SELECT stock_code FROM stock_analysis WHERE market_cap_tril >= 0`);
  const codes = stocks.map(s => s.stock_code);

  const skipPrice = process.argv.includes('--skip-price');
  const refresh52w = shouldRefresh52w(process.argv.slice(2));
  // full 모드(--skip-price 없음)에서는 항상 52w 갱신
  // ranking 모드(--skip-price)에서는 --refresh-52w일 때만 별도 갱신
  console.log(`[가격 업데이트] ${codes.length}개 종목 시작 (52주 갱신: ${refresh52w ? 'ON' : 'OFF'}, concurrency=10)`);
  patchStatus({ progress: 0, total: codes.length, current: `가격 업데이트 시작 (${codes.length}개)` });

  let updated = 0, skipped = 0, done = 0;
  const BATCH     = 50;   // 진행 로그 주기
  const SQL_BATCH = 200;  // SQL upsert 묶음 크기

  const buffer = []; // { code, price, cap, high, low }
  // flush를 promise 체인으로 직렬화 — withConcurrency 병렬 태스크가 동시에 flush를
  // 트리거해도 한 번에 하나씩만 실행되며, 드롭 없이 순차 처리된다.
  let flushChain = Promise.resolve();
  const num = v => (Number.isFinite(v) ? v : 'NULL'); // 비정상 숫자는 NULL로 (배치 전체 깨짐 방지)

  function flushBuffer() {
    if (!buffer.length) return flushChain;
    const rows = buffer.splice(0, buffer.length);
    flushChain = flushChain.then(async () => {
      const vals = rows
        // stock_code 화이트리스트 검증 (raw SQL 보간이므로 방어)
        .filter(r => /^[A-Za-z0-9]{5,6}$/.test(r.code) && Number.isFinite(r.price))
        .map(r =>
          `('${r.code}', ${num(r.price)}, ${num(r.cap)}` +
          (r.high != null ? `, ${num(r.high)}, ${num(r.low)}, TRUE` : `, NULL, NULL, FALSE`) +
          `)`
        ).join(',\n');
      if (!vals) return;
      await dbQuery(`
        UPDATE stock_analysis AS sa
        SET current_price     = v.current_price,
            market_cap_tril   = v.market_cap_tril,
            high_52w          = COALESCE(v.high_52w, sa.high_52w),
            low_52w           = COALESCE(v.low_52w, sa.low_52w),
            week52_updated_at = CASE WHEN v.refreshed THEN NOW() ELSE sa.week52_updated_at END,
            updated_at        = NOW()
        FROM (
          VALUES ${vals}
        ) AS v(stock_code, current_price, market_cap_tril, high_52w, low_52w, refreshed)
        WHERE sa.stock_code = v.stock_code
      `);
    });
    return flushChain;
  }

  const tasks = codes.map(code => async () => {
    const q = await getPublicDataQuote(code, refresh52w);
    if (q && q.price > 0) {
      const cap = parseFloat((q.market_cap / 1e12).toFixed(4));
      buffer.push({
        code,
        price: q.price,
        cap: Number.isFinite(cap) ? cap : 0,
        high: q.high_52w ?? null,
        low:  q.low_52w  ?? null,
      });
      updated++;
    } else {
      skipped++;
    }
    done++;
    if (buffer.length >= SQL_BATCH) await flushBuffer();
    if (done % BATCH === 0) {
      const pct = Math.round((done / codes.length) * 50);
      console.log(`  진행: ${done}/${codes.length} (업데이트 ${updated}, 스킵 ${skipped})`);
      patchStatus({ progress: pct, current: `가격 업데이트 중 (${done}/${codes.length})` });
    }
  });

  await withConcurrency(tasks, 10);
  await flushBuffer(); // 나머지 flush
  console.log(`[가격 업데이트 완료] 업데이트 ${updated}, 스킵 ${skipped}`);
  patchStatus({ progress: 50, current: '가격 업데이트 완료' });
}

// STEP 2: 저평가 전체 랭킹 계산 + DB 저장
async function computeAndSaveRankings() {
  console.log(`[랭킹 계산] 시작`);
  patchStatus({ progress: 60, current: '랭킹 계산 중...' });
  // 오늘 데이터 초기화 후 재삽입 (이전 실행 잔여 데이터 제거)
  await dbQuery(`DELETE FROM daily_rankings WHERE rank_date = CURRENT_DATE`);

  const r = await dbQuery(`
    INSERT INTO daily_rankings (
      rank_date, rank, stock_code, corp_name, mrkt_ctg, sector,
      current_price, market_cap_tril, pbr, per, roe, op_margin, debt_ratio,
      undervalue_score, total_score, sector_avg_pbr, sector_avg_per
    )
    WITH scored AS (
      SELECT
        sa.stock_code,
        sa.corp_name,
        sa.mrkt_ctg,
        sa.sector,
        sa.current_price,
        sa.market_cap_tril,
        sa.total_score,
        sf.pbr,
        sf.per,
        sf.roe,
        sf.op_margin,
        sf.debt_ratio,
        ss.avg_pbr AS sector_avg_pbr,
        ss.avg_per AS sector_avg_per,
        -- 52주 위치 (0~1, 높을수록 고점에 가까움)
        CASE
          WHEN sa.high_52w > sa.low_52w
          THEN (sa.current_price - sa.low_52w)::NUMERIC / NULLIF(sa.high_52w - sa.low_52w, 0)
          ELSE 0.5
        END AS price_position_52w,
        ROUND((
          -- [PBR 할인 20pt] 섹터 평균 대비 단계별 점수
          CASE
            WHEN sf.pbr IS NULL OR ss.avg_pbr IS NULL OR ss.avg_pbr = 0 THEN 0
            WHEN sf.pbr <= ss.avg_pbr * 0.3  THEN 20
            WHEN sf.pbr <= ss.avg_pbr * 0.5  THEN 16
            WHEN sf.pbr <= ss.avg_pbr * 0.7  THEN 12
            WHEN sf.pbr <= ss.avg_pbr * 0.9  THEN 7
            WHEN sf.pbr <= ss.avg_pbr        THEN 3
            ELSE 0
          END
          -- [PER 할인 10pt] 섹터 평균 대비 단계별 점수
          + CASE
            WHEN sf.per IS NULL OR ss.avg_per IS NULL OR ss.avg_per = 0 OR sf.per <= 0 THEN 0
            WHEN sf.per <= ss.avg_per * 0.3  THEN 10
            WHEN sf.per <= ss.avg_per * 0.5  THEN 8
            WHEN sf.per <= ss.avg_per * 0.7  THEN 5
            WHEN sf.per <= ss.avg_per        THEN 2
            ELSE 0
          END
          -- [PCR 10pt] 신규 — cf_ops 기반 현금흐름 수익률
          + CASE
            WHEN sf.cf_ops IS NULL OR sf.cf_ops <= 0 THEN 0
            WHEN sa.market_cap_tril IS NULL OR sa.market_cap_tril = 0 THEN 0
            ELSE LEAST(10,
              CASE
                WHEN (sf.cf_ops::NUMERIC / (sa.market_cap_tril * 1e12)) >= 0.15 THEN 10
                WHEN (sf.cf_ops::NUMERIC / (sa.market_cap_tril * 1e12)) >= 0.10 THEN 8
                WHEN (sf.cf_ops::NUMERIC / (sa.market_cap_tril * 1e12)) >= 0.07 THEN 5
                WHEN (sf.cf_ops::NUMERIC / (sa.market_cap_tril * 1e12)) >= 0.04 THEN 3
                ELSE 1
              END)
          END
          -- [ROE 15pt]
          + CASE
            WHEN sf.roe IS NULL OR sf.roe <= 0 THEN 0
            WHEN sf.roe >= 25 THEN 15
            WHEN sf.roe >= 15 THEN 12
            WHEN sf.roe >= 10 THEN 8
            WHEN sf.roe >= 5  THEN 4
            ELSE 1
          END
          -- [영업이익률 10pt]
          + CASE
            WHEN sf.op_margin IS NULL OR sf.op_margin <= 0 THEN 0
            WHEN sf.op_margin >= 25 THEN 10
            WHEN sf.op_margin >= 15 THEN 8
            WHEN sf.op_margin >= 8  THEN 5
            WHEN sf.op_margin >= 3  THEN 2
            ELSE 0
          END
          -- [이익 추세 15pt] 52주 모멘텀 대체 — 이익YoY 방향성
          + CASE
            WHEN sf.op_income_yoy IS NULL THEN 5
            WHEN sf.op_income_yoy >= 100 THEN 15
            WHEN sf.op_income_yoy >= 50  THEN 13
            WHEN sf.op_income_yoy >= 20  THEN 10
            WHEN sf.op_income_yoy >= 0   THEN 7
            WHEN sf.op_income_yoy >= -10 THEN 3
            ELSE 0
          END
          -- [이익YoY 15pt]
          + CASE
            WHEN sf.op_income_yoy IS NULL THEN 0
            WHEN sf.op_income_yoy >= 200 THEN 15
            WHEN sf.op_income_yoy >= 100 THEN 12
            WHEN sf.op_income_yoy >= 50  THEN 9
            WHEN sf.op_income_yoy >= 20  THEN 6
            WHEN sf.op_income_yoy >= 0   THEN 3
            ELSE 0
          END
          -- [이익 안정성 5pt] 신규 — cf_ops > 0 + 순이익 > 0
          + CASE
            WHEN sf.cf_ops > 0 AND sf.net_income > 0 THEN 5
            WHEN sf.cf_ops > 0 OR  sf.net_income > 0 THEN 2
            ELSE 0
          END
          -- [부채비율 페널티 -15pt max]
          - CASE
            WHEN sf.debt_ratio IS NULL   THEN 0
            WHEN sf.debt_ratio > 200     THEN 15
            WHEN sf.debt_ratio > 150     THEN 10
            WHEN sf.debt_ratio > 100     THEN 5
            ELSE 0
          END
          -- [이자보상배율 페널티 -10pt] 신규
          - CASE
            WHEN sf.op_income IS NULL OR sf.total_debt IS NULL OR sf.total_debt = 0 THEN 0
            WHEN sf.op_income <= 0 AND sf.total_debt > 0 THEN 10
            WHEN (sf.op_income::NUMERIC / NULLIF(sf.total_debt * 0.04, 0)) < 1 THEN 10
            WHEN (sf.op_income::NUMERIC / NULLIF(sf.total_debt * 0.04, 0)) < 2 THEN 5
            ELSE 0
          END
        )::NUMERIC *
        -- [지주사 Soft Penalty x0.6]
        CASE
          WHEN sa.corp_name LIKE '%홀딩스%' OR sa.corp_name LIKE '%지주%' THEN 0.6
          ELSE 1.0
        END
        , 1) AS undervalue_score
      FROM stock_analysis sa
      JOIN stock_financials sf ON sa.stock_code = sf.stock_code AND sf.analysis_year = ${YEAR}
      LEFT JOIN sector_stats ss ON sa.sector = ss.sector AND sa.mrkt_ctg = ss.mrkt_ctg
      WHERE sa.current_price > 0
        AND sf.pbr > 0 AND sf.pbr < 100
        AND ss.avg_pbr IS NOT NULL
        -- 하드 필터: 부채비율 300% 초과 제거
        AND (sf.debt_ratio IS NULL OR sf.debt_ratio < 300)
        -- 하드 필터: ROE 음수(적자) 제거 / 바이오는 ROE > 5% 강화
        AND (
          (sa.sector NOT LIKE '%바이오%' AND sa.sector NOT LIKE '%의약%' AND sf.roe > 0)
          OR (sa.sector LIKE '%바이오%' OR sa.sector LIKE '%의약%') AND sf.roe > 5
        )
        -- 하드 필터: 영업이익률 > 2% (적자 직전 제거)
        AND sf.op_margin > 2
        -- 하드 필터: 시총 1,000억 미만 제거 (500억→1,000억 보수적 강화)
        AND sa.market_cap_tril >= 0.1
        -- 하드 필터: 52주 위치 70% 초과(모멘텀 하락 구간) 제거
        AND (
          sa.high_52w IS NULL OR sa.low_52w IS NULL OR sa.high_52w = sa.low_52w
          OR (sa.current_price - sa.low_52w)::NUMERIC / NULLIF(sa.high_52w - sa.low_52w, 0) < 0.7
        )
        -- 가치함정 Hard Filter: 영업현금흐름 음수 + PBR 극저 조합 제외
        AND NOT (sf.cf_ops < 0 AND sf.pbr < 0.5)
        -- 매출·이익 동반 급감 제외
        AND NOT (sf.revenue_yoy < -20 AND sf.op_income_yoy < -30)
    )
    SELECT
      CURRENT_DATE,
      ROW_NUMBER() OVER (ORDER BY undervalue_score DESC NULLS LAST),
      stock_code, corp_name, mrkt_ctg, sector,
      current_price, market_cap_tril, pbr, per, roe, op_margin, debt_ratio,
      undervalue_score, total_score, sector_avg_pbr, sector_avg_per
    FROM scored
    WHERE undervalue_score IS NOT NULL
    ON CONFLICT (rank_date, stock_code) DO UPDATE SET
      rank = EXCLUDED.rank,
      undervalue_score = EXCLUDED.undervalue_score,
      current_price = EXCLUDED.current_price,
      market_cap_tril = EXCLUDED.market_cap_tril,
      pbr = EXCLUDED.pbr,
      per = EXCLUDED.per,
      roe = EXCLUDED.roe
    RETURNING rank, stock_code, corp_name, undervalue_score
  `);

  if (!Array.isArray(r)) { console.error("랭킹 오류:", r); return []; }
  console.log(`[랭킹 저장 완료] ${r.length}건`);
  patchStatus({ progress: 90, current: `랭킹 저장 완료 (${r.length}건)` });
  return r;
}

// STEP 2.1: op_income_yoy 계산 — 직전연도 대비 교차 업데이트
// NOTE: op_income_yoy IS NULL 가드를 제거해 매 실행마다 재계산한다.
//       (재무 재적재 시에도 stale 값이 고착되지 않도록)
async function calcOpIncomeYoy() {
  const r = await dbQuery(`
    UPDATE stock_financials f25
    SET op_income_yoy = ROUND(
      (f25.op_income - f24.op_income)::NUMERIC / NULLIF(ABS(f24.op_income), 0) * 100,
      1
    )
    FROM stock_financials f24
    WHERE f25.stock_code     = f24.stock_code
      AND f25.analysis_year  = ${YEAR}
      AND f24.analysis_year  = ${YEAR_PREV}
      AND f25.op_income      IS NOT NULL
      AND f24.op_income      IS NOT NULL
      AND f24.op_income     != 0
  `);
  // 전전연도 → 직전연도도 동일 처리
  await dbQuery(`
    UPDATE stock_financials f24
    SET op_income_yoy = ROUND(
      (f24.op_income - f23.op_income)::NUMERIC / NULLIF(ABS(f23.op_income), 0) * 100,
      1
    )
    FROM stock_financials f23
    WHERE f24.stock_code     = f23.stock_code
      AND f24.analysis_year  = ${YEAR_PREV}
      AND f23.analysis_year  = ${YEAR_PREV2}
      AND f24.op_income      IS NOT NULL
      AND f23.op_income      IS NOT NULL
      AND f23.op_income     != 0
  `);
  const remaining = await dbQuery(
    `SELECT COUNT(*) cnt FROM stock_financials WHERE analysis_year=${YEAR} AND op_income_yoy IS NULL`
  );
  console.log(`[YoY 계산 완료] 남은 NULL: ${remaining[0]?.cnt ?? '?'}건 (2024 데이터 없는 종목)`);
}

// 섹터 멀티플 (v5: 바이오/IT 상향, 금융/건설/지주 하향)
function getSectorMultiplier(sector, corpName) {
  if (!sector && !corpName) return 1.0;
  if (corpName?.includes('홀딩스') || corpName?.includes('지주')) return 0.5;
  const s = sector || '';
  if (s.includes('바이오') || s.includes('의약')) return 1.3;
  if (s.includes('반도체') || s.includes('IT') || s.includes('소프트')) return 1.2;
  if (s.includes('금융') || s.includes('보험') || s.includes('증권')) return 0.7;
  if (s.includes('건설') || s.includes('부동산')) return 0.8;
  return 1.0;
}

// 목표가 계산 (Codex v5: 섹터 멀티플 적용)
// score 80 / mult 1.0 → 1M: +8.0%, 3M: +32.0%, 1Y: +64.0%
// NOTE: stock-utils.js의 calcTargetPrice(EPS·PER 기반)와 다른 로직 — undervalue_score 기반 목표가
function calcTargetByScore(currentPrice, undervalueScore, period = '1m', sector = null, corpName = null) {
  if (!currentPrice || !undervalueScore || undervalueScore <= 0) return null;
  const coeff = period === '1y' ? 0.80 : period === '3m' ? 0.40 : 0.10;
  const mult = getSectorMultiplier(sector, corpName);
  return Math.round(currentPrice * (1 + (undervalueScore / 100) * coeff * mult));
}

// 매크로 레짐 게이트: 삼성전자(005930) KOSPI 프록시 기준 시장 상태 판단
// ETF API 미지원으로 삼성전자(KOSPI 비중 ~30%) 사용
async function checkMarketRegime() {
  try {
    const url = new URL(`${PUBLIC_BASE}/getStockPriceInfo`);
    url.searchParams.set("serviceKey", decodeURIComponent(PUBLIC_KEY));
    url.searchParams.set("resultType", "json");
    url.searchParams.set("numOfRows", "25");
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("beginBasDt", daysAgo(30));
    url.searchParams.set("endBasDt", today());
    url.searchParams.set("likeIsinCd", "KR7005930");
    const r = await fetchT(url.toString());
    const data = await r.json();
    const items = data?.response?.body?.items?.item ?? [];
    const arr = (Array.isArray(items) ? items : [items])
      .filter(i => i.srtnCd === '005930')
      .sort((a, b) => b.basDt.localeCompare(a.basDt));
    if (arr.length < 6) return { status: 'unknown', warn: false };
    const latest  = parseInt(arr[0].clpr, 10);
    const day5ago = parseInt(arr[5].clpr, 10);
    const ma20    = arr.slice(0, Math.min(arr.length, 20))
                       .reduce((s, i) => s + parseInt(i.clpr, 10), 0) / Math.min(arr.length, 20);
    const ret5d   = ((latest - day5ago) / day5ago) * 100;
    const belowMA = latest < ma20;
    const warn    = belowMA && ret5d < -3;
    return { latest, ma20: Math.round(ma20), ret5d: ret5d.toFixed(2), belowMA, warn };
  } catch { return { status: 'error', warn: false }; }
}

// ─────────────────────────────────────────────────────────────
// STEP 2.5: 빅배스 턴어라운드 감시 (Stage 1 — 모니터링 전용)
// 합의된 3단계 로드맵:
//   Stage 1 (현재): DART 잠정실적 감지 → 감시 목록 출력 (랭킹 미편입)
//   Stage 2 (3개월 후): 감시 목록 백테스트 → 수익률 검증
//   Stage 3 (검증 후): --enable-recovery 플래그로 Codex 4조건 필터 완화 활성화
// ─────────────────────────────────────────────────────────────

/**
 * 빅배스 후보 조건 (SQL):
 *   Condition 1: 2025 op_margin < 0  (직전 연도 일회성 적자)
 *   Condition 2: 2024 op_margin > 0  (전전 연도 흑자 — 구조적 부실 아님)
 *   Condition 4: debt_ratio < 350%   (재무 붕괴 방어)
 *
 * 추가 조건 (DART):
 *   Condition 3: 최근 6개월 내 잠정실적 공시 존재 → 회복 확인
 *
 * Stage 3 활성화 시 추가:
 *   → 랭킹 편입 + 불확실성 페널티 -10pt 부과
 */
async function detectBigBathRecovery() {
  try {
    // Condition 1 + 2 + 4: DB에서 후보 추출
    const candidates = await dbQuery(`
      SELECT sa.stock_code, sa.corp_name, sa.mrkt_ctg, sa.sector,
             sa.current_price, sa.market_cap_tril,
             sf25.op_margin  AS op_margin_2025,
             sf25.roe        AS roe_2025,
             sf25.debt_ratio AS debt_ratio,
             sf24.op_margin  AS op_margin_2024
      FROM stock_analysis sa
      JOIN stock_financials sf25 ON sa.stock_code = sf25.stock_code AND sf25.analysis_year = ${YEAR}
      JOIN stock_financials sf24 ON sa.stock_code = sf24.stock_code AND sf24.analysis_year = ${YEAR_PREV}
      WHERE sf25.op_margin < 0
        AND sf24.op_margin > 0
        AND (sf25.debt_ratio IS NULL OR sf25.debt_ratio < 350)
        AND sa.market_cap_tril >= 0.1
        AND sa.current_price > 0
      ORDER BY sa.market_cap_tril DESC
      LIMIT 50
    `);

    if (!Array.isArray(candidates) || candidates.length === 0) return [];

    // Condition 3: DART 잠정실적 공시 체크 (순차, rate limit 주의)
    const recovered = [];
    for (const s of candidates) {
      try {
        const bgn = daysAgo(180);
        const end = today();
        const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${DART_KEY}` +
                    `&stock_code=${s.stock_code}&bgn_de=${bgn}&end_de=${end}&page_count=10`;
        const r   = await fetchT(url);
        const d   = await r.json();
        const items = d?.list ?? [];

        const hit = items.find(i =>
          i.report_nm.includes('잠정실적') ||
          i.report_nm.includes('영업(잠정)') ||
          i.report_nm.includes('잠정)실적')  ||
          i.report_nm.includes('잠정 실적')
        );

        if (hit) {
          recovered.push({
            ...s,
            disclosure_date:  hit.rcept_dt,
            disclosure_title: hit.report_nm.trim(),
          });
        }
        await sleep(150); // DART rate limit
      } catch { /* 개별 오류 무시 */ }
    }

    return recovered;
  } catch (e) {
    console.error('[빅배스 감지 오류]', e.message);
    return [];
  }
}

function printRecoveryWatch(candidates) {
  if (!candidates.length) {
    console.log('\n[턴어라운드 감시] 해당 종목 없음 (Condition 1~4 미충족)');
    return;
  }

  console.log('\n╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║  🔄 빅배스 턴어라운드 감시 목록  [Stage 1 — 모니터링 전용, 랭킹 미편입]       ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
  console.log('  ※ 2025 영업 적자(필터 탈락) + 2024 흑자 + 잠정실적 공시 확인 종목');
  console.log('  ※ Stage 3 활성화(--enable-recovery) 전까지 관찰만 수행\n');
  console.log('종목명            코드    시총(억)  2025이익률  2024이익률  부채비율  잠정실적 공시');
  console.log('─'.repeat(105));

  for (const c of candidates) {
    const cap = (c.market_cap_tril * 1000).toFixed(0);
    console.log(
      `${c.corp_name.slice(0, 14).padEnd(16)} ${c.stock_code}  ` +
      `${String(cap + '억').padStart(8)}  ` +
      `${String((c.op_margin_2025 ?? '-') + '%').padStart(10)}  ` +
      `${String((c.op_margin_2024 ?? '-') + '%').padStart(10)}  ` +
      `${String((c.debt_ratio ?? '-') + '%').padStart(8)}  ` +
      `${c.disclosure_date}: ${c.disclosure_title.slice(0, 25)}`
    );
  }

  console.log(`\n  → 감지 ${candidates.length}건 | 3개월 백테스트 후 --enable-recovery 플래그로 편입 활성화`);
  console.log('  → Stage 3 편입 시 스코어에 불확실성 페널티 -10pt 자동 부과');
}

// STEP 3: 순위 변동 리포트 출력
async function printChangeReport() {
  const changes = await dbQuery(`
    SELECT
      rank_today,
      rank_yesterday,
      rank_change,
      stock_code,
      corp_name,
      mrkt_ctg,
      sector,
      current_price,
      prev_price,
      price_change,
      pbr,
      per,
      undervalue_score,
      score_change
    FROM rank_changes
    WHERE rank_today <= 50
    ORDER BY rank_today
  `);

  if (!Array.isArray(changes)) { console.log("변동 데이터 없음"); return; }

  console.log("\n========== 저평가 랭킹 TOP 20 (매수 포트폴리오) ==========");
  console.log(`기준일: ${new Date().toLocaleDateString('ko-KR')}`);
  console.log("순위  변동  종목명              시장   섹터          현재가   1M목표(+%)   3M목표(+%)   1Y목표(+%)  점수  비중");
  console.log("─".repeat(125));

  const top20 = changes.filter(c => c.rank_today <= 20);
  for (const c of top20) {
    const change = c.rank_change === null ? "NEW" :
      c.rank_change > 0 ? `▲${c.rank_change}` :
      c.rank_change < 0 ? `▼${Math.abs(c.rank_change)}` : "─";
    const t1m = calcTargetByScore(c.current_price, c.undervalue_score, '1m', c.sector, c.corp_name);
    const t3m = calcTargetByScore(c.current_price, c.undervalue_score, '3m', c.sector, c.corp_name);
    const t1y = calcTargetByScore(c.current_price, c.undervalue_score, '1y', c.sector, c.corp_name);
    const fmt = (t, base) => t ? `${t.toLocaleString()}(+${((t-base)/base*100).toFixed(1)}%)` : '-';
    const weight = c.rank_today <= 10 ? '10%' : ' 5%';
    console.log(
      `${String(c.rank_today).padStart(3)}  ${change.padEnd(5)} ${c.corp_name.slice(0,14).padEnd(16)} ${c.mrkt_ctg.padEnd(6)} ${(c.sector||'').slice(0,12).padEnd(13)} ` +
      `${c.current_price.toLocaleString('ko-KR').padStart(8)}  ` +
      `${fmt(t1m,c.current_price).padStart(14)}  ${fmt(t3m,c.current_price).padStart(14)}  ${fmt(t1y,c.current_price).padStart(14)}  ` +
      `${String(c.undervalue_score||'').padStart(5)}  ${weight}`
    );
  }

  console.log("\n  [리밸런싱 규칙] 스톱로스 -25% 즉시청산 | +100% 절반익절 | 반기(6개월) 전체 재스크리닝");

  // TOP 21~50 간략 표시
  const rest = changes.filter(c => c.rank_today > 20 && c.rank_today <= 50);
  if (rest.length > 0) {
    console.log("\n---------- TOP 21~50 (관찰 대상) ----------");
    console.log("순위  변동  종목명              시장   현재가     PBR   점수");
    console.log("─".repeat(65));
    for (const c of rest) {
      const change = c.rank_change === null ? "NEW" :
        c.rank_change > 0 ? `▲${c.rank_change}` :
        c.rank_change < 0 ? `▼${Math.abs(c.rank_change)}` : "─";
      console.log(
        `${String(c.rank_today).padStart(3)}  ${change.padEnd(5)} ${c.corp_name.slice(0,14).padEnd(16)} ${c.mrkt_ctg.padEnd(6)} ` +
        `${c.current_price.toLocaleString('ko-KR').padStart(8)}  ${String(c.pbr||'').padStart(5)} ${String(c.undervalue_score||'').padStart(5)}`
      );
    }
  }

  // 순위 급변동
  const bigMovers = changes.filter(c => c.rank_change !== null && Math.abs(c.rank_change) >= 10);
  if (bigMovers.length > 0) {
    console.log("\n========== 순위 급변동 (±10위 이상) ==========");
    bigMovers.sort((a, b) => Math.abs(b.rank_change) - Math.abs(a.rank_change)).slice(0, 10).forEach(c => {
      const arrow = c.rank_change > 0 ? `▲${c.rank_change}위 상승` : `▼${Math.abs(c.rank_change)}위 하락`;
      console.log(`  ${c.corp_name} (${c.stock_code}): ${arrow} | PBR ${c.pbr} | 점수변동 ${c.score_change > 0 ? '+' : ''}${c.score_change}`);
    });
  }
}

// MAIN
async function main() {
  const args           = process.argv.slice(2);
  const skipPrice      = args.includes('--skip-price');
  const enableRecovery = args.includes('--enable-recovery'); // Stage 3: 3개월 백테스트 완료 후 활성화
  const runPriceUpdate = shouldRunPriceUpdate(args);

  // 상태 파일이 없거나 서버 외부에서 직접 실행할 때 초기화
  const prevStatus = loadStatus();
  if (!prevStatus.running) {
    patchStatus({
      running: true,
      mode: runPriceUpdate ? 'full' : 'ranking',
      progress: 0,
      current: runPriceUpdate ? '가격+랭킹 업데이트 시작...' : '랭킹 업데이트 시작...',
      startedAt: new Date().toISOString()
    });
  }

  try {
    if (runPriceUpdate) {
      await updatePrices();
    } else {
      console.log("[가격 업데이트 스킵]");
      patchStatus({ progress: 10, current: '가격 업데이트 스킵됨' });
    }
    // 매크로 레짐 게이트 체크
    const regime = await checkMarketRegime();
    if (regime.warn) {
      console.log("\n⚠️  [매크로 경고] 시장 위험 구간 감지!");
      console.log(`   KODEX200: ${regime.latest?.toLocaleString()}원 / 20MA: ${regime.ma20?.toLocaleString()}원 (MA 하향)`);
      console.log(`   5일 수익률: ${regime.ret5d}% (임계값 -3% 초과)`);
      console.log("   → 신규 진입 보류 권고. 기존 보유 종목 스톱로스 확인 필요.\n");
    } else if (regime.latest) {
      console.log(`[시장 체크] KODEX200 ${regime.latest?.toLocaleString()}원 / 20MA ${regime.ma20?.toLocaleString()}원 / 5일수익률 ${regime.ret5d}% — 정상`);
    }

    // op_income_yoy 계산 (데이터 있는 경우 자동 갱신)
    await calcOpIncomeYoy();

    await computeAndSaveRankings();
    await printChangeReport();

    // Stage 1: 빅배스 턴어라운드 감시 (항상 실행)
    console.log('\n[턴어라운드 감시] 빅배스 후보 탐색 중...');
    const recoveryWatch = await detectBigBathRecovery();
    printRecoveryWatch(recoveryWatch);

    if (enableRecovery) {
      // Stage 3: --enable-recovery 플래그 활성 시 경고 (아직 SQL 미구현 — 백테스트 후 적용)
      console.log('\n⚠️  [--enable-recovery] Stage 3 플래그 감지. 백테스트 검증 완료 후 SQL 필터 완화 적용 예정.');
    }

    const now = new Date().toLocaleString('ko-KR');
    console.log("\n[완료]", now);
    patchStatus({ running: false, progress: 100, current: '완료', lastDone: now });
  } catch (e) {
    console.error("[오류]", e);
    patchStatus({ running: false, current: `오류: ${e.message}` });
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
