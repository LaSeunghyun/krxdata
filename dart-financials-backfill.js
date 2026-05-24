/**
 * dart-financials-backfill.js
 * DART fnlttMultiAcnt API → stock_financials 다년도 백필
 *
 * 실행: node dart-financials-backfill.js [--years 2022,2023,2024]
 *       (기본값: 2022, 2023, 2024)
 *
 * 환경변수: DART_API_KEY, SUPABASE_MANAGEMENT_KEY (.env)
 */

import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const DART_KEY    = process.env.DART_API_KEY;
const MGMT_KEY    = process.env.SUPABASE_MANAGEMENT_KEY;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "onxkbuecwbcueuhwnowx";
const DART_BASE   = "https://opendart.fss.or.kr/api";

if (!DART_KEY)  { console.error("DART_API_KEY 미설정"); process.exit(1); }
if (!MGMT_KEY)  { console.error("SUPABASE_MANAGEMENT_KEY 미설정"); process.exit(1); }

async function dbQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${MGMT_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(data?.message ?? "DB 쿼리 오류");
  return data;
}

// ── 인수 파싱 ────────────────────────────────────────────────
const args = process.argv.slice(2);
const yearsArg = args.find(a => a.startsWith("--years"))?.split("=")[1]
  ?? args[args.indexOf("--years") + 1];
const YEARS = yearsArg
  ? yearsArg.split(",").map(y => y.trim())
  : ["2022", "2023", "2024"];

const BATCH_SIZE = 100;   // DART fnlttMultiAcnt 한 번에 최대 100개
const DELAY_MS   = 300;   // 배치 사이 딜레이
const UPSERT_BATCH = 500; // Supabase upsert 배치 크기

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 유틸 ─────────────────────────────────────────────────────
async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 30000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

// ── DART 재무 배치 조회 ──────────────────────────────────────
async function getMultiFinancials(corpCodes, year, fsdiv) {
  const url = new URL(`${DART_BASE}/fnlttMultiAcnt.json`);
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("corp_code", corpCodes.join(","));
  url.searchParams.set("bsns_year", year);
  url.searchParams.set("reprt_code", "11011"); // 사업보고서
  url.searchParams.set("fs_div",     fsdiv);
  const d = await fetchJson(url.toString());
  if (!["000", "013"].includes(d.status))
    console.warn(`    DART ${fsdiv}/${year}: status=${d.status} (${d.message ?? ""})`);
  return d.list ?? [];
}

/** corpCodes 배열에 대해 CFS 우선 → OFS 보완으로 해당 연도 재무 수집 */
async function fetchYearFinancials(corpCodes, year) {
  let list = await getMultiFinancials(corpCodes, year, "CFS");
  const found = new Set(list.map(r => r.corp_code));
  const missing = corpCodes.filter(c => !found.has(c));
  if (missing.length) {
    const ofs = await getMultiFinancials(missing, year, "OFS");
    list = [...list, ...ofs];
  }
  return list;
}

// ── 재무 파싱 ────────────────────────────────────────────────
function parseFinancials(rows) {
  const get = (...names) => {
    for (const nm of names) {
      const row = rows.find(r => r.account_nm?.trim() === nm && r.sj_div !== "CF");
      if (row) return {
        current:  Number(String(row.thstrm_amount   ?? "0").replace(/,/g, "")),
        previous: Number(String(row.frmtrm_amount   ?? "0").replace(/,/g, "")),
        before:   Number(String(row.bfefrmtrm_amount ?? "0").replace(/,/g, "")),
      };
    }
    return null;
  };
  const getCF = nm => {
    const row = rows.find(r => r.account_nm?.trim() === nm && r.sj_div === "CF");
    return row ? Number(String(row.thstrm_amount ?? "0").replace(/,/g, "")) : null;
  };
  return {
    revenue:     get("매출액"),
    opIncome:    get("영업이익", "영업이익(손실)"),
    netIncome:   get("당기순이익", "당기순이익(손실)"),
    totalAsset:  get("자산총계"),
    totalEquity: get("자본총계"),
    totalDebt:   get("부채총계"),
    curAsset:    get("유동자산"),
    curLiab:     get("유동부채"),
    cfOps:       getCF("영업활동현금흐름"),
  };
}

// ── Supabase upsert (Management API SQL 방식) ─────────────────
function esc(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function upsertRows(rows) {
  const BATCH = UPSERT_BATCH;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const vals = chunk.map(r =>
      `(${esc(r.stock_code)},${esc(r.corp_name)},${esc(r.mrkt_ctg)},${esc(r.analysis_year)},` +
      `${esc(r.revenue)},${esc(r.op_income)},${esc(r.net_income)},${esc(r.total_equity)},` +
      `${esc(r.total_debt)},${esc(r.total_asset)},${esc(r.cf_ops)},` +
      `${esc(r.debt_ratio)},${esc(r.cur_ratio)},${esc(r.op_margin)},` +
      `${esc(r.revenue_yoy)},${esc(r.op_income_yoy)},` +
      `${esc(r.per)},${esc(r.pbr)},${esc(r.roe)},${esc(r.market_cap)},NOW())`
    ).join(",\n");

    await dbQuery(`
      INSERT INTO stock_financials
        (stock_code,corp_name,mrkt_ctg,analysis_year,
         revenue,op_income,net_income,total_equity,
         total_debt,total_asset,cf_ops,
         debt_ratio,cur_ratio,op_margin,
         revenue_yoy,op_income_yoy,
         per,pbr,roe,market_cap,updated_at)
      VALUES ${vals}
      ON CONFLICT (stock_code, analysis_year) DO UPDATE SET
        corp_name     = EXCLUDED.corp_name,
        mrkt_ctg      = EXCLUDED.mrkt_ctg,
        revenue       = COALESCE(EXCLUDED.revenue,       stock_financials.revenue),
        op_income     = COALESCE(EXCLUDED.op_income,     stock_financials.op_income),
        net_income    = COALESCE(EXCLUDED.net_income,    stock_financials.net_income),
        total_equity  = COALESCE(EXCLUDED.total_equity,  stock_financials.total_equity),
        total_debt    = COALESCE(EXCLUDED.total_debt,    stock_financials.total_debt),
        total_asset   = COALESCE(EXCLUDED.total_asset,   stock_financials.total_asset),
        cf_ops        = COALESCE(EXCLUDED.cf_ops,        stock_financials.cf_ops),
        debt_ratio    = COALESCE(EXCLUDED.debt_ratio,    stock_financials.debt_ratio),
        cur_ratio     = COALESCE(EXCLUDED.cur_ratio,     stock_financials.cur_ratio),
        op_margin     = COALESCE(EXCLUDED.op_margin,     stock_financials.op_margin),
        revenue_yoy   = COALESCE(EXCLUDED.revenue_yoy,   stock_financials.revenue_yoy),
        op_income_yoy = COALESCE(EXCLUDED.op_income_yoy, stock_financials.op_income_yoy),
        roe           = COALESCE(EXCLUDED.roe,           stock_financials.roe),
        updated_at    = NOW()
    `);
    done += chunk.length;
    process.stdout.write(`\r    ${done}/${rows.length} upsert 완료`);
  }
  console.log("");
}

// ── 회사 목록 로드 ───────────────────────────────────────────
function loadCompanies() {
  const companies = [];
  const seen = new Set();

  for (const [file, mrkt] of [
    ["kospi-profitable.json",  "KOSPI"],
    ["kosdaq-profitable.json", "KOSDAQ"],
  ]) {
    const fp = path.join(__dirname, file);
    if (!fs.existsSync(fp)) { console.warn(`  ${file} 없음 — 스킵`); continue; }
    const data = JSON.parse(fs.readFileSync(fp, "utf8"));
    const list = data.profitable ?? data.results ?? [];
    for (const c of list) {
      if (!seen.has(c.corp_code)) {
        seen.add(c.corp_code);
        companies.push({ corp_code: c.corp_code, stock_code: c.stockCode, corp_name: c.corp_name, mrkt_ctg: mrkt });
      }
    }
    console.log(`  ${mrkt}: ${list.length}개 로드`);
  }
  return companies;
}

// ── 연도별 처리 ──────────────────────────────────────────────
async function processYear(year, companies) {
  console.log(`\n[${year}] 재무 수집 시작 — ${companies.length}개 기업`);

  // DART 배치 수집
  let allFinRows = [];
  const batches = [];
  for (let i = 0; i < companies.length; i += BATCH_SIZE)
    batches.push(companies.slice(i, i + BATCH_SIZE));

  for (let bi = 0; bi < batches.length; bi++) {
    process.stdout.write(`  배치 ${bi + 1}/${batches.length} ... `);
    const batch = batches[bi];
    const rows  = await fetchYearFinancials(batch.map(c => c.corp_code), year);
    allFinRows  = [...allFinRows, ...rows];
    console.log(`${rows.length}건`);
    if (bi < batches.length - 1) await sleep(DELAY_MS);
  }

  // corp_code → 회사 매핑
  const codeMap = {};
  for (const c of companies) codeMap[c.corp_code] = c;

  // 파싱 → stock_financials 레코드 생성
  const companyRows = {};
  for (const row of allFinRows) {
    if (!companyRows[row.corp_code]) companyRows[row.corp_code] = [];
    companyRows[row.corp_code].push(row);
  }

  const records = [];
  const now = new Date().toISOString();
  for (const corp_code of Object.keys(companyRows)) {
    const c = codeMap[corp_code];
    if (!c) continue;
    const fin = parseFinancials(companyRows[corp_code]);

    const _rev = fin.revenue?.current     ?? 0;
    const _op  = fin.opIncome?.current    ?? 0;
    const _ni  = fin.netIncome?.current   ?? 0;
    const _eq  = fin.totalEquity?.current ?? 0;
    const _td  = fin.totalDebt?.current   ?? 0;
    const _ta  = fin.totalAsset?.current  ?? 0;
    const _ca  = fin.curAsset?.current    ?? 0;
    const _cl  = fin.curLiab?.current     ?? 0;

    records.push({
      stock_code:    c.stock_code,
      corp_name:     c.corp_name,
      mrkt_ctg:      c.mrkt_ctg,
      analysis_year: Number(year),
      revenue:       _rev  || null,
      op_income:     _op   || null,
      net_income:    _ni   || null,
      total_equity:  _eq   || null,
      total_debt:    _td   || null,
      total_asset:   _ta   || null,
      cf_ops:        fin.cfOps ?? null,
      debt_ratio:    _td && _eq > 0 ? +(_td / _eq * 100).toFixed(2) : null,
      cur_ratio:     _ca && _cl > 0 ? +(_ca / _cl * 100).toFixed(2) : null,
      op_margin:     _op && _rev > 0 ? +(_op / _rev * 100).toFixed(2) : null,
      revenue_yoy:   fin.revenue?.previous > 0
                       ? +((_rev - fin.revenue.previous) / fin.revenue.previous * 100).toFixed(2) : null,
      op_income_yoy: fin.opIncome?.previous != null && fin.opIncome.previous !== 0
                       ? +((_op - fin.opIncome.previous) / Math.abs(fin.opIncome.previous) * 100).toFixed(2) : null,
      per:           null,  // 시가총액 없어서 산출 불가
      pbr:           null,
      roe:           _ni > 0 && _eq > 0 ? +(_ni / _eq * 100).toFixed(2) : null,
      market_cap:    null,
      updated_at:    now,
    });
  }

  console.log(`  파싱 완료: ${records.length}건`);
  if (!records.length) { console.warn(`  [${year}] upsert 건너뜀`); return; }

  console.log(`  Supabase upsert...`);
  await upsertRows(records);
  console.log(`  ✅ [${year}] ${records.length}건 완료`);
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== DART 다년도 재무 백필 ===`);
  console.log(`대상 연도: ${YEARS.join(", ")}\n`);

  console.log("회사 목록 로드...");
  const companies = loadCompanies();
  console.log(`총 ${companies.length}개\n`);

  for (const year of YEARS) {
    await processYear(year, companies);
  }

  console.log("\n✅ 모든 연도 백필 완료");
}

main().catch(e => { console.error("\n오류:", e.message); process.exit(1); });
