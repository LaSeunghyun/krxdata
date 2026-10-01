/**
 * save-prices.mjs — 매일 stock_analysis의 최신 종가를 stock_prices에 적재.
 *   daily-ranking 잡(가격 갱신 후)에서 호출 → 일별 시계열 누적.
 *   백테스트(backtest-pit.mjs)는 이 테이블만 읽음 (공공API 미사용).
 *
 *   v2: REST(SUPABASE_KEY) → Management API(SUPABASE_MANAGEMENT_KEY)로 전환.
 *       (legacy anon/service 키 401 폐기 — 2026-05-29~ 적재 중단 사고 원인)
 *   --backfill N: 토스 일봉으로 최근 N일 누락 영업일 보충 (기존 값 보존, ON CONFLICT DO NOTHING)
 *                 + 같은 일봉으로 (stock_code, trade_date) 행의 open/high/low/volume/turnover 를 채움 (NULL 칸만, close 불변)
 *
 *   v3 (2026-10-01): trade_date·OHLCV·trading_calendar
 *     - date 는 종전대로 "적재일"(KST 오늘). 실제 종가 거래일은 trade_date 컬럼에 따로 기록한다.
 *     - trade_date = trading_calendar 상 적재일 직전 개장일. 직전 행과 90% 초과 동일(휴장 다음날·정체)이면 NULL.
 *     - trading_calendar 는 매 실행 때 어제까지 누락분을 추가한다. 실행 위치별 동작:
 *         VM 크론(04:00 KST, 토스 IP 화이트리스트): 토스 기준 종목 일봉 -> toss_candle/toss_no_candle, OHLCV 채움까지 수행.
 *         GitHub Actions(토스 403): 일봉에 못 닿으므로 stock_prices 복사본 판정(sp_copy/sp_fresh)+평일 규칙(weekday_rule)으로 캘린더만 유지,
 *           OHLCV 는 채우지 못한다(다음 VM 실행이 NULL 칸을 채움). 대체 근거 행은 VM 실행 때 토스 근거로 덮어쓴다.
 *     - stock_prices 에 trade_date/OHLCV 컬럼이 없으면 구 3컬럼 INSERT 로 폴백한다.
 *     - OHLCV 출처 = 토스 일봉(KRX 정규장 + NXT 통합, 수정주가). KRX 단독 값과 다를 수 있다.
 *
 * 멱등: (stock_code, date) PK라 같은 날 재실행해도 안전.
 * env: SUPABASE_MANAGEMENT_KEY, SUPABASE_PROJECT_REF (+백필 시 TOSS_CLIENT_ID/SECRET)
 * 실행: node save-prices.mjs [--backfill 15] [--dry-run]
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REF_STOCKS, calendarFromCandles, fallbackCalendarRows, buildCalendarUpsertSql, decideTradeDate, ohlcvRows, buildOhlcvUpdateSql, toIso, toYmd, addDays,
} from "./trade-date.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const MGMT_KEY = process.env.SUPABASE_MANAGEMENT_KEY;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
if (!MGMT_KEY || !PROJECT_REF) { console.error("SUPABASE_MANAGEMENT_KEY/PROJECT_REF 미설정"); process.exit(1); }

const argv = process.argv.slice(2);
const backfillIdx = argv.indexOf("--backfill");
const BACKFILL_DAYS = backfillIdx >= 0 ? Number(argv[backfillIdx + 1] ?? 15) : 0;

const DRY = argv.includes("--dry-run"); // 쓰기(INSERT/UPDATE) 쿼리는 실행하지 않고 건수만 출력
let dryWrites = 0;

async function dbQuery(sql) {
  if (DRY && /^\s*(INSERT|UPDATE|WITH u AS)/i.test(sql)) { dryWrites++; return [{ n: 0 }]; }
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MGMT_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(data?.message ?? "DB 쿼리 오류");
  return data;
}

// (stock_code, date, close[, trade_date]) 묶음 INSERT - 기존 행 보존
let HAS_TD = true; // trade_date 컬럼 존재 여부 (없으면 구 3컬럼 INSERT 로 폴백 - 컬럼 없는 환경에서도 적재가 멈추지 않게)
async function insertRows(rows) {
  const CHUNK = 1_000;
  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const vals = rows.slice(i, i + CHUNK)
      .filter(r => /^[A-Za-z0-9]{5,6}$/.test(r.code) && /^\d{8}$/.test(r.date) && Number.isFinite(r.close) && r.close > 0)
      .map(r => HAS_TD
        ? `('${r.code}','${r.date}',${r.close},${r.trade && /^\d{8}$/.test(r.trade) ? `'${toIso(r.trade)}'` : "NULL"})`
        : `('${r.code}','${r.date}',${r.close})`).join(",");
    if (!vals) continue;
    await dbQuery(HAS_TD
      ? `INSERT INTO stock_prices (stock_code, date, close, trade_date) VALUES ${vals} ON CONFLICT (stock_code, date) DO NOTHING`
      : `INSERT INTO stock_prices (stock_code, date, close) VALUES ${vals} ON CONFLICT (stock_code, date) DO NOTHING`);
    done += Math.min(CHUNK, rows.length - i);
  }
  return done;
}

// 백필 행(date == 일봉 거래일): 같은 종목에 그 거래일이 이미 배정된 행이 있으면 건너뛴다 (거래일 중복 방지)
async function insertBackfillRows(rows) {
  if (!HAS_TD) return insertRows(rows);
  const CHUNK = 1_000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const vals = rows.slice(i, i + CHUNK)
      .filter(r => /^[A-Za-z0-9]{5,6}$/.test(r.code) && /^\d{8}$/.test(r.date) && Number.isFinite(r.close) && r.close > 0)
      .map(r => `('${r.code}','${r.date}',${r.close},'${toIso(r.date)}'::date)`).join(",");
    if (!vals) continue;
    await dbQuery(`INSERT INTO stock_prices (stock_code, date, close, trade_date)
      SELECT v.c, v.d, v.p, v.t FROM (VALUES ${vals}) AS v(c,d,p,t)
      WHERE NOT EXISTS (SELECT 1 FROM stock_prices x WHERE x.stock_code = v.c AND x.trade_date = v.t)
      ON CONFLICT (stock_code, date) DO NOTHING`);
  }
}

// trading_calendar 를 어제까지 채운다.
//   1순위: 토스 기준 종목 일봉 (VM 크론 경로 - 토스 IP 화이트리스트)
//   2순위: 토스에 닿지 못할 때(GitHub Actions 는 403) stock_prices 복사본 판정 + 평일 규칙 (fallbackCalendarRows)
//   대체 근거(sp_copy/sp_fresh/weekday_rule)는 이후 토스 근거가 오면 덮어쓴다. 실패해도 적재는 계속한다.
async function updateCalendar(yesterday, sameShare) {
  const [{ mx }] = await dbQuery(`SELECT to_char(max(trade_date),'YYYYMMDD') AS mx FROM trading_calendar`);
  const from = mx ? addDays(mx, 1) : addDays(yesterday, -30);
  // 토스 근거로 약한 근거 행을 되돌려 확정하기 위해, 최근 14일 안의 대체 근거 행이 있으면 그 시작일부터 다시 본다
  const [{ weak }] = await dbQuery(`SELECT to_char(min(trade_date),'YYYYMMDD') AS weak FROM trading_calendar WHERE source IN ('sp_copy','sp_fresh','weekday_rule') AND trade_date >= current_date - 14`);
  const reFrom = weak && weak < from ? weak : from;
  if (reFrom > yesterday) return 0;
  let rows = [];
  try {
    const { isTossConfigured, getDailyCandles } = await import("./toss-api.js");
    if (isTossConfigured()) {
      const need = Math.min(250, Math.round((Date.parse(toIso(yesterday)) - Date.parse(toIso(reFrom))) / 86400000) + 8);
      const lists = [];
      for (const code of REF_STOCKS.slice(0, 3)) {
        try { lists.push((await getDailyCandles(code, need)).map(b => ({ date: toYmd(b.timestamp), volume: b.volume }))); }
        catch (e) { console.error(`[캘린더] ${code} 일봉 실패: ${String(e.message).slice(0, 60)}`); }
      }
      // 일봉이 멈춰 있으면(최신 봉이 10일 넘게 과거) 판정 근거로 쓰지 않는다
      const latest = lists.flatMap(l => l.map(b => b.date)).sort().pop();
      if (lists.length && latest && latest >= addDays(yesterday, -10)) rows = calendarFromCandles(lists, reFrom, yesterday);
    }
  } catch (e) { console.error(`[캘린더] 토스 경로 실패: ${String(e.message).slice(0, 60)}`); }
  // 토스 근거가 없는 날(미커버·미도달)은 대체 근거로 채운다. 이미 토스 근거가 있는 날은 건드리지 않는다.
  const have = new Set(rows.map(r => r.trade_date));
  const fb = fallbackCalendarRows(from, yesterday, yesterday, sameShare).filter(r => !have.has(r.trade_date));
  rows = rows.concat(fb);
  const sql = buildCalendarUpsertSql(rows);
  if (!sql) return 0;
  await dbQuery(sql);
  return rows.length;
}

// KST 오늘 (YYYYMMDD)
const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
const DATE = `${kstNow.getUTCFullYear()}${String(kstNow.getUTCMonth() + 1).padStart(2, "0")}${String(kstNow.getUTCDate()).padStart(2, "0")}`;
console.log(`[save-prices] 날짜 ${DATE} 적재 시작`);

const all = await dbQuery(`SELECT stock_code, current_price FROM stock_analysis WHERE current_price > 0`);
console.log(`[save-prices] 종가 보유 ${all.length}종목`);

// 캘린더 갱신 -> 거래일 판정 (실패해도 trade_date 만 NULL 로 두고 date/close 적재는 계속)
let tradeDate = null;
try {
  const cols = await dbQuery(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='stock_prices' AND column_name IN ('trade_date','open','high','low','volume','turnover')`);
  HAS_TD = (cols[0]?.n ?? 0) === 6;
  if (!HAS_TD) console.error("[save-prices] stock_prices 에 trade_date/OHLCV 컬럼 없음 - 구 3컬럼 INSERT 로 폴백");
} catch { HAS_TD = false; }
if (HAS_TD) try {
  const yesterday = addDays(DATE, -1);
  const prev = await dbQuery(`SELECT stock_code, close FROM stock_prices WHERE date = (SELECT max(date) FROM stock_prices WHERE date < '${DATE}')`);
  const prevMap = new Map(prev.map(r => [r.stock_code, Number(r.close)]));
  let same = 0, cmp = 0;
  for (const s of all) { if (prevMap.has(s.stock_code)) { cmp++; if (prevMap.get(s.stock_code) === Number(s.current_price)) same++; } }
  const sameShare = cmp ? same / cmp : NaN;
  const added = await updateCalendar(yesterday, sameShare);
  const cal = new Map((await dbQuery(`SELECT to_char(trade_date,'YYYYMMDD') d, is_open FROM trading_calendar WHERE trade_date >= current_date - 60`)).map(r => [r.d, r.is_open]));
  const claimed = new Set((await dbQuery(`SELECT DISTINCT to_char(trade_date,'YYYYMMDD') d FROM stock_prices WHERE trade_date >= current_date - 30 AND date <> '${DATE}'`)).map(r => r.d));
  tradeDate = decideTradeDate({ loadYmd: DATE, calendar: cal, claimed, sameShare });
  console.log(`[save-prices] 캘린더 +${added}행 / 직전 행 동일 비율 ${Number.isFinite(sameShare) ? (sameShare * 100).toFixed(1) : "n/a"}% -> trade_date ${tradeDate ? toIso(tradeDate) : "NULL(복사본·중복)"}`);
} catch (e) {
  console.error(`[save-prices] trade_date 판정 실패 - NULL 로 적재: ${String(e.message).slice(0, 100)}`);
}

const today = await insertRows(all.map(s => ({ code: s.stock_code, date: DATE, close: Number(s.current_price), trade: tradeDate })));
console.log(`[save-prices] 완료 - ${DATE} ${today}행 적재`);

// ── 백필: 토스 일봉으로 누락 영업일 보충 ──────────────────────
if (BACKFILL_DAYS > 0) {
  const { isTossConfigured, getDailyCandles } = await import("./toss-api.js");
  if (!isTossConfigured()) { console.error("[백필] TOSS_CLIENT_ID/SECRET 미설정 — 생략"); process.exit(0); }

  const [{ max_date }] = await dbQuery(`SELECT MAX(date) AS max_date FROM stock_prices WHERE date < '${DATE}'`);
  console.log(`[백필] 직전 적재일 ${max_date} → 최근 ${BACKFILL_DAYS}일 일봉으로 누락 보충 시작`);

  const codes = all.map(s => s.stock_code);
  const rows = [];
  const ohlcv = [];
  let done = 0;
  for (const code of codes) {
    try {
      const bars = await getDailyCandles(code, BACKFILL_DAYS);
      for (const b of bars) {
        const d = String(b.timestamp).slice(0, 10).replace(/-/g, "");
        if (d < DATE) rows.push({ code, date: d, close: b.close }); // 오늘은 위에서 적재됨
      }
      if (HAS_TD) ohlcv.push(...ohlcvRows(code, bars, DATE)); // 오늘(미완성) 봉 제외
    } catch { /* 미커버 종목 스킵 */ }
    done++;
    if (done % 300 === 0) console.log(`[백필] 일봉 수집 ${done}/${codes.length}`);
  }
  await insertBackfillRows(rows);
  // OHLCV 채움: (stock_code, trade_date) 일치 행의 NULL 칸만, 일봉 종가가 DB 종가 1% 이내일 때만 (close 불변)
  let filled = 0;
  for (let i = 0; i < ohlcv.length; i += 2000) {
    const sql = buildOhlcvUpdateSql(ohlcv.slice(i, i + 2000));
    if (sql) filled += (await dbQuery(sql))[0]?.n ?? 0;
  }
  console.log(`[백필] OHLCV 후보 ${ohlcv.length}행 중 ${filled}행 채움`);
  const after = await dbQuery(`SELECT date, COUNT(*) cnt FROM stock_prices WHERE date >= '${max_date}' GROUP BY date ORDER BY date`);
  console.log(`[백필] 완료 — 후보 ${rows.length}행 중 신규 적재 (중복 제외), 날짜별 현황:`);
  for (const r of after) console.log(`  ${r.date}: ${r.cnt}행`);
}

if (DRY) console.log(`[save-prices] dry-run - 쓰기 쿼리 ${dryWrites}건 미실행`);
