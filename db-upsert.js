/**
 * db-upsert.js
 * scored-stocks.json / scored-kosdaq.json → Supabase stock_analysis 테이블 upsert
 *
 * 실행: node db-upsert.js [--kosdaq] [--kospi] [--both]
 * 환경변수: SUPABASE_URL, SUPABASE_SERVICE_KEY (.env)
 */

import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TABLE = "stock_analysis";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL 또는 SUPABASE_SERVICE_KEY 미설정");
  process.exit(1);
}

const args = process.argv.slice(2);
const doKospi  = args.includes("--kospi")  || args.includes("--both") || args.length === 0;
const doKosdaq = args.includes("--kosdaq") || args.includes("--both") || args.length === 0;

const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
const RUN_ID = `upsert-${ymd(new Date())}-${Date.now()}`;

// ── Supabase REST upsert ─────────────────────────────────
async function upsertRows(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "apikey":        SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Prefer":        "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase upsert 실패 ${res.status}: ${body}`);
  }
}

// ── JSON → stock_analysis 레코드 (KOSPI) ────────────────
function fromKospi(r) {
  return {
    stock_code:         r.stockCode,
    corp_name:          r.corp_name,
    current_price:      r.currentPrice    ?? 0,
    short_target_price: r.shortTargetPrice ?? 0,
    mid_target_price:   r.midTargetPrice   ?? 0,
    short_target_pct:   r.shortTargetPct   ?? 0,
    mid_target_pct:     r.midTargetPct     ?? 0,
    recommendation:     r.recommendation   ?? "",
    market_cap_tril:    r.marketCapTril    ?? 0,
    mrkt_ctg:           "KOSPI",
    analysis_run_id:    RUN_ID,
    total_score:        r.totalScore       ?? 0,
    short_score:        r.shortScore       ?? 0,
    long_score:         r.longScore        ?? 0,
    detail:             r.detail           ?? {},
    generated_at:       r.generatedAt      ?? new Date().toISOString(),
    updated_at:         new Date().toISOString(),
  };
}

// ── JSON → stock_analysis 레코드 (KOSDAQ) ───────────────
function fromKosdaq(r) {
  return {
    stock_code:         r.stockCode,
    corp_name:          r.corp_name,
    current_price:      r.currentPrice    ?? 0,
    short_target_price: r.shortTargetPrice ?? 0,
    mid_target_price:   r.midTargetPrice   ?? 0,
    short_target_pct:   r.shortTargetPct   ?? 0,
    mid_target_pct:     r.midTargetPct     ?? 0,
    recommendation:     r.recommendation   ?? "",
    market_cap_tril:    r.marketCapTril    ?? 0,
    mrkt_ctg:           "KOSDAQ",
    analysis_run_id:    RUN_ID,
    total_score:        r.totalScore       ?? 0,
    short_score:        r.shortScore       ?? 0,
    long_score:         r.longScore        ?? 0,
    detail:             r.detail ?? {
      밸류에이션_note: r.valNote ?? "",
      공시점수:        r.disclosureScore ?? 0,
      영업이익_조:     r.opIncomeTril ?? 0,
    },
    generated_at:       r.generatedAt      ?? new Date().toISOString(),
    updated_at:         new Date().toISOString(),
  };
}

// ── 배치 upsert (500건씩) ────────────────────────────────
async function batchUpsert(records, label) {
  const BATCH = 500;
  let done = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    await upsertRows(chunk);
    done += chunk.length;
    process.stdout.write(`\r  ${label}: ${done}/${records.length} 완료`);
  }
  console.log("");
}

// ── 메인 ─────────────────────────────────────────────────
async function main() {
  console.log(`\n=== Supabase ${TABLE} upsert ===\n`);

  if (doKospi) {
    const file = path.join(__dirname, "scored-kospi-full.json");
    if (!fs.existsSync(file)) { console.warn("scored-kospi-full.json 없음, 스킵"); }
    else {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const records = data.results.map(fromKospi);
      console.log(`KOSPI: ${records.length}건 upsert 시작`);
      await batchUpsert(records, "KOSPI");
    }
  }

  if (doKosdaq) {
    const file = path.join(__dirname, "scored-kosdaq.json");
    if (!fs.existsSync(file)) { console.warn("scored-kosdaq.json 없음, 스킵"); }
    else {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const records = data.results.map(fromKosdaq);
      console.log(`KOSDAQ: ${records.length}건 upsert 시작`);
      await batchUpsert(records, "KOSDAQ");
    }
  }

  console.log("\n✅ 완료");
}

main().catch(e => { console.error("오류:", e); process.exit(1); });
