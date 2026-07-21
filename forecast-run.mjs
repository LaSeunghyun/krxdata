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
const DATA_SOURCE_VERSION = 'toss-candles+stock_prices-v1';
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
    SELECT 1;
  `);
}

// ── 데이터 수집 ──────────────────────────────────────────────
const candleDate = (c) => String(c.timestamp).slice(0, 10).replace(/-/g, '');

// ETF 일봉 → 오름차순 [{date, close}]. 장 마감 전에는 당일 미완성 캔들 제거.
async function fetchEtfSeries(includeToday) {
  const todayKey = kstDate();
  const out = {};
  for (const m of MARKETS) {
    try {
      const candles = (await getDailyCandles(m.code, 260)).reverse();
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
async function fetchSectorSeries(sectors) {
  if (!sectors.length) return {};
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
  const out = {};
  for (const r of rows) {
    (out[r.sector] ??= []).push({ date: r.date, ret: Number(r.ret), n: Number(r.n) });
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

async function verifyDue({ etfSeries, dry }) {
  const todayKey = kstDate();
  const due = await dbQuery(`
    SELECT fl.id, fl.run_id, fl.sector, fl.target_kind, fl.target_start_date, fl.target_end_date,
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
  const sectorSeries = await fetchSectorSeries(dueSectors);

  const verified = [];
  let pending = 0;
  const values = [];
  for (const row of due) {
    let actual = null;
    if (row.target_kind === 'market') {
      actual = etfReturnBetween(etfSeries[row.sector], row.target_start_date, row.target_end_date);
    } else {
      actual = sectorReturnBetween(sectorSeries[row.sector], row.target_start_date, row.target_end_date);
    }
    if (actual == null) { pending += 1; continue; } // 데이터 미도착 — 다음 실행이 캐치업
    const v = scoreVerification(row, actual);
    verified.push({
      ...v, sector: row.sector, target_kind: row.target_kind, run_id: row.run_id,
      target_end_date: row.target_end_date, forecast_median: Number(row.forecast_median),
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

  const cutoff = toUtcIso(new Date());
  const values = rows.map(r => `(
    ${esc(runId)}, ${num(snapshotId)}, ${esc(cutoff)}::timestamptz, ${esc(SESSION)}, 'KRX',
    ${esc(r.kind)}, ${esc(r.sector)}, ${esc(startDate)}, ${esc(endDate)},
    ${esc(versions.universeVersion)}, ${esc(versions.sectorMappingVersion)}, ${num(r.startPrice)},
    ${num(r.f.median)}, ${num(r.f.low)}, ${num(r.f.high)},
    ${num(r.f.probs.up)}, ${num(r.f.probs.flat)}, ${num(r.f.probs.down)},
    ${num(r.f.confidence)}, ${num(r.f.band)}, ${num(r.f.sigma)}, ${esc(r.f.call)},
    ${num(r.f.median)}, ${num(r.f.low)}, ${num(r.f.high)},
    ${jsonb(r.f.baselines)}, ${jsonb(r.f.drivers)}, ${jsonb(r.f.invalidation)},
    ${esc(ENGINE_VERSION)}, ${esc(quality.grade)}, ${num(quality.delayMinutes)})`);

  if (!dry) {
    await dbQuery(`
      INSERT INTO forecast_ledger
        (run_id, snapshot_id, data_cutoff_at, session, market_layer,
         target_kind, sector, target_start_date, target_end_date,
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
  return rows.map(r => ({ ...r, runId, startDate, endDate }));
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

function dirWord(f) {
  if (f.median > f.band) return '상승 우위';
  if (f.median < -f.band) return '하락 우위';
  if (f.probs.up > f.probs.down) return '보합권(상승 소폭 우위)';
  if (f.probs.down > f.probs.up) return '보합권(하락 소폭 우위)';
  return '보합권(중립)';
}
function reasonOf(f) {
  const trend = f.m20 > 0.05 ? '상승 흐름' : f.m20 < -0.05 ? '하락 흐름' : '뚜렷한 추세 없음';
  const conviction = f.call === 'no-call'
    ? '방향 확신 낮음(관망)'
    : `강추세 → ${f.call === 'up' ? '상승' : '하락'} 콜`;
  return `최근 20일 평균 ${sgn(f.m20)}%/일(${trend}), 일 변동성 σ${f.sigma.toFixed(2)}% → ${conviction}`;
}
function fmtSummary(s) {
  if (!s) return '표본 없음';
  const partial = s.partial_count ? ` (+부분적중 ${s.partial_count}건)` : '';
  return `방향적중 ${pct(s.direction_hit_rate)}${partial} · 80%범위 적중 ${pct(s.coverage_80)}`
    + ` · 평균오차 ${s.mae}%p · Brier ${s.brier_mean}`
    + ` · 방향콜 ${s.call_count}건(적중 ${pct(s.call_hit_rate)}) · 기준모형 우위 ${pct(s.beat_all_baselines_rate)} (n=${s.n})`;
}

function fmtRunReport({ made, verified, rolling, quality, dry }) {
  const L = [];
  if (made.length) {
    const { startDate, endDate } = made[0];
    L.push(`📈 ${dateLabel(startDate)} 종가 → ${dateLabel(endDate)} 종가 예측 (데이터품질 ${quality.grade}${dry ? ' · DRY' : ''})`);
    L.push('');
    L.push('■ 시장 전망');
    for (const r of made.filter(x => x.kind === 'market')) {
      const f = r.f;
      L.push(`${r.label}: ${dirWord(f)} — 중앙 ${sgn(f.median)}%`);
      L.push(`  확률 상승${f.probs.up}/보합${f.probs.flat}/하락${f.probs.down}% · 80%범위 ${sgn(f.low)}~${sgn(f.high)}%`);
      L.push(`  이유: ${reasonOf(f)}`);
    }
    const sectors = made.filter(x => x.kind === 'sector')
      .sort((a, b) => b.f.median - a.f.median);
    if (sectors.length) {
      L.push('');
      L.push('■ 섹터 전망 (예측 중앙값 순)');
      for (const r of sectors) {
        const f = r.f;
        L.push(`${sgn(f.median)}% ${r.sector} — 상승확률 ${f.probs.up}%, 20일 ${sgn(f.m20)}%/일, σ${f.sigma.toFixed(1)}%`);
      }
    }
  }
  L.push('');
  L.push('■ 직전 예측 채점');
  if (verified.length) {
    const s = summarizeVerifications(verified);
    L.push(fmtSummary(s));
    for (const v of verified) {
      const name = v.target_kind === 'market' ? (v.sector === 'KOSPI_PROXY' ? 'KOSPI' : 'KOSDAQ') : v.sector;
      L.push(`  ${name}: 예측 ${sgn(v.forecast_median)}% → 실제 ${sgn(v.actual_return)}%`
        + ` ${v.direction_hit ? (v.partial_hit ? '△부분적중' : '○적중') : '✗빗나감'} · 범위${v.in_range ? '내' : '밖'}`);
    }
  } else {
    L.push('채점 만기가 도래한 예측 없음');
  }
  L.push('');
  L.push(`■ 누적 정확도 (최근 20거래일 롤링)`);
  L.push(fmtSummary(rolling));
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
  const L = [`📊 예측 일일결산 ${dateLabel(s.date)}`];
  L.push(`오늘 채점: ${fmtSummary(s.today)}`);
  L.push(`누적(20거래일 롤링): ${fmtSummary(s.rolling)}`);
  if (s.best_sectors.length) {
    L.push(`잘 맞춘 섹터: ${s.best_sectors.map(x => `${x.sector} ${pct(x.hit)}(n${x.n})`).join(' · ')}`);
  }
  if (s.worst_sectors.length) {
    L.push(`반복 오답 섹터: ${s.worst_sectors.map(x => `${x.sector} ${pct(x.hit)}(n${x.n})`).join(' · ')}`);
  }
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
    else if (hm >= '15:40' && hm < '19:30') phase = 'close';
    else if (hm >= '19:30') phase = 'daily';
    else { log(`장중(${hm}) — 실행 페이즈 아님, 종료 (paper-swing 토큰 경합 방지)`); return; }
  }
  // 09:00~11:30 = paper-swing morning 실주문 창 — 강제 실행이라도 이 창은 피한다
  if (!force && hm >= '09:00' && hm < '11:30' && phaseArg) {
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

  // 수집 — 당일 캔들은 장 마감 후에만 신뢰 (pre에서는 미완성 캔들 제거)
  const includeToday = hm >= '15:40';
  const etfSeries = await fetchEtfSeries(includeToday);
  const topSectors = phase === 'daily' ? [] : await fetchTopSectors();
  const sectorSeries = phase === 'daily' ? {} : await fetchSectorSeries(topSectors.map(s => s.sector));
  const quality = gradeQuality({ phase, etfSeries, sectorSeries, skipSector: phase === 'daily' });
  log(`데이터 품질 ${quality.grade}${quality.notes.length ? ` (${quality.notes.join(', ')})` : ''}`
    + ` | ETF 최신 ${quality.lastEtf} | 섹터 최신 ${quality.lastSector ?? '-'}`);

  // 스냅샷 + 버전 (예측 페이즈에서만)
  let snapshotId = null;
  let versions = null;
  if (phase !== 'daily') {
    const { version: smv, universe } = await sectorMappingVersion();
    versions = { universeVersion: `sa-${universe}`, sectorMappingVersion: smv };
    if (!dry) {
      const runId = `fc_${phase}_${kstDate()}`;
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

  // 1) 만기 예측 검증 (모든 페이즈에서 캐치업)
  const { verified, pending } = await verifyDue({ etfSeries, dry });
  if (pending) log(`검증 대기 ${pending}건 (데이터 미도착 — 다음 실행이 캐치업)`);

  // 2) 신규 예측 (pre/close) + 보고
  if (phase === 'pre' || phase === 'close') {
    const made = await makeForecasts({ phase, cal, etfSeries, sectorSeries, topSectors, quality, versions, snapshotId, dry });
    const rolling = summarizeVerifications(await fetchRecentVerificationRows());
    const report = fmtRunReport({ made, verified, rolling, quality, dry });
    console.log(report);
    if (!dry) await notifyTelegram(report);
  }

  // 3) 일일 결산 (daily)
  if (phase === 'daily') {
    const s = await dailySummary({ dry });
    const report = fmtDailyReport(s);
    console.log(report);
    if (!dry) await notifyTelegram(report);
  }

  log('완료');
}

main().catch(e => { console.error('[forecast] 치명 오류:', e); process.exit(1); });
