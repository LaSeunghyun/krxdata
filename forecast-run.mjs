#!/usr/bin/env node
/**
 * forecast-run.mjs — KOSPI·KOSDAQ 단기 확률예측·사후검증 러너 (Phase 1 MVP)
 * 설계: C:\claudeT\docs\superpowers\specs\2026-07-21-krxdata-market-forecast-ledger-design.md
 *
 * 페이즈 (KST 자동 감지, 수동 override: node forecast-run.mjs [pre|close|daily] [--dry] [--force]):
 *   pre   (<09:00)      : 검증 캐치업 + 오늘 구간(전일종가→오늘종가) 예측
 *   close (15:40~19:29) : 만기 예측 검증 + 익일 구간(오늘종가→익일종가) 예측
 *   daily (19:30~)      : 신규 예측 없음 — 일일 결산 + 최근 20거래일 롤링 지표
 *
 * 원칙:
 *  - forecast_ledger는 INSERT 전용(불변). 검증은 forecast_verification 별도 테이블.
 *  - 숫자는 전부 forecast-core.mjs 통계 엔진이 산출 (LLM 조정은 Phase 1.5, stat_* 컬럼에 원값 보존).
 *  - 지수는 ETF 프록시(KODEX200 069500 / KODEX코스닥150 229200) — 공식 지수 아님을 라벨에 명시.
 *  - 섹터는 stock_analysis.sector(KSIC 33분류) 시총가중 합성지수. 공식 업종지수와 혼용 금지.
 *  - 장 마감(15:40) 전에는 당일 미완성 캔들을 버린다 — NXT 프리마켓 체결이 일봉에 선반영될 수
 *    있어(daily-ranking.js:596과 동일 방어) 미완성 종가로 검증·예측하면 원장이 영구 오염된다.
 *  - 09:00~11:30은 paper-swing morning(실주문) 창 — 토스 토큰 경합(2026-07-07 401 사고) 방지 위해
 *    실행하지 않고, 부팅 catch-up 동시발화 대비로 paper run_lock 최근 20분 감지 시 양보한다.
 *  - 매수·매도 추천 없음. 시세 읽기 전용.
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import dotenv from 'dotenv';
import { isTossConfigured, getDailyCandles, getKrMarketCalendar } from './toss-api.js';
import { toUtcIso, toKstDateKey, toKstTimeLabel } from './trading-time.mjs';
import { MIN_AVG_TURNOVER } from './config.js';
import {
  ENGINE_VERSION, buildForecast, scoreVerification, summarizeVerifications,
} from './forecast-core.mjs';
import { llmEnabled, analyzeVerifications, analyzeDaily, analyzeOutlook } from './forecast-llm.mjs';
import {
  NXT_AFTER, fetch1mByDate, fetchBasket1m, historyIntervalReturns,
  intervalReturn, basketSessionSeries, basketLiveMove, lastBarHm, priceAt,
  relabelStampsToTradingDays,
} from './forecast-intraday.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const kstDate = () => toKstDateKey();
const kstHM = () => toKstTimeLabel();
const log = (...a) => console.log(`[forecast ${kstHM()}]`, ...a);

// ── 대상 정의 ────────────────────────────────────────────────
const MARKETS = [
  { key: 'KOSPI_PROXY', code: '069500', label: 'KOSPI(프록시 KODEX200)' },
  { key: 'KOSDAQ_PROXY', code: '229200', label: 'KOSDAQ(프록시 KODEX코스닥150)' },
];
const TOP_SECTORS = 10;
const SESSION = 'KRX_REGULAR';
const DATA_SOURCE_VERSION = 'toss-candles+1m+stock_prices-v2';
const FX_PROXY = { code: '261240', label: '환율 프록시(KODEX 미국달러선물)' };
// 장중 구간 경계(KST). 각 장중 실행은 "지금 → 다음 경계" 구간을 예측한다.
// 09:00~10:30 개장 구간은 paper-swing 실주문 창(09:03)과 겹쳐 의도적으로 비워둔다.
const INTRADAY_BOUNDARIES = ['1130', '1330', '1430', '1530'];
const ETF_1M_TOTAL = 8000;    // ≈ 20거래일 (정규장 390분/일)
const NXT_1M_TOTAL = 9600;    // 종목은 08:00~20:00 ~710분/일 → ≈ 13거래일
const NXT_BASKET_SIZE = 5;    // 시총 상위 5 (top10 시총의 ~85%)
const NXT_MIN_COVERAGE = 0.5; // 유효 체결 시총 비중 미달 시 평가 보류
const CALL_K = Number.isFinite(Number(process.env.FORECAST_CALL_K))
  ? Number(process.env.FORECAST_CALL_K) : 0.5;

// ── DB (Supabase Management API — daily-ranking.js와 동일 경로) ──
function fetchT(url, opts = {}, timeoutMs = 60_000) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
}
async function dbQuery(sql) {
  const res = await fetchT(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(data?.message ?? 'DB 쿼리 오류');
  return data;
}
const esc = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const num = (x) => (x == null || !Number.isFinite(Number(x)) ? 'NULL' : String(Number(x)));
const jsonb = (o) => (o == null ? 'NULL' : `$j$${JSON.stringify(o).replace(/\$/g, '')}$j$::jsonb`);

async function notifyTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetchT(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000) }),
    }, 10_000);
  } catch (e) { log(`텔레그램 전송 실패: ${e.message}`); }
}

// 이중 실행 방지 — paper-swing과 동일 패턴 (paper_state 원자적 INSERT..ON CONFLICT)
async function acquireRunLock(phase) {
  const key = `run_lock:fc_${phase}:${kstDate()}`;
  const me = JSON.stringify({ host: process.env.COMPUTERNAME || 'unknown', pid: process.pid, at: toUtcIso(new Date()) });
  const rows = await dbQuery(
    `INSERT INTO paper_state (k, data, updated_at) VALUES ('${key}', '${me}'::jsonb, NOW())
     ON CONFLICT (k) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
     WHERE paper_state.updated_at < NOW() - INTERVAL '30 minutes'
     RETURNING k`);
  return Array.isArray(rows) && rows.length > 0;
}

// 부팅 catch-up 동시발화 방어: paper-swing이 최근 20분 내 실행됐으면 이번 실행 양보
// (토스 토큰이 프로세스별 in-memory라 동시 실행 시 상호 무효화 — 2026-07-07 401 사고 클래스)
async function paperSwingRecentlyActive() {
  const d = kstDate();
  const rows = await dbQuery(`
    SELECT k FROM paper_state
    WHERE k IN ('run_lock:morning:${d}', 'run_lock:close:${d}', 'run_lock:live_queue:${d}')
      AND updated_at > NOW() - INTERVAL '20 minutes'`);
  return rows.map(r => r.k);
}

async function ensureTables() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS paper_state (
      k TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS market_snapshots (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      run_id TEXT UNIQUE NOT NULL,
      phase TEXT NOT NULL,
      taken_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      data_cutoff_at TIMESTAMPTZ,
      data_quality TEXT,
      data_delay_minutes INT,
      payload JSONB);
    CREATE TABLE IF NOT EXISTS forecast_ledger (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      run_id TEXT NOT NULL,
      snapshot_id BIGINT REFERENCES market_snapshots(id),
      forecast_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      data_cutoff_at TIMESTAMPTZ,
      session TEXT,
      market_layer TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      sector TEXT NOT NULL,
      target_start_date TEXT NOT NULL,
      target_end_date TEXT NOT NULL,
      target_start_hm TEXT,
      target_end_hm TEXT,
      universe_version TEXT,
      sector_mapping_version TEXT,
      start_price NUMERIC,
      forecast_median NUMERIC NOT NULL,
      forecast_low NUMERIC NOT NULL,
      forecast_high NUMERIC NOT NULL,
      probability_up NUMERIC NOT NULL,
      probability_flat NUMERIC NOT NULL,
      probability_down NUMERIC NOT NULL,
      confidence NUMERIC,
      flat_band NUMERIC,
      sigma NUMERIC,
      call_direction TEXT,
      stat_median NUMERIC, stat_low NUMERIC, stat_high NUMERIC,
      baselines JSONB, drivers JSONB, invalidation_conditions JSONB,
      engine_version TEXT, data_quality TEXT, data_delay_minutes INT,
      UNIQUE (run_id, market_layer, sector));
    CREATE INDEX IF NOT EXISTS idx_fl_end ON forecast_ledger (target_end_date);
    CREATE TABLE IF NOT EXISTS forecast_verification (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      ledger_id BIGINT UNIQUE REFERENCES forecast_ledger(id),
      verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actual_return NUMERIC NOT NULL,
      actual_class TEXT, pred_class TEXT,
      direction_hit BOOLEAN, partial_hit BOOLEAN,
      abs_error NUMERIC, in_range BOOLEAN, brier NUMERIC,
      call_result TEXT,
      baseline_scores JSONB,
      error_cause TEXT, cause_certainty TEXT);
    ALTER TABLE forecast_ledger ADD COLUMN IF NOT EXISTS target_start_hm TEXT;
    ALTER TABLE forecast_ledger ADD COLUMN IF NOT EXISTS target_end_hm TEXT;
    SELECT 1;
  `);
}

// ── 데이터 수집 ──────────────────────────────────────────────
const candleDate = (c) => String(c.timestamp).slice(0, 10).replace(/-/g, '');

// 일시적 네트워크 오류 1회 재시도 (백오프 1.5s)
async function withRetry(fn) {
  try { return await fn(); }
  catch { await new Promise(r => setTimeout(r, 1500)); return fn(); }
}

// ETF 일봉 → 오름차순 [{date, close}]. 장 마감 전에는 당일 미완성 캔들 제거.
async function fetchEtfSeries(includeToday) {
  const todayKey = kstDate();
  const out = {};
  for (const m of MARKETS) {
    try {
      const candles = (await withRetry(() => getDailyCandles(m.code, 260))).reverse();
      out[m.key] = candles
        .map(c => ({ date: candleDate(c), close: c.close }))
        .filter(x => x.close > 0 && (includeToday || x.date < todayKey));
    } catch (e) {
      log(`⚠️ ETF 일봉 실패 ${m.code}: ${e.message}`);
      out[m.key] = [];
    }
  }
  return out;
}

// 시총 상위 섹터 목록 (유동성 하드필터 통과 종목 기준)
async function fetchTopSectors() {
  return dbQuery(`
    SELECT sector, COUNT(*) AS n, ROUND(SUM(market_cap_tril)::numeric, 2) AS cap_tril
    FROM stock_analysis
    WHERE sector IS NOT NULL AND market_cap_tril > 0
      AND (avg_turnover_20d IS NULL OR avg_turnover_20d >= ${MIN_AVG_TURNOVER})
    GROUP BY sector ORDER BY SUM(market_cap_tril) DESC LIMIT ${TOP_SECTORS}`);
}

// 섹터 합성지수 일별 수익률 (시총가중, stock_prices 기반) → {sector: [{date, ret, n}]} 오름차순
// ⚠ stock_prices.date는 적재일(값=직전 거래일 종가) — etfDates(실거래일)로 재라벨링 필수.
//   재라벨 없이는 하루 이른 오채점 + 주말 가짜 0% 행이 분포를 오염시킨다 (2026-07-21 발견).
async function fetchSectorSeries(sectors, etfDates) {
  if (!sectors.length) return {};
  if (!etfDates?.length) { log('⚠️ 실거래일 캘린더 없음(ETF 일봉 실패) — 섹터 시계열 생략'); return {}; }
  const inList = sectors.map(esc).join(',');
  const rows = await dbQuery(`
    WITH uni AS (
      SELECT stock_code, sector, market_cap_tril FROM stock_analysis
      WHERE sector IN (${inList}) AND market_cap_tril > 0
        AND (avg_turnover_20d IS NULL OR avg_turnover_20d >= ${MIN_AVG_TURNOVER})
    ), px AS (
      SELECT p.stock_code, p.date, p.close,
             LAG(p.close) OVER (PARTITION BY p.stock_code ORDER BY p.date) AS prev_close
      FROM stock_prices p JOIN uni u ON u.stock_code = p.stock_code
      WHERE p.date >= TO_CHAR(CURRENT_DATE - 300, 'YYYYMMDD')
    )
    SELECT u.sector, px.date,
           (SUM((px.close / NULLIF(px.prev_close, 0) - 1) * u.market_cap_tril)
            / NULLIF(SUM(u.market_cap_tril), 0) * 100)::numeric(10,4) AS ret,
           COUNT(*) AS n
    FROM px JOIN uni u ON u.stock_code = px.stock_code
    WHERE px.prev_close IS NOT NULL AND px.close > 0
    GROUP BY u.sector, px.date
    ORDER BY u.sector, px.date`);
  const bySector = {};
  for (const r of rows) {
    (bySector[r.sector] ??= []).push({ date: r.date, ret: Number(r.ret), n: Number(r.n) });
  }
  const out = {};
  for (const [sector, items] of Object.entries(bySector)) {
    out[sector] = relabelStampsToTradingDays(items, etfDates);
  }
  return out;
}

// 섹터 매핑 버전 = 섹터→종목수 분포의 md5 (구성 변경 시에만 바뀜)
async function sectorMappingVersion() {
  const rows = await dbQuery(`
    SELECT sector, COUNT(*) AS n FROM stock_analysis
    WHERE sector IS NOT NULL GROUP BY sector ORDER BY sector`);
  const h = createHash('md5').update(JSON.stringify(rows)).digest('hex').slice(0, 12);
  return { version: `ksic33-${h}`, universe: rows.reduce((a, r) => a + Number(r.n), 0) };
}

// ── 캘린더 ───────────────────────────────────────────────────
async function loadCalendar() {
  try { return await getKrMarketCalendar(); } catch { return null; }
}
const isTrading = (d) => !!(d && (d.integrated || d.regularMarket));
function calFind(cal, dateKey) {
  return Array.isArray(cal) ? cal.find(d => String(d.date).replace(/-/g, '') === dateKey) : null;
}
function calTradingKeys(cal) {
  return Array.isArray(cal)
    ? cal.filter(isTrading).map(d => String(d.date).replace(/-/g, '')).sort()
    : [];
}
function nextTradingDate(cal, todayKey) {
  const future = calTradingKeys(cal).filter(k => k > todayKey);
  if (future.length) return future[0];
  // 폴백: 주말만 건너뛴 다음 평일. 공휴일로 빗나가면 검증이 "endDate 이상 첫 거래일 종가"로
  // 해석하므로(etfReturnBetween) 0% 오검증 없이 다음 거래일 기준으로 채점된다.
  const d = new Date(`${todayKey.slice(0, 4)}-${todayKey.slice(4, 6)}-${todayKey.slice(6, 8)}T12:00:00+09:00`);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while ([0, 6].includes(new Date(d.getTime() + 9 * 3600e3).getUTCDay())); // KST 기준 요일
  return toKstDateKey(d);
}
function prevTradingDate(cal, todayKey) {
  const past = calTradingKeys(cal).filter(k => k < todayKey);
  return past.length ? past[past.length - 1] : null;
}

// ── 검증 ─────────────────────────────────────────────────────
// end는 "endDate 이상 첫 거래일 종가"로 해석 — endDate가 공휴일로 빗나가도(캘린더 폴백)
// 시작가=종료가 0% 오검증이 나지 않는다. 데이터가 endDate에 못 미치면 null(다음 실행 대기).
function etfReturnBetween(series, startDate, endDate) {
  if (!series?.length) return null;
  const endBar = series.find(x => x.date >= endDate);
  if (!endBar) return null;
  const startBar = [...series].reverse().find(x => x.date <= startDate);
  if (!startBar || startBar.date >= endBar.date) return null;
  return (endBar.close / startBar.close - 1) * 100;
}
function sectorReturnBetween(series, startDate, endDate) {
  if (!series?.length) return null;
  const endEff = series.find(x => x.date >= endDate)?.date;
  if (!endEff) return null;
  const within = series.filter(x => x.date > startDate && x.date <= endEff);
  if (!within.length) return null;
  return (within.reduce((a, x) => a * (1 + x.ret / 100), 1) - 1) * 100;
}

async function verifyDue({ etfSeries, etf1m = null, dry }) {
  const todayKey = kstDate();
  const due = await dbQuery(`
    SELECT fl.id, fl.run_id, fl.sector, fl.target_kind, fl.market_layer,
           fl.target_start_date, fl.target_end_date, fl.target_start_hm, fl.target_end_hm,
           fl.forecast_median, fl.forecast_low, fl.forecast_high,
           fl.probability_up, fl.probability_flat, fl.probability_down,
           fl.flat_band, fl.sigma, fl.call_direction, fl.baselines
    FROM forecast_ledger fl
    LEFT JOIN forecast_verification fv ON fv.ledger_id = fl.id
    WHERE fv.id IS NULL AND fl.target_end_date <= '${todayKey}'
    ORDER BY fl.id LIMIT 300`);
  if (!due.length) return { verified: [], pending: 0 };

  // 원장에 있는 섹터가 top10에서 빠졌어도 검증 가능해야 하므로, 원장 섹터로 시계열 조회
  const dueSectors = [...new Set(due.filter(r => r.target_kind === 'sector').map(r => r.sector))];
  const sectorSeries = await fetchSectorSeries(dueSectors, (etfSeries.KOSPI_PROXY ?? []).map(x => x.date));

  // 장중(intraday) 행 검증용 ETF 1분봉 — 이번 실행이 이미 받아뒀으면 재사용, 아니면 필요 시 수집
  const needIntraday = due.some(r => r.target_end_hm && r.market_layer === 'KRX');
  let etf1mByKey = etf1m;
  if (needIntraday && !etf1mByKey) {
    etf1mByKey = {};
    for (const m of MARKETS) etf1mByKey[m.key] = await fetch1mByDate(m.code, ETF_1M_TOTAL);
  }
  // NXT 바스켓 행 검증용 (만기 NXT 행이 있을 때만 수집 — 무거움)
  const needNxt = due.some(r => r.market_layer === 'NXT');
  let nxtData = null;
  if (needNxt) nxtData = await loadNxtBasket(NXT_1M_TOTAL);

  const intradayActual = (row) => {
    const byDate = etf1mByKey?.[row.sector];
    const bars = byDate?.get(row.target_start_date);
    if (!bars) return null;
    const isPast = row.target_end_date < todayKey;
    return intervalReturn(bars, row.target_start_hm, row.target_end_hm, { dateIsPast: isPast });
  };
  const nxtActual = (row) => {
    if (!nxtData) return null;
    const series = basketSessionSeries(nxtData.byDateBySymbol, nxtData.weights,
      row.target_start_hm, row.target_end_hm, { todayKey });
    return series.find(x => x.date === row.target_start_date)?.ret ?? null;
  };

  const verified = [];
  let pending = 0;
  const values = [];
  for (const row of due) {
    let actual = null;
    if (row.market_layer === 'NXT') {
      actual = nxtActual(row);
    } else if (row.target_end_hm) {
      actual = intradayActual(row);
    } else if (row.target_kind === 'market') {
      actual = etfReturnBetween(etfSeries[row.sector], row.target_start_date, row.target_end_date);
    } else {
      actual = sectorReturnBetween(sectorSeries[row.sector], row.target_start_date, row.target_end_date);
    }
    if (actual == null) { pending += 1; continue; } // 데이터 미도착 — 다음 실행이 캐치업
    const v = scoreVerification(row, actual);
    verified.push({
      ...v, id: Number(row.id), sector: row.sector, target_kind: row.target_kind, run_id: row.run_id,
      market_layer: row.market_layer, target_start_hm: row.target_start_hm, target_end_hm: row.target_end_hm,
      target_end_date: row.target_end_date, forecast_median: Number(row.forecast_median),
      forecast_low: Number(row.forecast_low), forecast_high: Number(row.forecast_high),
      probability_up: Number(row.probability_up), probability_down: Number(row.probability_down),
      sigma: Number(row.sigma), flat_band: Number(row.flat_band), call_direction: row.call_direction,
    });
    values.push(`(${num(row.id)}, ${num(v.actual_return)}, ${esc(v.actual_class)}, ${esc(v.pred_class)},
      ${v.direction_hit}, ${v.partial_hit}, ${num(v.abs_error)}, ${v.in_range}, ${num(v.brier)},
      ${esc(v.call_result)}, ${jsonb(v.baseline_scores)})`);
  }
  if (values.length && !dry) {
    await dbQuery(`
      INSERT INTO forecast_verification
        (ledger_id, actual_return, actual_class, pred_class, direction_hit, partial_hit,
         abs_error, in_range, brier, call_result, baseline_scores)
      VALUES ${values.join(',')}
      ON CONFLICT (ledger_id) DO NOTHING`);
  }
  return { verified, pending };
}

// 최근 검증 이력 (일일 결산·누적 정확도 공용)
async function fetchRecentVerificationRows() {
  const rows = await dbQuery(`
    SELECT fl.sector, fl.target_kind, fl.target_end_date, fl.call_direction,
           fv.actual_return, fv.direction_hit, fv.partial_hit, fv.abs_error,
           fv.in_range, fv.brier, fv.call_result, fv.baseline_scores
    FROM forecast_verification fv JOIN forecast_ledger fl ON fl.id = fv.ledger_id
    WHERE fl.target_end_date >= TO_CHAR(CURRENT_DATE - 35, 'YYYYMMDD')
    ORDER BY fl.target_end_date`);
  return rows.map(r => ({
    ...r,
    baseline_scores: typeof r.baseline_scores === 'string' ? JSON.parse(r.baseline_scores) : r.baseline_scores,
  }));
}

// ── NXT 바스켓 · 환율 · 공시 컨텍스트 ────────────────────────
let nxtCache = null; // { total, weights, names, codes, byDateBySymbol }
async function loadNxtBasket(total) {
  if (nxtCache && nxtCache.total >= total) return nxtCache;
  const top = await dbQuery(`
    SELECT stock_code, corp_name, market_cap_tril FROM stock_analysis
    ORDER BY market_cap_tril DESC NULLS LAST LIMIT ${NXT_BASKET_SIZE}`);
  if (!top.length) return null;
  const weights = {}, names = {};
  for (const t of top) { weights[t.stock_code] = Number(t.market_cap_tril); names[t.stock_code] = t.corp_name; }
  const byDateBySymbol = await fetchBasket1m(Object.keys(weights), total);
  nxtCache = { total, weights, names, codes: Object.keys(weights), byDateBySymbol };
  return nxtCache;
}

async function fetchFxContext(includeToday) {
  try {
    const todayKey = kstDate();
    const s = (await getDailyCandles(FX_PROXY.code, 40)).reverse()
      .map(c => ({ date: candleDate(c), close: c.close }))
      .filter(x => x.close > 0 && (includeToday || x.date < todayKey));
    if (s.length < 21) return null;
    const rs = toReturns(s.map(x => x.close));
    return {
      label: FX_PROXY.label, last_date: s[s.length - 1].date,
      day_return_pct: Math.round(rs[rs.length - 1] * 100) / 100,
      m20_pct: Math.round((rs.slice(-20).reduce((a, b) => a + b, 0) / 20) * 100) / 100,
    };
  } catch { return null; }
}

// 수급 컨텍스트 — 시총 top5 합산 (KIS 종목별 투자자 동향, 확정치는 장마감 후)
async function fetchFlowContext() {
  const { isKisConfigured, getInvestorDaily } = await import('./kis-api.js');
  if (!isKisConfigured()) return null;
  try {
    const top = await dbQuery(`
      SELECT stock_code FROM stock_analysis ORDER BY market_cap_tril DESC NULLS LAST LIMIT ${NXT_BASKET_SIZE}`);
    let date = null, frgn = 0, orgn = 0, prsn = 0, n = 0;
    for (const t of top) {
      const rows = await getInvestorDaily(t.stock_code).catch(() => []);
      if (!rows.length) continue;
      const r = rows[0]; // 최신 확정일
      if (date && r.date !== date) continue; // 같은 날짜만 합산
      date = r.date; frgn += r.frgn_amt_mil; orgn += r.orgn_amt_mil; prsn += r.prsn_amt_mil; n += 1;
    }
    if (!n) return null;
    const bil = (m) => Math.round(m / 100); // 백만원 → 억원
    return { date, n, frgn_bil: bil(frgn), orgn_bil: bil(orgn), prsn_bil: bil(prsn) };
  } catch (e) { log(`수급 조회 실패(비치명): ${e.message}`); return null; }
}

async function fetchDisclosureContext() {
  try {
    const fresh = await dbQuery(`SELECT MAX(rcept_dt) AS mx FROM stock_disclosures`);
    const latest = fresh[0]?.mx ?? null;
    const sectors = await dbQuery(`
      SELECT sa.sector, COUNT(*) AS n, ROUND(AVG(sds.sentiment_score)::numeric, 2) AS avg_sentiment
      FROM stock_disclosures sd
      JOIN stock_analysis sa ON sa.stock_code = sd.stock_code
      LEFT JOIN stock_disclosure_sentiments sds ON sds.rcept_no = sd.rcept_no
      WHERE sd.rcept_dt >= TO_CHAR(CURRENT_DATE - 3, 'YYYY-MM-DD')
      GROUP BY sa.sector ORDER BY COUNT(*) DESC LIMIT 8`);
    const staleDays = latest
      ? Math.round((Date.parse(kstDate().replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')) - Date.parse(latest)) / 86400e3)
      : null;
    return { latest, stale_days: staleDays, is_stale: staleDays == null || staleDays > 2, sectors };
  } catch { return null; }
}

// ── 예측 생성 ────────────────────────────────────────────────
function toReturns(closes) {
  const rs = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) rs.push((closes[i] / closes[i - 1] - 1) * 100);
  }
  return rs;
}

async function makeForecasts({ phase, cal, etfSeries, sectorSeries, topSectors, quality, versions, snapshotId, dry }) {
  const todayKey = kstDate();
  const runId = `fc_${phase}_${todayKey}`;
  const kospi = etfSeries.KOSPI_PROXY ?? [];
  const lastDate = kospi.length ? kospi[kospi.length - 1].date : null;

  let startDate, endDate;
  if (phase === 'pre') {
    // 오늘 구간: 전일종가 → 오늘종가 (fetchEtfSeries가 당일 캔들을 이미 제거)
    startDate = lastDate;
    endDate = todayKey;
    // 데이터가 직전 거래일보다 오래됐으면(2거래일+ stale) 1일 분포를 다일 구간에 적용하게
    // 되므로 예측을 만들지 않는다 (검증 캐치업만 수행)
    const pv = prevTradingDate(cal, todayKey);
    if (pv && startDate && startDate < pv) {
      log(`⚠️ ETF 데이터 stale(${startDate} < 직전거래일 ${pv}) — 예측 생성 생략`);
      return [];
    }
  } else {
    // 익일 구간: 오늘종가 → 익일종가
    startDate = todayKey;
    endDate = nextTradingDate(cal, todayKey);
  }
  if (!startDate || !endDate || startDate >= endDate) {
    log(`⚠️ 구간 산정 불가 (start=${startDate}, end=${endDate}) — 예측 생략`);
    return [];
  }

  const rows = [];
  const opts = { callK: CALL_K, qualityGrade: quality.grade };
  for (const m of MARKETS) {
    const series = etfSeries[m.key] ?? [];
    const f = buildForecast(toReturns(series.map(x => x.close)), opts);
    if (!f) { log(`⚠️ ${m.key} 표본 부족 — 생략`); continue; }
    // 시작가는 정확히 startDate 종가일 때만 기록 (불변 원장에 근사값을 남기지 않는다)
    const startPrice = series.find(x => x.date === startDate)?.close ?? null;
    rows.push({ kind: 'market', sector: m.key, label: m.label, f, startPrice });
  }
  for (const s of topSectors) {
    const series = sectorSeries[s.sector] ?? [];
    const f = buildForecast(series.map(x => x.ret), opts);
    if (!f) { log(`⚠️ 섹터 ${s.sector} 표본 부족(${series.length}) — 생략`); continue; }
    rows.push({ kind: 'sector', sector: s.sector, label: s.sector, n: s.n, capTril: s.cap_tril, f, startPrice: null });
  }
  if (!rows.length) return [];

  await insertLedgerRows(rows, {
    runId, session: SESSION, layer: 'KRX', startDate, endDate, versions, snapshotId, quality, dry,
  });
  return rows.map(r => ({ ...r, runId, startDate, endDate }));
}

// 공용 원장 INSERT (일간·장중·NXT 공용, append-only)
async function insertLedgerRows(rows, { runId, session, layer, startDate, endDate, versions, snapshotId, quality, dry }) {
  if (!rows.length || dry) return;
  const cutoff = toUtcIso(new Date());
  const values = rows.map(r => `(
    ${esc(runId)}, ${num(snapshotId)}, ${esc(cutoff)}::timestamptz, ${esc(session)}, ${esc(layer)},
    ${esc(r.kind)}, ${esc(r.sector)}, ${esc(startDate)}, ${esc(endDate)},
    ${esc(r.startHm ?? null)}, ${esc(r.endHm ?? null)},
    ${esc(versions.universeVersion)}, ${esc(versions.sectorMappingVersion)}, ${num(r.startPrice)},
    ${num(r.f.median)}, ${num(r.f.low)}, ${num(r.f.high)},
    ${num(r.f.probs.up)}, ${num(r.f.probs.flat)}, ${num(r.f.probs.down)},
    ${num(r.f.confidence)}, ${num(r.f.band)}, ${num(r.f.sigma)}, ${esc(r.f.call)},
    ${num(r.f.median)}, ${num(r.f.low)}, ${num(r.f.high)},
    ${jsonb(r.f.baselines)}, ${jsonb(r.f.drivers)}, ${jsonb(r.f.invalidation)},
    ${esc(ENGINE_VERSION)}, ${esc(quality.grade)}, ${num(quality.delayMinutes)})`);
  await dbQuery(`
    INSERT INTO forecast_ledger
      (run_id, snapshot_id, data_cutoff_at, session, market_layer,
       target_kind, sector, target_start_date, target_end_date,
       target_start_hm, target_end_hm,
       universe_version, sector_mapping_version, start_price,
       forecast_median, forecast_low, forecast_high,
       probability_up, probability_flat, probability_down,
       confidence, flat_band, sigma, call_direction,
       stat_median, stat_low, stat_high,
       baselines, drivers, invalidation_conditions,
       engine_version, data_quality, data_delay_minutes)
    VALUES ${values.join(',')}
    ON CONFLICT (run_id, market_layer, sector) DO NOTHING`);
}

// ── 장중 예측 (1분봉) — "지금 → 다음 경계" 구간, ETF 프록시 2종 ──
const fmtHm = (hm) => `${hm.slice(0, 2)}:${hm.slice(2)}`;
function nextBoundary(nowHm, marginMin = 5) {
  const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(2));
  return INTRADAY_BOUNDARIES.find(b => toMin(b) > toMin(nowHm) + marginMin) ?? null;
}

async function makeIntradayForecasts({ etf1m, endHm, quality, versions, snapshotId, dry }) {
  const todayKey = kstDate();
  if (!endHm) return [];
  const runId = `fc_intra_${todayKey}_${endHm}`;
  const rows = [];
  for (const m of MARKETS) {
    const byDate = etf1m[m.key];
    const bars = byDate?.get(todayKey) ?? [];
    if (!bars.length) { log(`⚠️ ${m.key} 당일 1분봉 없음 — 생략`); continue; }
    const startHm = lastBarHm(bars); // 마지막 완성 분봉 = 데이터 기준 시각 (실행 시각 아님)
    if (startHm >= endHm) continue;
    const returns = historyIntervalReturns(byDate, startHm, endHm, { excludeDate: todayKey, todayKey });
    const f = buildForecast(returns, { callK: CALL_K, qualityGrade: quality.grade });
    if (!f) { log(`⚠️ ${m.key} ${fmtHm(startHm)}→${fmtHm(endHm)} 표본 부족(${returns.length}) — 생략`); continue; }
    rows.push({
      kind: 'market', sector: m.key, label: `${m.label} ${fmtHm(startHm)}→${fmtHm(endHm)}`,
      f, startPrice: priceAt(bars, startHm), startHm, endHm,
    });
  }
  await insertLedgerRows(rows, {
    runId, session: 'KRX_INTRADAY', layer: 'KRX',
    startDate: todayKey, endDate: todayKey, versions, snapshotId, quality, dry,
  });
  return rows.map(r => ({ ...r, runId, startDate: todayKey, endDate: todayKey }));
}

// ── NXT 애프터마켓 예측 (close 페이즈) — top5 시총가중 합성, 공식지수 아님 ──
async function makeNxtAfterForecast({ quality, versions, snapshotId, dry }) {
  const todayKey = kstDate();
  const nxt = await loadNxtBasket(NXT_1M_TOTAL);
  if (!nxt) return { rows: [], obs: null };
  const obs = basketLiveMove(nxt.byDateBySymbol, nxt.weights, NXT_AFTER.start, todayKey);
  const series = basketSessionSeries(nxt.byDateBySymbol, nxt.weights, NXT_AFTER.start, NXT_AFTER.end, { todayKey });
  const hist = series.filter(x => x.date < todayKey);
  const cov = hist.length ? hist[hist.length - 1].coverage : 0;
  if (cov < NXT_MIN_COVERAGE) {
    log(`NXT 유효 체결 커버리지 ${cov} < ${NXT_MIN_COVERAGE} — 유동성 부족으로 평가 보류`);
    return { rows: [], obs };
  }
  const f = buildForecast(hist.map(x => x.ret), { callK: CALL_K, qualityGrade: quality.grade });
  if (!f) { log(`⚠️ NXT 세션 표본 부족(${hist.length}) — 생략`); return { rows: [], obs }; }
  const runId = `fc_nxt_${todayKey}`;
  const rows = [{
    kind: 'nxt_after', sector: 'NXT_TOP5_합성',
    label: `NXT 애프터 합성시장(top${NXT_BASKET_SIZE} 시총가중) 15:30→20:00`,
    f, startPrice: null, startHm: NXT_AFTER.start, endHm: NXT_AFTER.end,
  }];
  await insertLedgerRows(rows, {
    runId, session: 'NXT_AFTER', layer: 'NXT',
    startDate: todayKey, endDate: todayKey, versions, snapshotId, quality, dry,
  });
  return { rows: rows.map(r => ({ ...r, runId, startDate: todayKey, endDate: todayKey })), obs };
}

// ── 품질 등급 ────────────────────────────────────────────────
function gradeQuality({ phase, etfSeries, sectorSeries, skipSector = false }) {
  const todayKey = kstDate();
  const kospi = etfSeries.KOSPI_PROXY ?? [];
  const lastEtf = kospi.length ? kospi[kospi.length - 1].date : null;
  const prevTd = kospi.length > 1
    ? (lastEtf === todayKey ? kospi[kospi.length - 2].date : lastEtf)
    : null;
  const expectedEtf = phase === 'close' ? todayKey : prevTd;
  const sectorDates = Object.values(sectorSeries).flatMap(s => (s.length ? [s[s.length - 1].date] : []));
  const lastSector = sectorDates.length ? sectorDates.sort().at(-1) : null;

  let miss = 0;
  const notes = [];
  if (!lastEtf) { miss += 2; notes.push('ETF 일봉 없음'); }
  else if (expectedEtf && lastEtf < expectedEtf) { miss += 1; notes.push(`ETF 일봉 stale(${lastEtf} < ${expectedEtf})`); }
  if (!skipSector) {
    if (!lastSector) { miss += 2; notes.push('섹터 시계열 없음'); }
    else if (prevTd && lastSector < prevTd) { miss += 1; notes.push(`섹터 stale(${lastSector} < ${prevTd})`); }
  }

  const grade = miss === 0 ? 'A' : miss === 1 ? 'B' : 'C';
  const delayMinutes = miss === 0 ? 0 : miss * 1440;
  return { grade, delayMinutes, notes, lastEtf, lastSector, prevTd };
}

// ── 사람이 읽는 보고 ─────────────────────────────────────────
const sgn = (x, d = 2) => `${x >= 0 ? '+' : ''}${Number(x).toFixed(d)}`;
const pct = (x) => (x == null ? '-' : `${(x * 100).toFixed(0)}%`);
const dateLabel = (k) => `${k.slice(4, 6)}/${k.slice(6, 8)}`;

const shortName = (key) => (key === 'KOSPI_PROXY' ? '코스피' : key === 'KOSDAQ_PROXY' ? '코스닥' : key);
// 항상 한쪽을 정해 말한다 (사용자 지시). 확신 수준만 정직하게 병기 — 얼버무림 금지.
function stanceOf(f) {
  const lean = f.probs.up === f.probs.down
    ? (f.median >= 0 ? 'up' : 'down')
    : (f.probs.up > f.probs.down ? 'up' : 'down');
  const gap = Math.abs(f.probs.up - f.probs.down);
  const strong = f.call !== 'no-call' || Math.abs(f.median) > f.band;
  const level = strong ? '높음' : gap >= 8 ? '보통' : '낮음';
  return { lean, level };
}
function dirWord(f) {
  const { lean, level } = stanceOf(f);
  return `${lean === 'up' ? '📈 오른다' : '📉 내린다'}고 봅니다 (확신 ${level})`;
}
function plainReason(f) {
  const { lean, level } = stanceOf(f);
  const drift = Math.abs(f.m20) < 0.05
    ? '최근 4주간 이 구간은 뚜렷한 방향이 없었지만'
    : `최근 4주간 이 구간에서 평균 ${sgn(f.m20)}%씩 ${f.m20 > 0 ? '오르던' : '빠지던'} 흐름이라`;
  const conv = level === '높음'
    ? `${lean === 'up' ? '상승' : '하락'}에 확신을 겁니다`
    : `${lean === 'up' ? '위쪽' : '아래쪽'}으로 봅니다. 다만 요즘 변동이 커서 확신은 ${level}으로 잡습니다`;
  return `${drift}, ${conv}.`;
}
function fmtSummary(s) {
  if (!s) return '아직 채점된 예측이 없습니다.';
  const parts = [`방향 맞음 ${pct(s.direction_hit_rate)}`];
  if (s.partial_count) parts.push(`방향만 맞음 ${s.partial_count}건`);
  parts.push(`예상범위 안 ${pct(s.coverage_80)} (목표 80%)`);
  if (s.call_count) parts.push(`확신 콜 ${s.call_count}건 중 ${Math.round((s.call_hit_rate ?? 0) * s.call_count)}건 적중`);
  return `${parts.join(' · ')} — 총 ${s.n}건`;
}
const hitMark = (v) => {
  if (v.direction_hit) return v.partial_hit ? '🔶 방향만 맞음' : '✅ 맞음';
  // 부호는 맞았지만 실제 움직임이 보합 밴드 안 → 채점상 틀림이되 오해 없게 별도 표기
  if (v.actual_class === 'flat' && Number(v.forecast_median) * Number(v.actual_return) > 0) {
    return '🔸 방향 부호는 맞음(실제는 보합 수준이라 미적중 처리)';
  }
  return '❌ 틀림';
};

// 지금 시장 상태 — 예측 이전에 현재/직전 등락부터 (사용자 피드백: 코스피·코스닥 얘기 먼저)
function marketNowContext({ etfSeries, etf1m, phase }) {
  const todayKey = kstDate();
  const out = [];
  for (const m of MARKETS) {
    const s = etfSeries[m.key] ?? [];
    if (s.length < 2) continue;
    const yRet = (s[s.length - 1].close / s[s.length - 2].close - 1) * 100;
    if (phase === 'close') {
      // 일봉에 오늘 포함 → 마지막 수익률이 오늘 확정 등락
      out.push({ key: m.key, today: yRet, todayDone: true, prev: (s[s.length - 2].close / (s[s.length - 3]?.close ?? s[s.length - 2].close) - 1) * 100 });
    } else if (phase === 'intraday' && etf1m) {
      const bars = etf1m[m.key]?.get(todayKey) ?? [];
      const now = bars.length ? bars[bars.length - 1].close : null;
      const yClose = s[s.length - 1].close; // includeToday=false라 마지막=어제 종가
      out.push({ key: m.key, today: now ? (now / yClose - 1) * 100 : null, todayDone: false, prev: yRet });
    } else {
      out.push({ key: m.key, today: null, todayDone: false, prev: yRet });
    }
  }
  return out;
}

function fmtRunReport({ made, verified, rolling, quality, dry, fx = null, disc = null, nxt = null, now = [], flow = null }) {
  const L = [];
  const markets = made.filter(x => x.kind === 'market');
  if (made.length) {
    const { endDate, startHm, endHm } = made[0];
    const span = startHm
      ? `오늘 ${fmtHm(startHm)} → ${fmtHm(endHm)}`
      : `내일(${dateLabel(endDate)}) 하루`;
    L.push(`📊 시장 전망 · ${span}${dry ? ' [테스트]' : ''}`);
    if (quality.grade !== 'A') L.push(`(참고: 일부 데이터가 늦게 도착해 신뢰도가 평소보다 낮습니다)`);
    if (now.length) {
      L.push('');
      L.push('【지금 시장】');
      for (const n of now) {
        const t = n.today == null ? null : `${n.todayDone ? '오늘' : '오늘 지금까지'} ${sgn(n.today)}%`;
        L.push(`${shortName(n.key)}: ${t ? `${t}, ` : ''}${n.todayDone ? '전날' : '어제'} ${sgn(n.prev)}%`);
      }
    }
    for (const r of markets) {
      const f = r.f;
      L.push('');
      L.push(`【${shortName(r.sector)}】 ${dirWord(f)}`);
      L.push(`예상 ${sgn(f.median)}% · 오름 ${f.probs.up}% / 보합 ${f.probs.flat}% / 내림 ${f.probs.down}% (합 100)`);
      L.push(`10번 중 8번은 ${sgn(f.low)}% ~ ${sgn(f.high)}% 사이에 들어옵니다`);
      L.push(`왜: ${plainReason(f)}`);
    }
    const sectors = made.filter(x => x.kind === 'sector').sort((a, b) => b.f.median - a.f.median);
    if (sectors.length) {
      L.push('');
      L.push('【섹터】 강해 보이는 순서');
      for (const r of sectors) {
        L.push(`  ${r.sector}: ${sgn(r.f.median)}% 예상 (오를 확률 ${r.f.probs.up}%)`);
      }
    }
  }
  if (nxt?.rows?.length || nxt?.obs) {
    L.push('');
    L.push('【시간외 거래(NXT)】 15:30~20:00 · 대형주 5종목 기준');
    if (nxt.obs) L.push(`지금까지 ${sgn(nxt.obs.ret)}% 움직임 (${nxt.obs.n}종목 체결 중)`);
    for (const r of nxt.rows ?? []) {
      L.push(`오늘 저녁 전망: ${sgn(r.f.median)}% 예상, 오를 확률 ${r.f.probs.up}% — ${plainReason(r.f)}`);
    }
  }
  if (nxt?.preObs) {
    L.push('');
    L.push(`【개장 전 시간외(NXT)】 어제 종가 대비 ${sgn(nxt.preObs.ret)}% (대형주 ${nxt.preObs.n}종목, 참고용)`);
  }
  if (fx || flow || (disc && !disc.is_stale && disc.sectors.length)) {
    L.push('');
    L.push('【참고】');
    if (flow) {
      const w = (v, who) => `${who} ${Math.abs(v).toLocaleString()}억 ${v >= 0 ? '순매수' : '순매도'}`;
      L.push(`수급(대형주 ${flow.n}종목 합산, ${dateLabel(flow.date)} 확정): ${w(flow.frgn_bil, '외국인')} · ${w(flow.orgn_bil, '기관')} · ${w(flow.prsn_bil, '개인')}`);
    }
    if (fx) L.push(`달러 환율(ETF 기준): 전날 ${sgn(fx.day_return_pct)}%, 최근 한 달 ${fx.m20_pct > 0 ? '상승' : '하락'} 기조`);
    if (disc && !disc.is_stale && disc.sectors.length) {
      L.push(`공시 많은 섹터: ${disc.sectors.slice(0, 3).map(s => `${s.sector} ${s.n}건`).join(', ')}`);
    }
  }
  L.push('');
  L.push('【직전 예측 채점】');
  if (verified.length) {
    for (const v of verified) {
      let name = shortName(v.sector);
      if (v.target_start_hm) name += ` ${fmtHm(v.target_start_hm)}~${fmtHm(v.target_end_hm)}`;
      L.push(`  ${name}: ${sgn(v.forecast_median)}% 예상 → 실제 ${sgn(v.actual_return)}% ${hitMark(v)}${v.in_range ? '' : ' (예상범위도 벗어남)'}`);
    }
    L.push(`  → ${fmtSummary(summarizeVerifications(verified))}`);
  } else {
    L.push('  이번에 채점할 예측이 없습니다 (다음 마감 때 채점)');
  }
  L.push('');
  L.push(`【지금까지 성적】 ${fmtSummary(rolling)}`);
  return L.join('\n');
}

// ── LLM 세부 분석 (Phase 1.5 — 채점 결론 시점에만, 실패해도 보고는 나간다) ──
function marketDayContext(etfSeries) {
  const ctx = {};
  for (const m of MARKETS) {
    const s = etfSeries[m.key] ?? [];
    if (s.length >= 2) {
      const a = s[s.length - 2], b = s[s.length - 1];
      ctx[m.key] = { date: b.date, day_return_pct: Math.round((b.close / a.close - 1) * 1e4) / 100 };
    }
  }
  return ctx;
}

async function runLlmVerificationAnalysis({ verified, etfSeries, quality, phase, dry, context = null }) {
  if (!verified.length || !llmEnabled()) return null;
  try {
    const payload = {
      run: { date: kstDate(), time: kstHM(), phase, data_quality: quality.grade, engine: ENGINE_VERSION },
      market_day: marketDayContext(etfSeries),
      context,
      verified: verified.map(v => ({
        id: v.id, name: v.sector === 'KOSPI_PROXY' ? '코스피' : v.sector === 'KOSDAQ_PROXY' ? '코스닥' : v.sector,
        forecast_median: v.forecast_median, range80: [v.forecast_low, v.forecast_high],
        prob_up: v.probability_up, prob_down: v.probability_down,
        sigma: v.sigma, flat_band: v.flat_band, call: v.call_direction,
        actual_return: v.actual_return, actual_class: v.actual_class,
        direction_hit: v.direction_hit, partial_hit: v.partial_hit,
        in_range: v.in_range, abs_error: v.abs_error, brier: v.brier,
        baseline_scores: v.baseline_scores,
      })),
    };
    const res = analyzeVerifications(payload);
    if (!res) { log('LLM 분석 파싱 실패 — 분석 없이 진행'); return null; }
    if (!dry && res.rows.length) {
      const updates = res.rows.filter(r => r.error_cause || r.cause_certainty);
      for (const r of updates) {
        await dbQuery(`
          UPDATE forecast_verification
          SET error_cause = ${esc(r.error_cause)}, cause_certainty = ${esc(r.cause_certainty)}
          WHERE ledger_id = ${num(r.id)}`);
      }
      if (updates.length) log(`오차 원인 분류 ${updates.length}건 기록`);
    }
    return res;
  } catch (e) {
    log(`LLM 분석 실패(비치명): ${e.message}`);
    return null;
  }
}

function fmtLlmSection(res, verified) {
  if (!res) return '';
  const L = ['', '【AI 세부 분석】'];
  L.push(res.narrative);
  const noteById = new Map(res.rows.map(r => [r.id, r]));
  const causes = verified
    .map(v => ({ v, r: noteById.get(v.id) }))
    .filter(x => x.r?.error_cause);
  if (causes.length) {
    L.push('오차 원인:');
    for (const { v, r } of causes) {
      const name = v.target_kind === 'market' ? (v.sector === 'KOSPI_PROXY' ? 'KOSPI' : 'KOSDAQ') : v.sector;
      L.push(`  ${name}: ${r.error_cause} [${r.cause_certainty}]${r.note ? ` — ${r.note}` : ''}`);
    }
  }
  return L.join('\n');
}

// ── 일일 결산 ────────────────────────────────────────────────
async function dailySummary({ dry }) {
  const todayKey = kstDate();
  const all = await fetchRecentVerificationRows();
  const today = all.filter(r => r.target_end_date === todayKey);

  const bySector = {};
  for (const r of all.filter(x => x.target_kind === 'sector')) (bySector[r.sector] ??= []).push(r);
  const sectorStats = Object.entries(bySector)
    .map(([sector, rs]) => ({ sector, ...summarizeVerifications(rs) }))
    .filter(s => s.n >= 3)
    .sort((a, b) => b.direction_hit_rate - a.direction_hit_rate);

  const summary = {
    date: todayKey,
    today: summarizeVerifications(today),
    rolling: summarizeVerifications(all),
    best_sectors: sectorStats.slice(0, 3).map(s => ({ sector: s.sector, hit: s.direction_hit_rate, n: s.n })),
    worst_sectors: sectorStats.slice(-3).reverse().map(s => ({ sector: s.sector, hit: s.direction_hit_rate, n: s.n })),
    engine_version: ENGINE_VERSION,
  };
  if (!dry) {
    await dbQuery(`
      INSERT INTO paper_state (k, data, updated_at)
      VALUES ('fc_daily_summary:${todayKey}', ${jsonb(summary)}, NOW())
      ON CONFLICT (k) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`);
  }
  return summary;
}

function fmtDailyReport(s) {
  const L = [`📊 오늘의 예측 성적표 (${dateLabel(s.date)})`];
  L.push('');
  L.push(`오늘: ${fmtSummary(s.today)}`);
  L.push(`최근 4주 누적: ${fmtSummary(s.rolling)}`);
  if (s.best_sectors.length) {
    L.push('');
    L.push(`잘 맞춘 섹터: ${s.best_sectors.map(x => `${x.sector}(${pct(x.hit)})`).join(', ')}`);
    L.push(`자주 틀린 섹터: ${s.worst_sectors.map(x => `${x.sector}(${pct(x.hit)})`).join(', ')}`);
  }
  if (s.rolling) L.push(`\n(통계 상세: 평균 빗나간 폭 ${s.rolling.mae}%p, 확률점수 Brier ${s.rolling.brier_mean})`);
  return L.join('\n');
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const force = args.includes('--force');
  const phaseArg = args.find(a => ['pre', 'close', 'daily'].includes(a));

  for (const k of ['SUPABASE_MANAGEMENT_KEY', 'SUPABASE_PROJECT_REF']) {
    if (!process.env[k]) { console.error(`환경변수 미설정: ${k}`); process.exit(1); }
  }
  if (!isTossConfigured()) { console.error('TOSS_CLIENT_ID/SECRET 미설정'); process.exit(1); }

  const hm = kstHM();
  let phase = phaseArg;
  if (!phase) {
    if (hm < '09:00') phase = 'pre';
    else if (hm >= '09:30' && hm < '15:35') phase = 'intraday';
    else if (hm >= '15:40' && hm < '19:30') phase = 'close';
    else if (hm >= '19:30') phase = 'daily';
    else { log(`${hm} — paper-swing 실주문 창(09:00~09:30) 또는 페이즈 경계, 종료`); return; }
  }
  // 09:00~09:30 = paper-swing morning 실주문 창 — 강제 실행이라도 이 창은 피한다
  if (!force && hm >= '09:00' && hm < '09:30' && phaseArg) {
    log(`⛔ ${hm}는 paper-swing 실주문 창 — 토스 토큰 경합 위험으로 거부 (--force로 무시 가능)`);
    return;
  }
  log(`phase=${phase}${phaseArg ? '(수동)' : ''}${dry ? ' [DRY]' : ''}`);

  await ensureTables();

  // 부팅 catch-up 동시발화 방어
  if (!force) {
    const busy = await paperSwingRecentlyActive();
    if (busy.length) {
      log(`paper-swing 최근 실행 감지(${busy.join(', ')}) — 토큰 경합 방지 위해 이번 실행 양보`);
      return;
    }
  }

  // 휴장 체크
  const cal = await loadCalendar();
  const todayCal = calFind(cal, kstDate());
  if (todayCal && !isTrading(todayCal) && !force) { log('휴장일 — 종료'); return; }

  if (!dry && !(await acquireRunLock(phase))) {
    log(`fc_${phase} run_lock 선점됨 — 중복 실행 종료`);
    return;
  }

  // 수집 — 당일 일봉은 장 마감 후에만 신뢰 (미완성 캔들 제거). 장중 예측은 1분봉 사용.
  const includeToday = hm >= '15:40';
  const dailyForecastPhase = phase === 'pre' || phase === 'close';
  const etfSeries = await fetchEtfSeries(includeToday);
  const tradingDates = (etfSeries.KOSPI_PROXY ?? []).map(x => x.date);
  const topSectors = dailyForecastPhase ? await fetchTopSectors() : [];
  const sectorSeries = dailyForecastPhase ? await fetchSectorSeries(topSectors.map(s => s.sector), tradingDates) : {};
  const quality = gradeQuality({ phase, etfSeries, sectorSeries, skipSector: !dailyForecastPhase });
  // 장중 페이즈: ETF 1분봉 (예측 분포 + 장중 행 검증 공용)
  let etf1m = null;
  if (phase === 'intraday') {
    etf1m = {};
    for (const m of MARKETS) etf1m[m.key] = await fetch1mByDate(m.code, ETF_1M_TOTAL);
  }
  log(`데이터 품질 ${quality.grade}${quality.notes.length ? ` (${quality.notes.join(', ')})` : ''}`
    + ` | ETF 최신 ${quality.lastEtf} | 섹터 최신 ${quality.lastSector ?? '-'}`);

  // 스냅샷 + 버전 (예측 페이즈에서만)
  const intraEndHm = phase === 'intraday' ? nextBoundary(hm.replace(':', '')) : null;
  let snapshotId = null;
  let versions = null;
  if (phase !== 'daily') {
    const { version: smv, universe } = await sectorMappingVersion();
    versions = { universeVersion: `sa-${universe}`, sectorMappingVersion: smv };
    if (!dry) {
      const runId = phase === 'intraday'
        ? `fc_intra_${kstDate()}_${intraEndHm ?? 'verify'}`
        : `fc_${phase}_${kstDate()}`;
      const payload = {
        etf_last: quality.lastEtf, sector_last: quality.lastSector, notes: quality.notes,
        top_sectors: topSectors, universe_size: universe,
        session_calendar_version: 'toss-market-calendar-v1',
        data_source_version: DATA_SOURCE_VERSION,
        sector_mapping_version: smv,
      };
      await dbQuery(`
        INSERT INTO market_snapshots (run_id, phase, data_cutoff_at, data_quality, data_delay_minutes, payload)
        VALUES (${esc(runId)}, ${esc(phase)}, NOW(), ${esc(quality.grade)},
                ${num(quality.delayMinutes)}, ${jsonb(payload)})
        ON CONFLICT (run_id) DO NOTHING`);
      const r = await dbQuery(`SELECT id FROM market_snapshots WHERE run_id = ${esc(runId)}`);
      snapshotId = r[0]?.id ?? null;
    }
  }

  // 1) 만기 예측 검증 (모든 페이즈에서 캐치업 — 일간·장중·NXT 공용)
  const { verified, pending } = await verifyDue({ etfSeries, etf1m, dry });
  if (pending) log(`검증 대기 ${pending}건 (데이터 미도착 — 다음 실행이 캐치업)`);

  // 2) 신규 예측 (pre/close/intraday) + LLM 세부 분석 + 보고
  if (phase === 'pre' || phase === 'close' || phase === 'intraday') {
    let made = [];
    let nxtInfo = null;
    if (phase === 'intraday') {
      made = await makeIntradayForecasts({ etf1m, endHm: intraEndHm, quality, versions, snapshotId, dry });
    } else {
      made = await makeForecasts({ phase, cal, etfSeries, sectorSeries, topSectors, quality, versions, snapshotId, dry });
      if (phase === 'close') {
        nxtInfo = await makeNxtAfterForecast({ quality, versions, snapshotId, dry });
      } else {
        // pre: NXT 프리마켓 관측 (전일 KRX 15:30 종가 대비, 진행 중 — 채점 대상 아님)
        const nxt = await loadNxtBasket(1600);
        if (nxt && quality.prevTd) {
          const preObs = basketLiveMove(nxt.byDateBySymbol, nxt.weights, '1530', kstDate(), { baseDate: quality.prevTd });
          if (preObs) nxtInfo = { preObs };
        }
      }
    }
    const fx = phase !== 'intraday' ? await fetchFxContext(includeToday) : null;
    // 당일·전일 공시를 DART에서 직접 수집한 뒤 컨텍스트 조회 (stale 보완)
    if (phase !== 'intraday') {
      try {
        const { collectRecentDisclosures } = await import('./forecast-disclosures.mjs');
        await collectRecentDisclosures({ dbQuery, todayKey: kstDate(), log });
      } catch (e) { log(`공시 수집 실패(비치명): ${e.message}`); }
    }
    const disc = phase !== 'intraday' ? await fetchDisclosureContext() : null;
    const flow = await fetchFlowContext();
    const rolling = summarizeVerifications(await fetchRecentVerificationRows());
    const llm = await runLlmVerificationAnalysis({
      verified, etfSeries, quality, phase, dry,
      context: { fx, investor_flow: flow, nxt_after_obs: nxtInfo?.obs ?? null, nxt_pre_obs: nxtInfo?.preObs ?? null, disclosures: disc },
    });
    const now = marketNowContext({ etfSeries, etf1m, phase });
    // 예측 시점 AI 브리핑 (뉴스 웹검색 + 공시 + 수급 종합) — 실패해도 보고는 나간다
    let outlook = null;
    if (llmEnabled() && (phase === 'pre' || phase === 'close')) {
      try {
        const recentDisc = await dbQuery(`
          SELECT sd.rcept_dt, sa.corp_name, sa.sector, sd.report_nm, sds.sentiment, sds.sentiment_score
          FROM stock_disclosures sd JOIN stock_analysis sa ON sa.stock_code = sd.stock_code
          LEFT JOIN stock_disclosure_sentiments sds ON sds.rcept_no = sd.rcept_no
          WHERE sd.rcept_dt >= TO_CHAR(CURRENT_DATE - 2, 'YYYY-MM-DD')
          ORDER BY
            CASE WHEN sd.report_nm ~ '(공급계약|수주|유상증자|무상|합병|분할|자기주식|전환사채|실적|잠정|소송|거래정지|감자|배당|임상|특허)' THEN 0 ELSE 1 END,
            sd.rcept_dt DESC, ABS(COALESCE(sds.sentiment_score, 0)) DESC
          LIMIT 12`);
        outlook = analyzeOutlook({
          date: kstDate(), phase, market_now: now, investor_flow: flow, fx,
          disclosures: { stale: disc?.is_stale ?? true, latest: disc?.latest ?? null, recent: recentDisc },
          engine_forecasts: made.map(r => ({ name: shortName(r.sector), median: r.f.median, up: r.f.probs.up, down: r.f.probs.down })),
        });
      } catch (e) { log(`브리핑 실패(비치명): ${e.message}`); }
    }
    let outlookText = '';
    if (outlook) {
      const S = [];
      if (outlook.news_sectors.length) S.push('오늘 뉴스로 본 주목 섹터:', ...outlook.news_sectors);
      if (outlook.flow_read.length) S.push('수급·흐름 해석:', ...outlook.flow_read);
      if (outlook.disclosure_watch.length) S.push('공시 체크:', ...outlook.disclosure_watch);
      if (outlook.risks.length) S.push('예측을 뒤집을 변수:', ...outlook.risks);
      outlookText = `\n\n【AI 브리핑 — 오늘 뭘 볼까】\n${S.join('\n')}`;
    }
    const report = fmtRunReport({ made, verified, rolling, quality, dry, fx, disc, nxt: nxtInfo, now, flow }) + outlookText + fmtLlmSection(llm, verified);
    console.log(report);
    if (!dry) await notifyTelegram(report);
  }

  // 3) 일일 결산 (daily) + LLM 해설
  if (phase === 'daily') {
    const s = await dailySummary({ dry });
    let report = fmtDailyReport(s);
    if (llmEnabled()) {
      try {
        const res = analyzeDaily({ date: kstDate(), summary: s });
        if (res) report += `\n\n■ LLM 해설\n${res.narrative}`;
      } catch (e) { log(`LLM 결산 해설 실패(비치명): ${e.message}`); }
    }
    console.log(report);
    if (!dry) await notifyTelegram(report);
  }

  log('완료');
}

main().catch(e => { console.error('[forecast] 치명 오류:', e); process.exit(1); });
