/**
 * save-prices.mjs — 매일 stock_analysis의 최신 종가를 stock_prices에 적재.
 *   daily-ranking 잡(가격 갱신 후)에서 호출 → 일별 시계열 누적.
 *   백테스트(backtest-pit.mjs)는 이 테이블만 읽음 (공공API 미사용).
 *
 *   v2: REST(SUPABASE_KEY) → Management API(SUPABASE_MANAGEMENT_KEY)로 전환.
 *       (legacy anon/service 키 401 폐기 — 2026-05-29~ 적재 중단 사고 원인)
 *   --backfill N: 토스 일봉으로 최근 N일 누락 영업일 보충 (기존 값 보존, ON CONFLICT DO NOTHING)
 *
 * 멱등: (stock_code, date) PK라 같은 날 재실행해도 안전.
 * env: SUPABASE_MANAGEMENT_KEY, SUPABASE_PROJECT_REF (+백필 시 TOSS_CLIENT_ID/SECRET)
 * 실행: node save-prices.mjs [--backfill 15]
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const MGMT_KEY = process.env.SUPABASE_MANAGEMENT_KEY;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
if (!MGMT_KEY || !PROJECT_REF) { console.error("SUPABASE_MANAGEMENT_KEY/PROJECT_REF 미설정"); process.exit(1); }

const argv = process.argv.slice(2);
const backfillIdx = argv.indexOf("--backfill");
const BACKFILL_DAYS = backfillIdx >= 0 ? Number(argv[backfillIdx + 1] ?? 15) : 0;

async function dbQuery(sql) {
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

// (stock_code, date, close) 묶음 INSERT — 기존 행 보존
async function insertRows(rows) {
  const CHUNK = 1_000;
  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const vals = rows.slice(i, i + CHUNK)
      .filter(r => /^[A-Za-z0-9]{5,6}$/.test(r.code) && /^\d{8}$/.test(r.date) && Number.isFinite(r.close) && r.close > 0)
      .map(r => `('${r.code}','${r.date}',${r.close})`).join(",");
    if (!vals) continue;
    await dbQuery(`INSERT INTO stock_prices (stock_code, date, close) VALUES ${vals} ON CONFLICT (stock_code, date) DO NOTHING`);
    done += Math.min(CHUNK, rows.length - i);
  }
  return done;
}

// KST 오늘 (YYYYMMDD)
const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
const DATE = `${kstNow.getUTCFullYear()}${String(kstNow.getUTCMonth() + 1).padStart(2, "0")}${String(kstNow.getUTCDate()).padStart(2, "0")}`;
console.log(`[save-prices] 날짜 ${DATE} 적재 시작`);

const all = await dbQuery(`SELECT stock_code, current_price FROM stock_analysis WHERE current_price > 0`);
console.log(`[save-prices] 종가 보유 ${all.length}종목`);

const today = await insertRows(all.map(s => ({ code: s.stock_code, date: DATE, close: Number(s.current_price) })));
console.log(`[save-prices] 완료 — ${DATE} ${today}행 적재`);

// ── 백필: 토스 일봉으로 누락 영업일 보충 ──────────────────────
if (BACKFILL_DAYS > 0) {
  const { isTossConfigured, getDailyCandles } = await import("./toss-api.js");
  if (!isTossConfigured()) { console.error("[백필] TOSS_CLIENT_ID/SECRET 미설정 — 생략"); process.exit(0); }

  const [{ max_date }] = await dbQuery(`SELECT MAX(date) AS max_date FROM stock_prices WHERE date < '${DATE}'`);
  console.log(`[백필] 직전 적재일 ${max_date} → 최근 ${BACKFILL_DAYS}일 일봉으로 누락 보충 시작`);

  const codes = all.map(s => s.stock_code);
  const rows = [];
  let done = 0;
  for (const code of codes) {
    try {
      const bars = await getDailyCandles(code, BACKFILL_DAYS);
      for (const b of bars) {
        const d = String(b.timestamp).slice(0, 10).replace(/-/g, "");
        if (d < DATE) rows.push({ code, date: d, close: b.close }); // 오늘은 위에서 적재됨
      }
    } catch { /* 미커버 종목 스킵 */ }
    done++;
    if (done % 300 === 0) console.log(`[백필] 일봉 수집 ${done}/${codes.length}`);
  }
  const inserted = await insertRows(rows);
  const after = await dbQuery(`SELECT date, COUNT(*) cnt FROM stock_prices WHERE date >= '${max_date}' GROUP BY date ORDER BY date`);
  console.log(`[백필] 완료 — 후보 ${rows.length}행 중 신규 적재 (중복 제외), 날짜별 현황:`);
  for (const r of after) console.log(`  ${r.date}: ${r.cnt}행`);
}
