/**
 * save-prices.mjs — 매일 stock_analysis의 최신 종가를 stock_prices에 적재.
 *   daily-ranking 잡(가격 갱신 후)에서 호출 → 일별 시계열 누적.
 *   백테스트(backtest-pit.mjs)는 이 테이블만 읽음 (공공API 미사용).
 *
 * 멱등: (stock_code, date) PK + merge-duplicates 라 같은 날 재실행해도 안전.
 * 날짜 스탬프: KST 기준 실행일(YYYYMMDD).
 *
 * env: SUPABASE_URL, SUPABASE_KEY (또는 SUPABASE_SERVICE_KEY)
 * 실행: node save-prices.mjs
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE 미설정"); process.exit(1); }

const H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

// KST 오늘 (YYYYMMDD)
const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
const DATE = `${kstNow.getUTCFullYear()}${String(kstNow.getUTCMonth() + 1).padStart(2, "0")}${String(kstNow.getUTCDate()).padStart(2, "0")}`;
console.log(`[save-prices] 날짜 ${DATE} 적재 시작`);

// 전체 유니버스 종가
const all = [];
const PAGE = 1000;
for (let off = 0; ; off += PAGE) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/stock_analysis?select=stock_code,current_price&current_price=gt.0&order=stock_code&limit=${PAGE}&offset=${off}`,
    { headers: H },
  );
  if (!r.ok) { console.error(`stock_analysis HTTP ${r.status}`); process.exit(1); }
  const rows = await r.json();
  all.push(...rows);
  if (rows.length < PAGE) break;
}
console.log(`[save-prices] 종가 보유 ${all.length}종목`);

const payload = all.map((s) => ({ stock_code: s.stock_code, date: DATE, close: Number(s.current_price) }));

const BATCH = 5000;
let done = 0;
for (let i = 0; i < payload.length; i += BATCH) {
  const chunk = payload.slice(i, i + BATCH);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/stock_prices`, {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(chunk),
  });
  if (!r.ok) { console.error(`upsert 실패 HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`); process.exit(1); }
  done += chunk.length;
}
console.log(`[save-prices] 완료 — ${DATE} ${done}행 적재`);
