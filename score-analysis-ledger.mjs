/**
 * score-analysis-ledger.mjs - 추천 원장(analysis_ledger) 채점기 (2026-10-01).
 *
 * 원장에 기록된 분석 시점 기준가(ref_close)를 기준으로 5·20 "거래일" 뒤 수익률을 채운다.
 *   ret_5d / ret_20d : (N거래일 뒤 종가 / ref_close - 1) * 100
 *   hit_short        : ref 다음 거래일 ~ 20거래일 사이 종가가 단기 목표가에 닿았는가
 *                      (목표가 >= 기준가면 종가 >= 목표가, 아니면 종가 <= 목표가). 20거래일이 찰 때만 판정.
 *   scored_at        : 20거래일 채점까지 끝난 시각. 그 전에는 NULL(5일만 채워진 행은 다음 실행에서 이어서 채점).
 *
 * 거래일 판정: trading_calendar(is_open) 가 있으면 그것, 없으면 stock_prices 의 휴장 복사본 판정(closed CTE).
 * 종가 조회: stock_prices.trade_date 가 있으면 그것, 없으면 date(적재일) - 1일 = 거래일.
 * 추가 전용: analysis_ledger 의 채점 컬럼만 UPDATE 한다. 다른 테이블은 읽기만.
 *
 * 실행: node score-analysis-ledger.mjs [--dry]
 * 크론(VM): 매일 20:30 UTC (이 파일 하단 주석 참조)
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

export const HORIZONS = { short: 5, long: 20 };

/** openDays(오름차순 ISO 날짜) 에서 ref 이후 n번째 거래일. ref 자체가 거래일이어도 포함하지 않는다. 모자라면 null. */
export function nthTradingDay(openDays, ref, n) {
  let c = 0;
  for (const d of openDays) {
    if (d > ref && ++c === n) return d;
  }
  return null;
}

/**
 * 한 행의 채점 패치를 만든다. 순수 함수.
 * @param row        { ref_trade_date:'YYYY-MM-DD', ref_close, short_target, ret_5d, ret_20d }
 * @param openDays   오름차순 거래일 배열
 * @param closes     Map('YYYY-MM-DD' -> close)
 */
export function scoreRow(row, openDays, closes) {
  const ref = String(row.ref_trade_date).slice(0, 10);
  const base = Number(row.ref_close);
  const patch = {};
  if (!(base > 0)) return patch;
  const ret = (d) => (d && closes.has(d) ? +(((closes.get(d) / base) - 1) * 100).toFixed(2) : null);

  const d5 = nthTradingDay(openDays, ref, HORIZONS.short);
  const d20 = nthTradingDay(openDays, ref, HORIZONS.long);
  if (row.ret_5d == null) { const r = ret(d5); if (r != null) patch.ret_5d = r; }
  if (row.ret_20d == null) {
    const r = ret(d20);
    if (r != null) {
      patch.ret_20d = r;
      const tgt = Number(row.short_target);
      if (tgt > 0) {
        const win = openDays.filter((d) => d > ref && d <= d20 && closes.has(d)).map((d) => closes.get(d));
        patch.hit_short = tgt >= base ? win.some((c) => c >= tgt) : win.some((c) => c <= tgt);
      }
      patch.scored_at = "now";
    }
  }
  return patch;
}

// ── 이하 DB 실행부 ────────────────────────────────────────────────
async function main() {
  const MGMT_KEY = process.env.SUPABASE_MANAGEMENT_KEY;
  const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
  if (!MGMT_KEY || !PROJECT_REF) { console.error("SUPABASE_MANAGEMENT_KEY/PROJECT_REF 미설정"); process.exit(1); }
  const DRY = process.argv.includes("--dry");

  const q = async (sql) => {
    const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${MGMT_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(120_000),
    });
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error(data?.message ?? "DB 쿼리 오류");
    return data;
  };

  const rows = await q(`SELECT id, stock_code, ref_trade_date::text ref_trade_date, ref_close, short_target, ret_5d, ret_20d
    FROM analysis_ledger WHERE scored_at IS NULL AND ref_trade_date IS NOT NULL AND ref_close > 0 ORDER BY id`);
  console.log(`[ledger] 미채점 ${rows.length}행`);
  if (!rows.length) return;

  const feat = await q(`SELECT to_regclass('public.trading_calendar') IS NOT NULL cal,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock_prices' AND column_name='trade_date') tcol`);
  const hasCal = feat[0].cal, hasTcol = feat[0].tcol;
  console.log(`[ledger] 거래일 소스: ${hasCal ? "trading_calendar" : "closed CTE(복사본 판정)"} / 종가 키: ${hasTcol ? "trade_date" : "date-1"}`);

  const days = hasCal
    ? await q(`SELECT to_char(trade_date,'YYYY-MM-DD') d FROM trading_calendar WHERE is_open AND trade_date >= current_date-500 ORDER BY 1`)
    : await q(`WITH closed AS (
        SELECT a.date FROM stock_prices a JOIN stock_prices b
          ON b.stock_code=a.stock_code AND b.date=to_char(to_date(a.date,'YYYYMMDD')-1,'YYYYMMDD')
        WHERE a.date >= to_char(current_date-500,'YYYYMMDD')
        GROUP BY a.date HAVING avg((a.close=b.close)::int) > 0.9)
      SELECT DISTINCT to_char(to_date(date,'YYYYMMDD')-1,'YYYY-MM-DD') d FROM stock_prices
      WHERE date >= to_char(current_date-500,'YYYYMMDD') AND date NOT IN (SELECT date FROM closed) ORDER BY 1`);
  const openDays = days.map((r) => r.d);
  if (!openDays.length) throw new Error("거래일 목록이 비었다");
  console.log(`[ledger] 거래일 ${openDays.length}개 (${openDays[0]} ~ ${openDays.at(-1)})`);

  const codes = [...new Set(rows.map((r) => `'${String(r.stock_code).replace(/'/g, "''")}'`))].join(",");
  const minRef = rows.map((r) => r.ref_trade_date).sort()[0];
  const tdate = hasTcol ? "to_char(trade_date,'YYYY-MM-DD')" : "to_char(to_date(date,'YYYYMMDD')-1,'YYYY-MM-DD')";
  const where = hasTcol ? `trade_date IS NOT NULL AND trade_date > '${minRef}'` : `to_date(date,'YYYYMMDD')-1 > '${minRef}'::date`;
  const px = await q(`SELECT stock_code, ${tdate} d, close FROM stock_prices WHERE stock_code IN (${codes}) AND ${where}`);
  const byCode = new Map();
  for (const p of px) {
    if (!byCode.has(p.stock_code)) byCode.set(p.stock_code, new Map());
    byCode.get(p.stock_code).set(p.d, Number(p.close));
  }

  let upd = 0, full = 0;
  for (const r of rows) {
    const patch = scoreRow(r, openDays, byCode.get(r.stock_code) ?? new Map());
    const keys = Object.keys(patch);
    if (!keys.length) continue;
    const set = keys.map((k) => (k === "scored_at" ? "scored_at=now()" : `${k}=${patch[k]}`)).join(", ");
    if (patch.scored_at) full++;
    console.log(`  id=${r.id} ${r.stock_code} ${DRY ? "(dry) " : ""}${JSON.stringify(patch)}`);
    if (!DRY) await q(`UPDATE analysis_ledger SET ${set} WHERE id=${r.id}`);
    upd++;
  }
  console.log(`[ledger] 갱신 ${upd}행 (20거래일 채점 완료 ${full}행)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("[ledger] 오류:", e.message); process.exit(1); });
}

/* VM 크론 (UTC 20:30 = KST 05:30, save-prices 19:00 UTC 적재 후; 가벼운 쿼리 몇 개뿐이라 RAM 영향 없음):
   30 20 * * * cd ~/krxdata && bash -lc "node score-analysis-ledger.mjs" >> ledger-score.log 2>&1 */
