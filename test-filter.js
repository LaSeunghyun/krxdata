/**
 * test-filter.js
 * DART 전체 상장기업 재무 수집 → 영업이익 흑자 기업 필터 테스트
 *
 * 실행: node test-filter.js
 * 결과: profitable-stocks.json
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { ANALYSIS_YEAR, ANALYSIS_YEAR_FALLBACK, SCORE_BATCH_SIZE, FILTER_DELAY_MS } from "./config.js";

const require   = createRequire(import.meta.url);
const AdmZip    = require("adm-zip");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, ".env") });

const DART_KEY  = process.env.DART_API_KEY;
const DART_BASE = "https://opendart.fss.or.kr/api";
const BATCH_SIZE = SCORE_BATCH_SIZE; // DART fnlttMultiAcnt 최대 100개
const DELAY_MS   = FILTER_DELAY_MS; // API 부하 방지

if (!DART_KEY) { console.error("DART_API_KEY 미설정"); process.exit(1); }

// 사업보고서 기준: FY2025(2026년 3월 제출) → 없으면 FY2024
const YEAR      = ANALYSIS_YEAR;
const YEAR_FB   = ANALYSIS_YEAR_FALLBACK; // fallback

// ── 유틸 ──────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url, { timeout: 30000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── 1. corpCode.xml → 전체 종목코드·corp_code 맵 ─────────
async function getCorpMap() {
  const CACHE = path.join(__dirname, ".corp_code_cache.json");
  try {
    const stat = fs.statSync(CACHE);
    if (Date.now() - stat.mtimeMs < 24 * 60 * 60_000) {
      const map = JSON.parse(fs.readFileSync(CACHE, "utf8"));
      console.log(`[1] corp_code 캐시 로드: ${Object.keys(map).length}개`);
      return map;
    }
  } catch { /* 없음 */ }

  console.log("[1] DART corpCode.xml 다운로드 중...");
  const url = `${DART_BASE}/corpCode.xml?crtfc_key=${DART_KEY}`;
  const res = await fetch(url, { timeout: 60000 });
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const xml = zip.getEntry("CORPCODE.xml")?.getData()?.toString("utf8");
  if (!xml) throw new Error("CORPCODE.xml 없음");

  // stock_code가 있는 상장 기업만 추출 → { stock_code: { corp_code, corp_name } }
  const map = {};
  for (const m of xml.matchAll(
    /<corp_code>(\d{8})<\/corp_code>\s*<corp_name>([^<]*)<\/corp_name>[\s\S]*?<stock_code>([^<]*)<\/stock_code>/g
  )) {
    const sc = m[3].trim();
    if (/^\d{6}$/.test(sc)) {
      map[sc] = { corp_code: m[1], corp_name: m[2].trim() };
    }
  }

  fs.writeFileSync(CACHE, JSON.stringify(map));
  console.log(`[1] 전체 상장기업: ${Object.keys(map).length}개`);
  return map;
}

// ── 2. DART fnlttMultiAcnt — 최대 100개 일괄 조회 ─────────
async function fetchMultiFinancials(corpCodes, year, fsdiv = "CFS") {
  const url = new URL(`${DART_BASE}/fnlttMultiAcnt.json`);
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("corp_code", corpCodes.join(","));
  url.searchParams.set("bsns_year", year);
  url.searchParams.set("reprt_code", "11011"); // 사업보고서
  url.searchParams.set("fs_div", fsdiv);

  const data = await fetchJson(url.toString());
  if (data.status === "013") return []; // 데이터 없음
  if (data.status !== "000") {
    console.warn(`  fnlttMultiAcnt 오류: [${data.status}] ${data.message}`);
    return [];
  }
  return data.list ?? [];
}

// 연도 fallback: YEAR(CFS→OFS) → YEAR_FB(CFS→OFS)
async function fetchWithFallback(corpCodes) {
  // 1차: YEAR CFS
  let list = await fetchMultiFinancials(corpCodes, YEAR, "CFS");
  const foundCFS = new Set(list.map(r => r.corp_code));
  const missingOFS = corpCodes.filter(c => !foundCFS.has(c));

  // 2차: YEAR OFS (연결 없는 기업)
  if (missingOFS.length > 0) {
    const ofsData = await fetchMultiFinancials(missingOFS, YEAR, "OFS");
    list = [...list, ...ofsData];
  }

  // 3차: YEAR_FB CFS (여전히 데이터 없는 기업)
  const found = new Set(list.map(r => r.corp_code));
  const missing = corpCodes.filter(c => !found.has(c));
  if (missing.length > 0) {
    let fbList = await fetchMultiFinancials(missing, YEAR_FB, "CFS");
    const foundFB = new Set(fbList.map(r => r.corp_code));
    const missingFB = missing.filter(c => !foundFB.has(c));

    // 4차: YEAR_FB OFS
    if (missingFB.length > 0) {
      const ofsData2 = await fetchMultiFinancials(missingFB, YEAR_FB, "OFS");
      fbList = [...fbList, ...ofsData2];
    }
    list = [...list, ...fbList];
  }

  return list;
}

// ── 3. 영업이익 파싱 ──────────────────────────────────────
function parseOperatingIncome(list, corpCode) {
  const rows = list.filter(r => r.corp_code === corpCode);
  const OI_NAMES = ["영업이익", "영업이익(손실)"];

  // account_nm이 영업이익인 행 중 thstrm_amount (당기) 사용
  for (const row of rows) {
    if (OI_NAMES.includes(row.account_nm?.trim())) {
      const val = Number(String(row.thstrm_amount ?? "").replace(/,/g, ""));
      if (!isNaN(val)) return val;
    }
  }
  return null;
}

// ── 메인 ─────────────────────────────────────────────────
async function main() {
  console.log(`\n=== DART 흑자 기업 필터 테스트 (${YEAR}년 사업보고서) ===\n`);

  // 1. 전체 상장기업 코드 로드
  const corpMap = await getCorpMap();
  const entries = Object.entries(corpMap); // [[stock_code, {corp_code, corp_name}], ...]
  console.log(`[2] 총 ${entries.length}개 기업 재무 조회 시작\n`);

  // 2. BATCH_SIZE 단위로 분할 조회
  const profitable = [];
  const unprofitable = [];
  const noData = [];

  const batches = [];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    batches.push(entries.slice(i, i + BATCH_SIZE));
  }

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const corpCodes = batch.map(([, v]) => v.corp_code);

    process.stdout.write(`  배치 ${bi + 1}/${batches.length} (${batch[0][1].corp_name} ~) ... `);

    let list = [];
    try {
      list = await fetchWithFallback(corpCodes);
    } catch (e) {
      console.warn(`오류: ${e.message}`);
      await sleep(DELAY_MS * 2);
      continue;
    }

    // 각 기업 영업이익 판정
    for (const [stockCode, { corp_code, corp_name }] of batch) {
      const oi = parseOperatingIncome(list, corp_code);
      if (oi === null) {
        noData.push({ stockCode, corp_name });
      } else if (oi > 0) {
        profitable.push({ stockCode, corp_code, corp_name, operatingIncome: oi });
      } else {
        unprofitable.push({ stockCode, corp_name, operatingIncome: oi });
      }
    }

    console.log(`완료 (${list.length}건)`);
    await sleep(DELAY_MS);
  }

  // 3. 결과 저장
  const result = {
    generatedAt: new Date().toISOString(),
    year: YEAR,
    summary: {
      total: entries.length,
      profitable: profitable.length,
      unprofitable: unprofitable.length,
      noData: noData.length,
    },
    profitable: profitable.sort((a, b) => b.operatingIncome - a.operatingIncome),
  };

  const outPath = path.join(__dirname, "profitable-stocks.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log(`
=== 결과 ===
전체 상장기업 : ${entries.length}개
영업이익 흑자 : ${profitable.length}개
영업이익 적자 : ${unprofitable.length}개
데이터 없음   : ${noData.length}개

저장: profitable-stocks.json
  `);

  // Top 20 미리보기
  console.log("── 영업이익 상위 20개 ──");
  for (const s of profitable.slice(0, 20)) {
    const oi = (s.operatingIncome / 1e12).toFixed(2);
    console.log(`  ${s.stockCode} ${s.corp_name.padEnd(20)} 영업이익: ${oi}조`);
  }
}

main().catch(e => { console.error("치명적 오류:", e); process.exit(1); });
