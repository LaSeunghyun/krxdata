/**
 * dart-mcp/mcp-server.js  v2.3
 *
 * 통합 데이터 소스:
 *   A) OpenDart (opendart.fss.or.kr)  → 공시·재무·주주 (실시간)
 *   B) 공공데이터포털 (apis.data.go.kr) → 주식 시세·상장정보 (실시간)
 *   C) dart-data.db (SQLite)           → 배치 수집된 주가·공시 목록 (로컬)
 *
 * Tool 목록:
 *   ── 로컬 DB (배치 수집 데이터) ────────
 *   query_price             DB에서 종목 주가 이력 조회
 *   query_disclosures       DB에서 공시 목록 조회
 *   get_disclosure_body     공시 본문 텍스트 실시간 조회
 *
 *   ── OpenDart (실시간) ─────────────────
 *   get_corp_info           종목코드 → 기업기본정보 + corp_code
 *   get_disclosures         최근 공시 목록 (실시간)
 *   get_financials          재무제표 주요 계정
 *   get_major_shareholders  주요 주주 현황
 *
 *   ── 공공데이터포털 (실시간) ────────────
 *   get_stock_price         최신 주가
 *   get_stock_history       기간별 일별 주가 이력
 *   get_market_info         KRX 상장종목 기본정보
 */

import { Server }               from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport }  from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire }  from "module";
import { fileURLToPath }  from "url";
import fetch   from "node-fetch";
import dotenv  from "dotenv";
import fs      from "fs";
import path    from "path";
import { FETCH_TIMEOUT_MS } from "./config.js";
import { openDb } from "./db.js";

const require    = createRequire(import.meta.url);
const AdmZip     = require("adm-zip");
const cheerio    = require("cheerio");
const __dirname  = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, ".env") });

const DART_KEY         = process.env.DART_API_KEY;
const PUBLIC_KEY       = process.env.PUBLIC_DATA_API_KEY;
const CORP_CACHE       = path.join(__dirname, ".corp_code_cache.json");
const CACHE_TTL_MS     = 24 * 60 * 60 * 1_000;

if (!DART_KEY && !PUBLIC_KEY) {
  console.error("[dart-mcp] .env에 DART_API_KEY 또는 PUBLIC_DATA_API_KEY 필요");
  process.exit(1);
}
if (!DART_KEY)   console.error("[dart-mcp] DART_API_KEY 미설정 — OpenDart tool 비활성");
if (!PUBLIC_KEY) console.error("[dart-mcp] PUBLIC_DATA_API_KEY 미설정 — 공공데이터포털 tool 비활성");

const DART_BASE   = "https://opendart.fss.or.kr/api";
const PUBLIC_BASE = "https://apis.data.go.kr/1160100/service";

const pad     = n => String(n).padStart(2, "0");
const ymd     = d => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
const today   = () => ymd(new Date());
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate()-n); return ymd(d); };
const num     = v => v != null ? Number(v).toLocaleString("ko-KR") : null;

// ── input validators ──────────────────────────────────────
const reStock = /^\d{6}$/;
const reCorp  = /^\d{8}$/;
const reYear  = /^\d{4}$/;
const reDate  = /^\d{8}$/;

const requireStockCode = v => {
  if (!reStock.test(String(v ?? ""))) throw new Error("stock_code는 6자리 숫자여야 합니다");
};
const requireCorpCode = v => {
  if (!reCorp.test(String(v ?? ""))) throw new Error("corp_code는 8자리 숫자여야 합니다");
};
const requireYear = v => {
  if (!reYear.test(String(v ?? ""))) throw new Error("year는 YYYY 4자리여야 합니다");
};
const optionalDate = v => {
  if (v != null && v !== "" && !reDate.test(String(v))) throw new Error("date는 YYYYMMDD 8자리여야 합니다");
};

// ── fetch with timeout ────────────────────────────────────
async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`요청 타임아웃 (${timeoutMs}ms)`);
    throw e;
  } finally {
    clearTimeout(id);
  }
}

// ── corp_code 캐시 ────────────────────────────────────────
let _corpMap = null;

async function getCorpMap() {
  if (_corpMap) return _corpMap;
  try {
    const stat = fs.statSync(CORP_CACHE);
    if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      _corpMap = JSON.parse(fs.readFileSync(CORP_CACHE, "utf8"));
      console.error(`[dart-mcp] corp_code 캐시 로드 (${Object.keys(_corpMap).length}개)`);
      return _corpMap;
    }
  } catch { /* 캐시 없음 */ }

  if (!DART_KEY) throw new Error("DART_API_KEY 미설정 — corp_code 조회 불가");
  console.error("[dart-mcp] corp_code 맵 갱신 중...");
  const url = new URL(`${DART_BASE}/corpCode.xml`);
  url.searchParams.set("crtfc_key", DART_KEY);
  const res = await fetchWithTimeout(url.toString(), 60_000);
  if (!res.ok) throw new Error(`corpCode 다운로드 실패: HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const xml = zip.getEntry("CORPCODE.xml")?.getData()?.toString("utf8");
  if (!xml) throw new Error("CORPCODE.xml 없음");

  const map = {};
  for (const m of xml.matchAll(/<corp_code>(\d{8})<\/corp_code>[\s\S]*?<stock_code>([^<]*)<\/stock_code>/g)) {
    const sc = m[2].trim();
    if (reStock.test(sc)) map[sc] = m[1];
  }
  _corpMap = map;
  try { fs.writeFileSync(CORP_CACHE, JSON.stringify(map)); } catch { /* 무시 */ }
  console.error(`[dart-mcp] corp_code 맵 저장 (${Object.keys(map).length}개)`);
  return map;
}

async function stockToCorpCode(stock_code) {
  const map  = await getCorpMap();
  const code = map[stock_code];
  if (!code) throw new Error(`종목코드 ${stock_code}에 해당하는 corp_code를 찾을 수 없습니다`);
  return code;
}

// ── API helpers ───────────────────────────────────────────
async function dart(endpoint, params = {}) {
  if (!DART_KEY) throw new Error("DART_API_KEY 미설정");
  const url = new URL(`${DART_BASE}/${endpoint}`);
  url.searchParams.set("crtfc_key", DART_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res  = await fetchWithTimeout(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.status && !["000","013"].includes(data.status))
    throw new Error(`OpenDart [${data.status}]: ${data.message}`);
  return data;
}

async function pub(service, operation, params = {}) {
  if (!PUBLIC_KEY) throw new Error("PUBLIC_DATA_API_KEY 미설정");
  const url = new URL(`${PUBLIC_BASE}/${service}/${operation}`);
  url.searchParams.set("serviceKey", PUBLIC_KEY);
  url.searchParams.set("resultType", "json");
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res  = await fetchWithTimeout(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const body = data?.response?.body;
  if (!body) throw new Error("응답 형식 오류");
  const code = data?.response?.header?.resultCode;
  if (code && code !== "00")
    throw new Error(`공공데이터포털 오류: ${data?.response?.header?.resultMsg}`);
  return body;
}

const toList       = items => items ? (Array.isArray(items) ? items : [items]) : [];
const filterBySrtn = (list, sc) => list.filter(r => r.srtnCd === sc);

// ── DB singleton ──────────────────────────────────────────
let _db = null;
const db = () => { if (!_db) _db = openDb(); return _db; };

// ── 공시 본문 파싱 ────────────────────────────────────────
async function fetchDisclosureBody(rcepNo) {
  if (!DART_KEY) throw new Error("DART_API_KEY 미설정");
  const url = new URL(`${DART_BASE}/document.xml`);
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("rcpNo", rcepNo);
  const res = await fetchWithTimeout(url.toString(), 30_000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const buf  = Buffer.from(await res.arrayBuffer());
  const zip  = new AdmZip(buf);
  const entries = zip.getEntries().filter(e => e.entryName.endsWith(".html") || e.entryName.endsWith(".htm"));
  if (!entries.length) throw new Error("HTML 문서 없음");

  // 가장 큰 HTML 파일이 본문일 가능성 높음
  entries.sort((a, b) => b.header.size - a.header.size);
  const html = entries[0].getData().toString("utf8");
  const $    = cheerio.load(html);
  $("script, style, head").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return text.slice(0, 10_000); // 최대 10,000자
}

const TOOLS = [
  // ── 로컬 DB ────────────────────────────────────────────
  {
    name: "query_price",
    description: "로컬 DB에서 종목 주가 이력을 조회합니다. npm run batch로 수집된 데이터 기준.",
    inputSchema: {
      type: "object",
      properties: {
        stock_code: { type: "string", description: "종목코드 6자리" },
        days:       { type: "number", description: "최근 N일 (기본 30)", default: 30 },
      },
      required: ["stock_code"],
    },
  },
  {
    name: "query_disclosures",
    description: "로컬 DB에서 공시 목록을 조회합니다. npm run batch로 수집된 데이터 기준.",
    inputSchema: {
      type: "object",
      properties: {
        stock_code: { type: "string", description: "종목코드 6자리" },
        limit:      { type: "number", description: "조회 건수 (기본 20)", default: 20 },
      },
      required: ["stock_code"],
    },
  },
  {
    name: "get_disclosure_body",
    description: "공시 원문 본문 텍스트를 실시간으로 조회합니다. (OpenDart document.xml, 최대 10,000자)",
    inputSchema: {
      type: "object",
      properties: {
        rcept_no: { type: "string", description: "공시 접수번호 14자리 (query_disclosures에서 확인 가능)" },
      },
      required: ["rcept_no"],
    },
  },
  // ── OpenDart 실시간 ────────────────────────────────────
  {
    name: "get_corp_info",
    description: "종목코드(6자리)로 OpenDart 기업 기본정보를 조회합니다. 반환된 corp_code는 공시·재무·주주 조회에 사용됩니다.",
    inputSchema: {
      type: "object",
      properties: {
        stock_code: { type: "string", description: "종목코드 6자리 (예: 010060)" },
      },
      required: ["stock_code"],
    },
  },
  {
    name: "get_disclosures",
    description: "기업의 최근 공시 목록을 실시간 조회합니다. (OpenDart)",
    inputSchema: {
      type: "object",
      properties: {
        corp_code: { type: "string", description: "OpenDart corp_code 8자리" },
        days:  { type: "number", description: "최근 N일 (기본 90)", default: 90 },
        count: { type: "number", description: "조회 건수 (기본 20)", default: 20 },
        type:  { type: "string", description: "A:정기 B:주요사항 C:발행 D:지분 (빈칸=전체)" },
      },
      required: ["corp_code"],
    },
  },
  {
    name: "get_financials",
    description: "재무제표 주요 계정을 조회합니다. 연결 우선, 없으면 별도. (OpenDart)",
    inputSchema: {
      type: "object",
      properties: {
        corp_code:   { type: "string", description: "OpenDart corp_code 8자리" },
        year:        { type: "string", description: "사업연도 (예: 2025)" },
        report_code: { type: "string", description: "11011=사업보고서 11012=반기 11013=1분기 11014=3분기", default: "11011" },
      },
      required: ["corp_code", "year"],
    },
  },
  {
    name: "get_major_shareholders",
    description: "5% 이상 주요 주주 현황을 조회합니다. (OpenDart)",
    inputSchema: {
      type: "object",
      properties: {
        corp_code: { type: "string", description: "OpenDart corp_code 8자리" },
      },
      required: ["corp_code"],
    },
  },
  // ── 공공데이터포털 실시간 ──────────────────────────────
  {
    name: "get_stock_price",
    description: "종목코드로 최신 주가를 조회합니다. (공공데이터포털 실시간)",
    inputSchema: {
      type: "object",
      properties: {
        stock_code: { type: "string", description: "종목코드 6자리 (예: 010060)" },
        date:       { type: "string", description: "기준일자 YYYYMMDD (없으면 최근 영업일 자동)" },
      },
      required: ["stock_code"],
    },
  },
  {
    name: "get_stock_history",
    description: "기간별 일별 주가 이력을 조회합니다. (공공데이터포털 실시간)",
    inputSchema: {
      type: "object",
      properties: {
        stock_code: { type: "string", description: "종목코드 6자리" },
        start_date: { type: "string", description: "시작일자 YYYYMMDD" },
        end_date:   { type: "string", description: "종료일자 YYYYMMDD (없으면 오늘)" },
        count:      { type: "number", description: "조회 건수 (기본 30, 최대 100)", default: 30 },
      },
      required: ["stock_code", "start_date"],
    },
  },
  {
    name: "get_market_info",
    description: "KRX 상장종목 기본정보를 조회합니다. (공공데이터포털 실시간)",
    inputSchema: {
      type: "object",
      properties: {
        stock_code: { type: "string", description: "종목코드 6자리" },
        date:       { type: "string", description: "기준일자 YYYYMMDD (없으면 오늘)" },
      },
      required: ["stock_code"],
    },
  },
];

const server = new Server(
  { name: "dart-mcp", version: "2.3.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    // ── query_price (DB) ──────────────────────────────────
    if (name === "query_price") {
      requireStockCode(args.stock_code);
      const days  = Math.min(args.days ?? 30, 365);
      const since = daysAgo(days);
      const rows  = db().prepare(`
        SELECT date, close, open, high, low, volume, market_cap
        FROM prices
        WHERE stock_code = ? AND date >= ?
        ORDER BY date DESC
      `).all(args.stock_code, since);

      const stock = db().prepare("SELECT stock_name, market FROM stocks WHERE stock_code = ?").get(args.stock_code);
      if (!rows.length) throw new Error("저장된 주가 데이터 없음 — npm run batch 먼저 실행하세요");

      return ok({
        stock_code: args.stock_code,
        stock_name: stock?.stock_name,
        market:     stock?.market,
        period:     `${since} ~ ${today()}`,
        count:      rows.length,
        prices:     rows.map(r => ({
          date:       r.date,
          close:      num(r.close) + "원",
          open:       num(r.open)  + "원",
          high:       num(r.high)  + "원",
          low:        num(r.low)   + "원",
          volume:     num(r.volume) + "주",
          market_cap: num(r.market_cap) + "원",
        })),
      });
    }

    // ── query_disclosures (DB) ────────────────────────────
    if (name === "query_disclosures") {
      requireStockCode(args.stock_code);
      const limit = Math.min(args.limit ?? 20, 100);
      const rows  = db().prepare(`
        SELECT rcept_no, date, type, title, filer, url
        FROM disclosures
        WHERE stock_code = ?
        ORDER BY date DESC
        LIMIT ?
      `).all(args.stock_code, limit);

      if (!rows.length) throw new Error("저장된 공시 데이터 없음 — npm run batch 먼저 실행하세요");
      return ok({ stock_code: args.stock_code, count: rows.length, disclosures: rows });
    }

    // ── get_disclosure_body (실시간) ──────────────────────
    if (name === "get_disclosure_body") {
      const rcepNo = String(args.rcept_no ?? "").trim();
      if (!rcepNo) throw new Error("rcept_no 필요");

      // DB에 저장된 본문이 있으면 반환
      const cached = db().prepare("SELECT body FROM disclosures WHERE rcept_no = ?").get(rcepNo);
      if (cached?.body) return ok({ rcept_no: rcepNo, source: "cache", body: cached.body });

      // 실시간 조회
      const body = await fetchDisclosureBody(rcepNo);

      // DB에 저장
      db().prepare("UPDATE disclosures SET body = ? WHERE rcept_no = ?").run(body, rcepNo);

      return ok({ rcept_no: rcepNo, source: "live", body });
    }

    // ── get_corp_info ─────────────────────────────────────
    if (name === "get_corp_info") {
      requireStockCode(args.stock_code);
      const corpCode = await stockToCorpCode(args.stock_code);
      const d = await dart("company.json", { corp_code: corpCode });
      return ok({
        corp_code:    d.corp_code,
        corp_name:    d.corp_name,
        stock_code:   d.stock_code,
        market:       d.corp_cls === "Y" ? "KOSPI" : d.corp_cls === "K" ? "KOSDAQ" : d.corp_cls,
        ceo:          d.ceo_nm,
        industry:     d.induty_code,
        established:  d.est_dt,
        fiscal_month: d.acc_mt,
        employees:    d.enpempecnt,
        address:      d.adres,
        homepage:     d.hm_url,
      });
    }

    // ── get_disclosures ───────────────────────────────────
    if (name === "get_disclosures") {
      requireCorpCode(args.corp_code);
      const params = {
        corp_code:  args.corp_code,
        bgn_de:     daysAgo(args.days ?? 90),
        end_de:     today(),
        sort:       "date",
        sort_mth:   "desc",
        page_count: String(Math.min(args.count ?? 20, 100)),
      };
      if (args.type) params.pblntf_ty = args.type;
      const d    = await dart("list.json", params);
      const list = d.list ?? [];
      return ok({
        period:      `${params.bgn_de} ~ ${params.end_de}`,
        total:       list.length,
        disclosures: list.map(r => ({
          rcept_no: r.rcept_no,
          date:  r.rcept_dt,
          type:  r.pblntf_ty_nm,
          title: r.report_nm,
          filer: r.flr_nm,
          url:   `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${r.rcept_no}`,
        })),
      });
    }

    // ── get_financials ────────────────────────────────────
    if (name === "get_financials") {
      requireCorpCode(args.corp_code);
      requireYear(args.year);
      let data, fsType = "연결재무제표";
      try {
        data = await dart("fnlttSinglAcntAll.json", {
          corp_code: args.corp_code, bsns_year: args.year,
          reprt_code: args.report_code ?? "11011", fs_div: "CFS",
        });
      } catch (e) {
        console.error(`[dart-mcp] CFS 조회 실패, OFS 폴백: ${e.message}`);
        data = await dart("fnlttSinglAcntAll.json", {
          corp_code: args.corp_code, bsns_year: args.year,
          reprt_code: args.report_code ?? "11011", fs_div: "OFS",
        });
        fsType = "별도재무제표";
      }
      const KEY  = ["매출액","영업이익","당기순이익","이익잉여금",
                    "자산총계","부채총계","자본총계",
                    "영업활동현금흐름","투자활동현금흐름","재무활동현금흐름"];
      const list = data.list ?? [];
      const rows = list.filter(r => KEY.some(k => (r.account_nm ?? "").includes(k)));
      return ok({
        year: args.year, fs_type: fsType, unit: "원",
        accounts: (rows.length ? rows : list.slice(0, 15)).map(r => ({
          account:  r.account_nm,
          current:  r.thstrm_amount,
          previous: r.frmtrm_amount,
          before:   r.bfefrmtrm_amount,
        })),
      });
    }

    // ── get_major_shareholders ────────────────────────────
    if (name === "get_major_shareholders") {
      requireCorpCode(args.corp_code);
      const d = await dart("majorstock.json", { corp_code: args.corp_code });
      return ok({
        shareholders: (d.list ?? []).map(r => ({
          name:       r.nm,
          relation:   r.relate,
          stock_kind: r.stock_knd,
          shares:     r.trmend_posesn_stock_co,
          ratio:      r.trmend_posesn_stock_qota_rt,
          as_of:      r.trmend_date,
        })),
      });
    }

    // ── get_stock_price ───────────────────────────────────
    if (name === "get_stock_price") {
      requireStockCode(args.stock_code);
      optionalDate(args.date);
      const endDt = args.date ?? today();
      const body  = await pub(
        "GetStockSecuritiesInfoService", "getStockPriceInfo",
        { numOfRows: 200, pageNo: 1, beginBasDt: daysAgo(10), endBasDt: endDt, srtnCd: args.stock_code }
      );
      const list = filterBySrtn(toList(body?.items?.item), args.stock_code);
      if (!list.length) throw new Error("주가 데이터 없음 (휴장일이거나 날짜 재확인 필요)");
      const r = list.sort((a, b) => b.basDt.localeCompare(a.basDt))[0];
      return ok({
        date:          r.basDt,
        stock_code:    r.srtnCd,
        stock_name:    r.itmsNm,
        market:        r.mrktCtg,
        close:         num(r.clpr)  + "원",
        change:        r.vs + "원",
        change_rate:   r.fltRt + "%",
        open:          num(r.mkp)  + "원",
        high:          num(r.hipr) + "원",
        low:           num(r.lopr) + "원",
        volume:        num(r.trqu) + "주",
        trade_value:   num(r.trPrc)     + "원",
        listed_shares: num(r.lstgStCnt) + "주",
        market_cap:    num(r.mrktTotAmt) + "원",
      });
    }

    // ── get_stock_history ─────────────────────────────────
    if (name === "get_stock_history") {
      requireStockCode(args.stock_code);
      if (!reDate.test(String(args.start_date ?? ""))) throw new Error("start_date는 YYYYMMDD 8자리여야 합니다");
      optionalDate(args.end_date);
      const want  = Math.min(args.count ?? 30, 100);
      const endDt = args.end_date ?? today();
      const body  = await pub(
        "GetStockSecuritiesInfoService", "getStockPriceInfo",
        { numOfRows: want * 10, pageNo: 1, beginBasDt: args.start_date, endBasDt: endDt, srtnCd: args.stock_code }
      );
      const sorted = filterBySrtn(toList(body?.items?.item), args.stock_code)
        .sort((a, b) => b.basDt.localeCompare(a.basDt))
        .slice(0, want);
      if (!sorted.length) throw new Error("해당 기간 데이터 없음");
      return ok({
        stock_code: args.stock_code,
        stock_name: sorted[0]?.itmsNm,
        period:     `${args.start_date} ~ ${endDt}`,
        count:      sorted.length,
        history:    sorted.map(r => ({
          date: r.basDt, close: r.clpr, change: r.vs, change_rate: r.fltRt + "%",
          open: r.mkp, high: r.hipr, low: r.lopr, volume: r.trqu, market_cap: r.mrktTotAmt,
        })),
      });
    }

    // ── get_market_info ───────────────────────────────────
    if (name === "get_market_info") {
      requireStockCode(args.stock_code);
      optionalDate(args.date);
      const baseDt = args.date ?? today();
      let list = [];
      for (const dt of [baseDt, daysAgo(3), daysAgo(7)]) {
        const body  = await pub("GetKrxListedInfoService", "getItemInfo",
          { numOfRows: 100, pageNo: 1, basDt: dt, srtnCd: args.stock_code });
        list = filterBySrtn(toList(body?.items?.item), args.stock_code);
        if (list.length) break;
      }
      if (!list.length) throw new Error("상장정보 없음");
      const r = list[0];
      return ok({ date: r.basDt, stock_code: r.srtnCd, isin: r.isinCd, stock_name: r.itmsNm, market: r.mrktCtg, corp_reg_no: r.crno, corp_name: r.corpNm });
    }

    throw new Error(`정의되지 않은 tool: ${name}`);

  } catch (e) {
    return { content: [{ type: "text", text: `오류: ${e.message}` }], isError: true };
  }
});

function ok(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[dart-mcp v2.3] 서버 시작 — OpenDart + 공공데이터포털 + 로컬 DB");
