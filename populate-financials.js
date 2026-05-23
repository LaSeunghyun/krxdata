/**
 * populate-financials.js
 * 기존 scored-kospi-full.json / scored-kosdaq.json 에서
 * PER/PBR 파싱 → stock_financials 테이블 백필
 *
 * 실행: node populate-financials.js
 * 사전 조건: migration_stock_financials.sql을 Supabase에서 먼저 실행
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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY 미설정");
  process.exit(1);
}

// PER/PBR 텍스트 파싱 — "PER6.2(저평가), PBR0.25" → { per: 6.2, pbr: 0.25 }
function parsePERPBR(note) {
  const per = note?.match(/PER([\d.]+)/)?.[1];
  const pbr = note?.match(/PBR([\d.]+)/)?.[1];
  return {
    per: per ? parseFloat(per) : null,
    pbr: pbr ? parseFloat(pbr) : null,
  };
}

function buildFinRow(r, mrkt_ctg) {
  // KOSPI: detail.중장기_밸류에이션.note / KOSDAQ: detail.밸류에이션_note
  const valNote = r.detail?.["중장기_밸류에이션"]?.note
    ?? r.detail?.["밸류에이션_note"]
    ?? r.valNote
    ?? "";

  const { per, pbr } = parsePERPBR(valNote);
  const marketCap = Math.round((r.marketCapTril ?? 0) * 1e12);

  // PER/PBR에서 역산
  const net_income  = per && marketCap ? Math.round(marketCap / per) : null;
  const total_equity = pbr && marketCap ? Math.round(marketCap / pbr) : null;
  const roe = net_income && total_equity ? +( net_income / total_equity * 100).toFixed(2) : null;

  return {
    stock_code:    r.stockCode,
    corp_name:     r.corp_name,
    mrkt_ctg,
    per,
    pbr,
    roe,
    debt_ratio:    null,  // 원본 없음 — 재스코어링 시 채워짐
    cur_ratio:     null,
    op_margin:     null,
    revenue_yoy:   null,
    op_income_yoy: null,
    net_income,
    total_equity,
    total_debt:    null,
    total_asset:   null,
    revenue:       null,
    op_income:     Math.round((r.opIncomeTril ?? 0) * 1e12) || null,
    market_cap:    marketCap || null,
    cf_ops:        null,
    analysis_year: null,
    updated_at:    r.generatedAt ?? new Date().toISOString(),
  };
}

async function upsertBatch(rows) {
  const BATCH = 500;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/stock_financials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`❌ upsert 실패 ${res.status}:`, body);
      return false;
    }
    done += chunk.length;
    process.stdout.write(`\r  ${done}/${rows.length} 완료`);
  }
  console.log("");
  return true;
}

async function main() {
  console.log("\n=== stock_financials 백필 ===\n");

  const rows = [];

  // KOSPI
  const kospiFile = path.join(__dirname, "scored-kospi-full.json");
  if (fs.existsSync(kospiFile)) {
    const data = JSON.parse(fs.readFileSync(kospiFile, "utf8"));
    for (const r of data.results) rows.push(buildFinRow(r, "KOSPI"));
    console.log(`KOSPI: ${data.results.length}건 로드`);
  } else {
    console.warn("scored-kospi-full.json 없음 — 스킵");
  }

  // KOSDAQ
  const kosdaqFile = path.join(__dirname, "scored-kosdaq.json");
  if (fs.existsSync(kosdaqFile)) {
    const data = JSON.parse(fs.readFileSync(kosdaqFile, "utf8"));
    for (const r of data.results) rows.push(buildFinRow(r, "KOSDAQ"));
    console.log(`KOSDAQ: ${data.results.length}건 로드`);
  } else {
    console.warn("scored-kosdaq.json 없음 — 스킵");
  }

  console.log(`\n총 ${rows.length}건 upsert 시작...\n`);
  const ok = await upsertBatch(rows);

  if (ok) {
    console.log(`\n✅ 완료 — ${rows.length}건 stock_financials 적재`);
    console.log("   ※ debt_ratio/cur_ratio/op_margin 등은 재스코어링 시 채워집니다");
  }
}

main().catch(e => { console.error("오류:", e); process.exit(1); });
