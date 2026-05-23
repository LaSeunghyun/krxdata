/**
 * dart-mcp/batch.js
 * 하루 1회 실행: watchlist.json 종목의 주가·공시 목록을 수집해 dart-data.db에 저장
 *
 * 실행: npm run batch
 * Windows 자동화: 작업 스케줄러에 "node C:\claudeT\files\batch.js" 등록
 */

import { createRequire }  from "module";
import { fileURLToPath }  from "url";
import fetch   from "node-fetch";
import dotenv  from "dotenv";
import fs      from "fs";
import path    from "path";
import { BATCH_TIMEOUT_MS } from "./config.js";
import { openDb } from "./db.js";

const require   = createRequire(import.meta.url);
const AdmZip    = require("adm-zip");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, ".env") });

const DART_KEY   = process.env.DART_API_KEY;
const PUBLIC_KEY = process.env.PUBLIC_DATA_API_KEY;
const TIMEOUT_MS = BATCH_TIMEOUT_MS;

if (!DART_KEY)   { console.error("[batch] DART_API_KEY 미설정"); process.exit(1); }
if (!PUBLIC_KEY) { console.error("[batch] PUBLIC_DATA_API_KEY 미설정"); process.exit(1); }

const DART_BASE   = "https://opendart.fss.or.kr/api";
const PUBLIC_BASE = "https://apis.data.go.kr/1160100/service";

const pad     = n => String(n).padStart(2, "0");
const ymd     = d => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
const today   = () => ymd(new Date());
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate()-n); return ymd(d); };
const now     = () => new Date().toISOString();

// ── fetch helper ──────────────────────────────────────────
async function get(url, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return res;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`타임아웃 (${timeoutMs}ms)`);
    throw e;
  } finally {
    clearTimeout(id);
  }
}

// ── corp_code 캐시 (종목코드 → corp_code) ─────────────────
const CORP_CACHE = path.join(__dirname, ".corp_code_cache.json");
const CACHE_TTL  = 24 * 60 * 60_000;
let _corpMap = null;

async function getCorpMap() {
  if (_corpMap) return _corpMap;
  try {
    const stat = fs.statSync(CORP_CACHE);
    if (Date.now() - stat.mtimeMs < CACHE_TTL) {
      _corpMap = JSON.parse(fs.readFileSync(CORP_CACHE, "utf8"));
      console.log(`[batch] corp_code 캐시 로드 (${Object.keys(_corpMap).length}개)`);
      return _corpMap;
    }
  } catch { /* 없음 */ }

  console.log("[batch] corpCode.xml 다운로드 중...");
  const url = new URL(`${DART_BASE}/corpCode.xml`);
  url.searchParams.set("crtfc_key", DART_KEY);
  const res = await get(url.toString(), 60_000);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const xml = zip.getEntry("CORPCODE.xml")?.getData()?.toString("utf8");
  if (!xml) throw new Error("CORPCODE.xml 없음");

  const map = {};
  for (const m of xml.matchAll(/<corp_code>(\d{8})<\/corp_code>[\s\S]*?<stock_code>([^<]*)<\/stock_code>/g)) {
    const sc = m[2].trim();
    if (/^\d{6}$/.test(sc)) map[sc] = m[1];
  }
  _corpMap = map;
  fs.writeFileSync(CORP_CACHE, JSON.stringify(map));
  console.log(`[batch] corp_code 맵 갱신 완료 (${Object.keys(map).length}개)`);
  return map;
}

// ── 주가 수집 ─────────────────────────────────────────────
async function fetchPrice(db, stockCode) {
  const url = new URL(`${PUBLIC_BASE}/GetStockSecuritiesInfoService/getStockPriceInfo`);
  url.searchParams.set("serviceKey", PUBLIC_KEY);
  url.searchParams.set("resultType", "json");
  url.searchParams.set("numOfRows", "200");
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("beginBasDt", daysAgo(30));
  url.searchParams.set("endBasDt", today());
  url.searchParams.set("srtnCd", stockCode);

  const res  = await get(url.toString());
  const data = await res.json();
  const body = data?.response?.body;
  if (!body) throw new Error("응답 형식 오류");

  const items = body?.items?.item;
  const all   = items ? (Array.isArray(items) ? items : [items]) : [];
  // srtnCd 필터 미동작 대비 클라이언트 필터
  const list  = all.filter(r => r.srtnCd === stockCode);

  if (!list.length) {
    console.warn(`  [주가] ${stockCode} — 데이터 없음 (개발계정 필터 제한)`);
    return;
  }

  const insertPrice = db.prepare(`
    INSERT OR REPLACE INTO prices (stock_code, date, close, open, high, low, volume, market_cap, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertStock = db.prepare(`
    INSERT OR REPLACE INTO stocks (stock_code, stock_name, market, updated_at)
    VALUES (?, ?, ?, ?)
  `);

  const upsert = db.transaction((rows) => {
    for (const r of rows) {
      insertPrice.run(stockCode, r.basDt, Number(r.clpr), Number(r.mkp), Number(r.hipr), Number(r.lopr), Number(r.trqu), Number(r.mrktTotAmt), now());
    }
    const latest = rows.sort((a,b) => b.basDt.localeCompare(a.basDt))[0];
    insertStock.run(stockCode, latest.itmsNm, latest.mrktCtg, now());
  });

  upsert(list);
  console.log(`  [주가] ${stockCode} — ${list.length}건 저장`);
}

// ── 공시 목록 수집 ─────────────────────────────────────────
async function fetchDisclosures(db, stockCode, corpCode) {
  const url = new URL(`${DART_BASE}/list.json`);
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bgn_de", daysAgo(90));
  url.searchParams.set("end_de", today());
  url.searchParams.set("sort", "date");
  url.searchParams.set("sort_mth", "desc");
  url.searchParams.set("page_count", "100");

  const res  = await get(url.toString());
  const data = await res.json();

  if (data.status && !["000","013"].includes(data.status)) {
    console.warn(`  [공시] ${stockCode} — OpenDart [${data.status}]: ${data.message}`);
    return;
  }

  const list = data.list ?? [];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO disclosures (rcept_no, stock_code, corp_code, date, type, title, filer, url, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let newCount = 0;
  const upsertAll = db.transaction((rows) => {
    for (const r of rows) {
      const result = insert.run(
        r.rcept_no, stockCode, corpCode, r.rcept_dt,
        r.pblntf_ty_nm, r.report_nm, r.flr_nm,
        `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${r.rcept_no}`,
        now()
      );
      if (result.changes) newCount++;
    }
  });

  upsertAll(list);
  console.log(`  [공시] ${stockCode} — 조회 ${list.length}건, 신규 저장 ${newCount}건 (중복 ${list.length - newCount}건 스킵)`);
}

// ── 메인 ─────────────────────────────────────────────────
async function main() {
  console.log(`\n[batch] 시작 ${now()}`);

  const wl = JSON.parse(fs.readFileSync(path.join(__dirname, "watchlist.json"), "utf8"));
  const stocks = wl.stocks ?? [];
  if (!stocks.length) { console.log("[batch] watchlist가 비어 있습니다."); return; }

  const db      = openDb();
  const corpMap = await getCorpMap();

  for (const code of stocks) {
    console.log(`\n▶ ${code}`);
    try {
      await fetchPrice(db, code);
    } catch (e) {
      console.error(`  [주가] 오류: ${e.message}`);
    }

    const corpCode = corpMap[code];
    if (!corpCode) {
      console.warn(`  [공시] corp_code 없음 — ${code} 스킵`);
      continue;
    }
    try {
      await fetchDisclosures(db, code, corpCode);
    } catch (e) {
      console.error(`  [공시] 오류: ${e.message}`);
    }
  }

  db.close();
  console.log(`\n[batch] 완료 ${now()}`);
}

main().catch(e => { console.error("[batch] 치명적 오류:", e); process.exit(1); });
