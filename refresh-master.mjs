/**
 * refresh-master.mjs - 종목 마스터(stocks) · 점수 입력 목록 · sector_stats 정기 갱신 (2026-10-01).
 *
 * 배경: stocks / sector_stats 는 2026-05-23 이후 갱신 경로가 없었다(레포에 쓰는 코드 없음, 일회성 수작업 추정).
 *       점수 스크립트(score-kospi-full.js / score-kosdaq.js)의 입력 목록(kospi-all.json 등)도 gitignore 라 CI 에는 없었다.
 *
 * 모드(복수 지정 가능, 아무것도 없으면 --stocks --sector-stats):
 *   --stocks        공공데이터포털 주식시세(상장 종목 전체, 최근 영업일)와 stocks 를 대조해
 *                   * 신규 보통주(코드 끝자리 0, DART corp_code 있음)를 stocks 에 INSERT (ON CONFLICT DO NOTHING - 추가 전용)
 *                   * 상장폐지 후보(stocks 에 있으나 시세 API 에 없음)는 로그만 남기고 값은 건드리지 않는다
 *                   * 점수 스크립트 입력 kospi-all.json / kosdaq-all.json 과 .sector_cache.json(없을 때만, DB 섹터 기준) 생성
 *   --sector-stats  stock_analysis(섹터·총점) + stock_financials(2025 연간) 로 sector_stats 재계산 (UPSERT)
 *   --dry           DB 쓰기 생략, 건수만 출력
 *
 * env: PUBLIC_DATA_API_KEY, DART_API_KEY, SUPABASE_MANAGEMENT_KEY, SUPABASE_PROJECT_REF
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

/** 보통주 판정: 6자리 숫자 코드이고 끝자리 0 (우선주는 5·7·K 등, 리츠/ETN 등 영문 혼합 코드 제외). 순수 함수. */
export function isCommonStockCode(code) {
  return /^\d{5}0$/.test(String(code));
}

/** 시세 API 결과 vs stocks 대조. 순수 함수. */
export function diffUniverse(apiItems, dbCodes) {
  const dbSet = new Set(dbCodes);
  const apiSet = new Set(apiItems.map((x) => x.c));
  const added = apiItems.filter((x) => !dbSet.has(x.c) && isCommonStockCode(x.c));
  const missing = [...dbSet].filter((c) => !apiSet.has(c));
  return { added, missing };
}

const esc = (s) => String(s).replace(/'/g, "''");

async function main() {
  const argv = process.argv.slice(2);
  const DRY = argv.includes("--dry");
  const doSector = argv.includes("--sector-stats");
  const doStocks = argv.includes("--stocks") || !doSector;
  const both = !argv.includes("--stocks") && !doSector;

  const MGMT_KEY = process.env.SUPABASE_MANAGEMENT_KEY, REF = process.env.SUPABASE_PROJECT_REF;
  if (!MGMT_KEY || !REF) { console.error("SUPABASE_MANAGEMENT_KEY/PROJECT_REF 미설정"); process.exit(1); }
  const q = async (sql) => {
    const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
      method: "POST", headers: { Authorization: `Bearer ${MGMT_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(120_000),
    });
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error(data?.message ?? "DB 쿼리 오류");
    return data;
  };

  if (doStocks || both) await refreshStocks(q, DRY);
  if (doSector || both) await refreshSectorStats(q, DRY);
}

async function fetchListed(basDt, market, key) {
  const u = new URL("https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo");
  u.searchParams.set("serviceKey", key); u.searchParams.set("resultType", "json");
  u.searchParams.set("numOfRows", "3000"); u.searchParams.set("pageNo", "1");
  u.searchParams.set("basDt", basDt); u.searchParams.set("mrktCls", market);
  let lastErr;
  for (let a = 1; a <= 3; a++) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const b = j?.response?.body;
      if (!b) throw new Error("응답 형식 오류");
      const items = b.items?.item ?? b.items ?? [];
      return (Array.isArray(items) ? items : [items]).filter((i) => i?.srtnCd)
        .map((i) => ({ c: i.srtnCd, n: i.itmsNm, m: i.mrktCtg }));
    } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, a * 2000)); }
  }
  throw lastErr;
}

async function refreshStocks(q, DRY) {
  const key = process.env.PUBLIC_DATA_API_KEY;
  if (!key) throw new Error("PUBLIC_DATA_API_KEY 미설정");
  // 최근 영업일 탐색: 오늘(KST)부터 최대 10일 전까지
  let basDt = null, kospi = [], kosdaq = [];
  for (let back = 0; back <= 10 && !basDt; back++) {
    const d = new Date(Date.now() + 9 * 3600000 - back * 86400000).toISOString().slice(0, 10).replaceAll("-", "");
    const k = await fetchListed(d, "KOSPI", key);
    if (k.length > 500) { basDt = d; kospi = k; kosdaq = await fetchListed(d, "KOSDAQ", key); }
  }
  if (!basDt) throw new Error("시세 API 에서 최근 영업일 데이터를 찾지 못함");
  const api = [...kospi, ...kosdaq];
  if (api.length < 2000) throw new Error(`시세 API 종목 수 이상: ${api.length}`);
  console.log(`[stocks] 기준일 ${basDt}: KOSPI ${kospi.length} / KOSDAQ ${kosdaq.length}`);

  const db = await q("SELECT stock_code, corp_name, mrkt_ctg, is_listed FROM stocks");
  const { added, missing } = diffUniverse(api, db.map((r) => r.stock_code));

  const { buildCorpCodeMap } = await import("./dart-financials-backfill.js");
  const corpMap = await buildCorpCodeMap();

  const addable = added.filter((x) => corpMap[x.c]);
  console.log(`[stocks] 신규 보통주 후보 ${added.length} (DART corp_code 있음 ${addable.length}) / 상장폐지 후보(시세 API 에 없음) ${missing.length} - 값 변경 안 함`);
  if (addable.length) console.log("  신규:", addable.slice(0, 30).map((x) => `${x.c}${x.n}`).join(", "));
  if (missing.length) console.log("  폐지후보:", missing.slice(0, 40).join(","));

  if (addable.length && !DRY) {
    const vals = addable.map((x) => `('${esc(x.c)}','${esc(x.n)}','${esc(x.m)}',true,now(),now())`).join(",");
    const r = await q(`INSERT INTO stocks (stock_code, corp_name, mrkt_ctg, is_listed, created_at, updated_at) VALUES ${vals}
      ON CONFLICT (stock_code) DO NOTHING RETURNING stock_code`);
    console.log(`[stocks] INSERT ${r.length}건`);
  }

  // 점수 스크립트 입력 목록: (stocks ∪ 신규) ∩ 시세 API (폐지 후보 제외), corp_code 있는 것만
  const apiSet = new Map(api.map((x) => [x.c, x]));
  const universe = new Map();
  for (const r of db) if (apiSet.has(r.stock_code) && r.is_listed !== false) universe.set(r.stock_code, { name: r.corp_name, m: r.mrkt_ctg });
  for (const x of addable) universe.set(x.c, { name: x.n, m: x.m });
  const lists = { KOSPI: [], KOSDAQ: [] };
  let noCorp = 0;
  for (const [code, v] of [...universe].sort()) {
    if (!corpMap[code]) { noCorp++; continue; }
    lists[v.m]?.push({ stockCode: code, corp_name: v.name, corp_code: corpMap[code] });
  }
  fs.writeFileSync(path.join(__dirname, "kospi-all.json"), JSON.stringify({ all: lists.KOSPI }));
  fs.writeFileSync(path.join(__dirname, "kosdaq-all.json"), JSON.stringify({ all: lists.KOSDAQ }));
  console.log(`[stocks] 점수 입력 목록: KOSPI ${lists.KOSPI.length} / KOSDAQ ${lists.KOSDAQ.length} (corp_code 없음 제외 ${noCorp})`);

  // 섹터 캐시: 파일이 없을 때만 DB 섹터로 생성 (점수 스크립트가 sector 를 null 로 덮어쓰는 것 방지)
  const sc = path.join(__dirname, ".sector_cache.json");
  if (!fs.existsSync(sc)) {
    const rows = await q("SELECT stock_code, sector FROM stock_analysis WHERE sector IS NOT NULL");
    fs.writeFileSync(sc, JSON.stringify(Object.fromEntries(rows.map((r) => [r.stock_code, { sector: r.sector }]))));
    console.log(`[stocks] .sector_cache.json 생성 (DB 섹터 ${rows.length}건)`);
  } else console.log("[stocks] .sector_cache.json 기존 파일 유지");
}

export const SECTOR_STATS_SQL = `
INSERT INTO sector_stats (sector, mrkt_ctg, company_count, avg_total_score, avg_pbr, avg_per, avg_roe, avg_op_margin, avg_debt_ratio, median_market_cap_tril, updated_at)
SELECT sa.sector, sa.mrkt_ctg, count(*),
  round(avg(sa.total_score)::numeric, 2), round(avg(sf.pbr)::numeric, 2),
  round((avg(sf.per) FILTER (WHERE sf.per > 0 AND sf.per <= 100))::numeric, 2),
  round(avg(sf.roe)::numeric, 2), round(avg(sf.op_margin)::numeric, 2), round(avg(sf.debt_ratio)::numeric, 2),
  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY sa.market_cap_tril))::numeric, 2), now()
FROM stock_analysis sa
LEFT JOIN stock_financials sf ON sf.stock_code = sa.stock_code AND sf.analysis_year = 2025 AND sf.quarter IS NULL
WHERE sa.sector IS NOT NULL
GROUP BY sa.sector, sa.mrkt_ctg
ON CONFLICT (sector, mrkt_ctg) DO UPDATE SET
  company_count = EXCLUDED.company_count, avg_total_score = EXCLUDED.avg_total_score, avg_pbr = EXCLUDED.avg_pbr,
  avg_per = EXCLUDED.avg_per, avg_roe = EXCLUDED.avg_roe, avg_op_margin = EXCLUDED.avg_op_margin,
  avg_debt_ratio = EXCLUDED.avg_debt_ratio, median_market_cap_tril = EXCLUDED.median_market_cap_tril, updated_at = now()
RETURNING sector`;

async function refreshSectorStats(q, DRY) {
  if (DRY) { console.log("[sector_stats] --dry: 생략"); return; }
  const r = await q(SECTOR_STATS_SQL);
  console.log(`[sector_stats] UPSERT ${r.length}행`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("[refresh-master] 오류:", e.message); process.exit(1); });
}
