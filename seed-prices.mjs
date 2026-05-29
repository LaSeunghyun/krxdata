/**
 * seed-prices.mjs — 1회성 시드: 공공API로 받아둔 1년치 캐시(JSON)를
 *   Supabase stock_prices 테이블에 bulk upsert 한다.
 * 이후 일별시세는 daily-ranking 잡이 매일 적재 → 백테스트는 DB만 읽음.
 *
 * 실행: node seed-prices.mjs [캐시파일경로]
 *   인자 없으면 backtest-cache-*.json 중 가장 최근 파일 사용.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE 미설정"); process.exit(1); }

// 캐시 파일 선택
let cacheFile = process.argv[2];
if (!cacheFile) {
  const cands = fs.readdirSync(__dirname)
    .filter((f) => /^backtest-cache-.*\.json$/.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(__dirname, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (cands.length === 0) { console.error("캐시 파일 없음"); process.exit(1); }
  cacheFile = path.join(__dirname, cands[0].f);
}
console.log(`[시드] 캐시: ${path.basename(cacheFile)}`);

const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
const codes = Object.keys(cache);

// {stock_code, date, close} 평탄화
const rows = [];
for (const code of codes) {
  for (const r of cache[code]) {
    if (Number(r.close) > 0 && /^\d{8}$/.test(String(r.date))) {
      rows.push({ stock_code: code, date: String(r.date), close: Number(r.close) });
    }
  }
}
console.log(`[시드] ${codes.length}종목 · ${rows.length}행 upsert 예정`);

const BATCH = 5000;
let done = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/stock_prices`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(chunk),
  });
  if (!r.ok) {
    console.error(`배치 ${i} 실패 HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    process.exit(1);
  }
  done += chunk.length;
  if (i % (BATCH * 5) === 0 || done === rows.length) {
    process.stdout.write(`  ${done}/${rows.length} (${((done / rows.length) * 100).toFixed(0)}%)\n`);
  }
}
console.log(`[시드] 완료 — ${done}행 적재`);
