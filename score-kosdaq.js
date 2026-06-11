/**
 * score-kosdaq.js
 * KOSDAQ 흑자기업 1009개 전체 점수 계산 → Top 10 출력
 * 실행: node score-kosdaq.js
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { ANALYSIS_YEAR, ANALYSIS_YEAR_FALLBACK, SCORE_BATCH_SIZE, SCORE_DELAY_MS, FETCH_TIMEOUT_MS } from "./config.js";
import { calcTargetPrice, buildRecommendation } from "./stock-utils.js";
import { parseFinancials, scoreFinancialTrend, disclosureSentiment, GOOD_KEYWORDS, BAD_KEYWORDS } from "./scoring-core.js";

const require   = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, ".env") });

const DART_KEY     = process.env.DART_API_KEY;
const PUBLIC_KEY   = process.env.PUBLIC_DATA_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DART_BASE    = "https://opendart.fss.or.kr/api";
const PUBLIC_BASE  = "https://apis.data.go.kr/1160100/service";
const YEAR         = ANALYSIS_YEAR;
const YEAR_FB      = ANALYSIS_YEAR_FALLBACK;
const BATCH_SIZE   = SCORE_BATCH_SIZE;
const DELAY_MS     = SCORE_DELAY_MS;

if (!DART_KEY || !PUBLIC_KEY) { console.error("DART_API_KEY 또는 PUBLIC_DATA_API_KEY 미설정"); process.exit(1); }

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const pad    = n => String(n).padStart(2, "0");
const ymd    = d => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
const daysAgo= n => { const d = new Date(); d.setDate(d.getDate()-n); return ymd(d); };
const today  = () => ymd(new Date());

async function fetchJson(url, headers = {}) {
  // node-fetch v3는 `timeout` 옵션을 무시 → AbortSignal.timeout 사용
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://finance.naver.com", ...headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── DART 재무 (100개 배치) ────────────────────────────────
async function getMultiFinancials(corpCodes, year, fsdiv) {
  const url = new URL(`${DART_BASE}/fnlttMultiAcnt.json`);
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("corp_code", corpCodes.join(","));
  url.searchParams.set("bsns_year", year);
  url.searchParams.set("reprt_code", "11011");
  url.searchParams.set("fs_div", fsdiv);
  const d = await fetchJson(url.toString(), {});
  if (!["000","013"].includes(d.status)) console.warn(`  DART오류 ${fsdiv}/${year}: ${d.status}`);
  return d.list ?? [];
}

async function batchFinancials(allCorpCodes) {
  let allRows = [];
  const batches = [];
  for (let i = 0; i < allCorpCodes.length; i += BATCH_SIZE)
    batches.push(allCorpCodes.slice(i, i + BATCH_SIZE));

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    process.stdout.write(`  재무배치 ${bi+1}/${batches.length} ... `);

    let list = await getMultiFinancials(batch, YEAR, "CFS");
    const f1 = new Set(list.map(r => r.corp_code));
    const m1 = batch.filter(c => !f1.has(c));
    if (m1.length) { const r2 = await getMultiFinancials(m1, YEAR, "OFS"); list=[...list,...r2]; }

    const f2 = new Set(list.map(r => r.corp_code));
    const m2 = batch.filter(c => !f2.has(c));
    if (m2.length) {
      let fb = await getMultiFinancials(m2, YEAR_FB, "CFS");
      const f3 = new Set(fb.map(r => r.corp_code));
      const m3 = m2.filter(c => !f3.has(c));
      if (m3.length) fb = [...fb, ...await getMultiFinancials(m3, YEAR_FB, "OFS")];
      list = [...list, ...fb];
    }

    allRows = [...allRows, ...list];
    console.log(`${list.length}건`);
    await sleep(300);
  }
  return allRows;
}

// parseFinancials → scoring-core.js 로 이동 (KOSPI/KOSDAQ 공통)

// ── 공공데이터포털 주식시세 API ───────────────────────────────
async function getPublicDataQuote(stockCode) {
  // likeIsinCd 필터 사용 (srtnCd는 서버측 필터링 미작동)
  const url = new URL(`${PUBLIC_BASE}/GetStockSecuritiesInfoService/getStockPriceInfo`);
  url.searchParams.set("serviceKey", PUBLIC_KEY);
  url.searchParams.set("resultType", "json");
  url.searchParams.set("numOfRows", "5");
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("beginBasDt", daysAgo(7));
  url.searchParams.set("endBasDt", today());
  url.searchParams.set("likeIsinCd", `KR7${stockCode}`);
  const data = await fetchJson(url.toString());
  const items = data?.response?.body?.items?.item ?? [];
  const arr = Array.isArray(items) ? items : [items];
  const item = arr
    .filter(r => r.srtnCd === stockCode)
    .sort((a, b) => b.basDt.localeCompare(a.basDt))[0];
  if (!item) return null;
  const price     = Number(item.clpr);
  const shares    = Number(item.lstgStCnt ?? 0);
  const marketCap = Number(item.mrktTotAmt) || (price * shares);
  return {
    price,
    eps:       Number(item.eps  ?? 0),
    bps:       Number(item.bps  ?? 0),
    shares,
    marketCap,
  };
}

// ── DART 공시 ─────────────────────────────────────────────
async function getDisclosures(corpCode) {
  const url = new URL(`${DART_BASE}/list.json`);
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bgn_de", daysAgo(30));
  url.searchParams.set("end_de", today());
  url.searchParams.set("sort", "date");
  url.searchParams.set("sort_mth", "desc");
  url.searchParams.set("page_count", "100");
  const d = await fetchJson(url.toString(), {});
  return d.list ?? [];
}

// ── DART 주요 주주 ─────────────────────────────────────────
async function getMajorShareholders(corpCode) {
  const url = new URL(`${DART_BASE}/majorstock.json`);
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", YEAR);
  url.searchParams.set("reprt_code", "11011");
  const d = await fetchJson(url.toString(), {});
  return d.list ?? [];
}

// ══════ 점수 계산 ══════════════════════════════════════════

function scoreFinancialHealth(fin) {
  let score = 0;
  if (fin.totalDebt && fin.totalEquity) {
    // 자본잠식(자본총계 ≤ 0)이면 부채비율 무의미 → 0점
    if (fin.totalEquity.current > 0) {
      const r = fin.totalDebt.current / fin.totalEquity.current * 100;
      score += r < 100 ? 10 : r < 200 ? 7 : r < 300 ? 3 : 0;
    }
  }
  if (fin.curAsset && fin.curLiab && fin.curLiab.current > 0) {
    const r = fin.curAsset.current / fin.curLiab.current * 100;
    score += r >= 200 ? 7 : r >= 100 ? 5 : 1;
  } else { score += 3; }
  if (fin.cfOps !== null && fin.cfOps !== undefined) { if (fin.cfOps > 0) score += 5; }
  if (fin.retained?.current > fin.retained?.previous) score += 3;
  return Math.min(25, score);
}

function scoreProfitability(fin) {
  let score = 0;
  if (fin.revenue) {
    const y1 = fin.revenue.previous > 0 ? (fin.revenue.current - fin.revenue.previous) / fin.revenue.previous * 100 : 0;
    const y2 = fin.revenue.before > 0 ? (fin.revenue.previous - fin.revenue.before) / fin.revenue.before * 100 : 0;
    const avg = (y1 + y2) / 2;
    score += avg > 15 ? 10 : avg > 5 ? 7 : avg > 0 ? 4 : 1;
  }
  if (fin.opIncome) {
    const yoy = fin.opIncome.previous > 0
      ? (fin.opIncome.current - fin.opIncome.previous) / Math.abs(fin.opIncome.previous) * 100
      : fin.opIncome.current > 0 ? 999 : -999;
    score += yoy > 20 ? 6 : yoy > 0 ? 4 : 1;
    if (fin.revenue?.current > 0) {
      const margin = fin.opIncome.current / fin.revenue.current * 100;
      score += margin > 15 ? 4 : margin > 7 ? 2 : 0;
    }
  }
  if (fin.netIncome) {
    const all3 = [fin.netIncome.current, fin.netIncome.previous, fin.netIncome.before].every(v => v > 0);
    score += all3 ? 5 : fin.netIncome.current > 0 ? 3 : 0;
  }
  return Math.min(25, score);
}

function scoreValuation(marketCap, netIncome, equity, eps, bps, price) {
  if (!marketCap || marketCap <= 0) return { score: 5, note: "시총없음" };
  let score = 0;
  const notes = [];
  const ni = netIncome ?? 0;
  if (ni > 0) {
    const per = marketCap / ni;
    let ps = 0;
    if (per < 5)       { ps = 12; notes.push(`PER${per.toFixed(1)}(극저평가)`); }
    else if (per < 10) { ps = 18; notes.push(`PER${per.toFixed(1)}(저평가)`); }
    else if (per < 15) { ps = 15; notes.push(`PER${per.toFixed(1)}(적정)`); }
    else if (per < 20) { ps = 10; notes.push(`PER${per.toFixed(1)}(다소고)`); }
    else if (per < 30) { ps = 5;  notes.push(`PER${per.toFixed(1)}(고평가)`); }
    else               { ps = 2;  notes.push(`PER${per.toFixed(1)}(과매수)`); }
    score += ps;
  } else { notes.push("순손실"); }

  const eq = equity > 0 ? equity : (bps > 0 && price > 0 ? bps * (marketCap / price) : 0);
  if (eq > 0) {
    const pbr = marketCap / eq;
    if (pbr < 0.5)    { score += 6; notes.push(`PBR${pbr.toFixed(2)}`); }
    else if (pbr < 1) { score += 5; notes.push(`PBR${pbr.toFixed(2)}`); }
    else if (pbr < 2) { score += 3; notes.push(`PBR${pbr.toFixed(2)}`); }
    else if (pbr < 4) { score += 1; notes.push(`PBR${pbr.toFixed(2)}`); }
    else              { notes.push(`PBR${pbr.toFixed(2)}(고)`); }
  }
  score += 3;
  return { score: Math.min(30, score), note: notes.join(", ") };
}

function scoreDisclosure(disclosures) {
  let good = 0, bad = 0;
  for (const d of disclosures) {
    const t = d.report_nm ?? "";
    if (GOOD_KEYWORDS.some(k => t.includes(k))) good++;
    if (BAD_KEYWORDS.some(k => t.includes(k))) bad++;
  }
  const cnt = disclosures.length;
  const base = cnt > 5 ? 5 : cnt > 2 ? 4 : cnt > 0 ? 2 : 0;
  return Math.max(0, Math.min(15, base + Math.min(7, good * 3) - Math.min(5, bad * 2) + 3));
}

function scoreShareholders(shareholders) {
  if (!shareholders.length) return { score: 6, note: "데이터없음" };
  const max = shareholders.reduce((m, s) => {
    const r = parseFloat(s.stkqty_irds_rt ?? s.trmend_posesn_stock_co ?? "0");
    return r > m.r ? { r, name: s.nm } : m;
  }, { r: 0, name: "" });
  let score = max.r >= 30 ? 6 : max.r >= 20 ? 4 : 2;
  const hasInst = shareholders.some(s => (s.nm ?? "").includes("기관") || parseFloat(s.stkqty_irds_rt ?? "0") > 5);
  if (hasInst) score += 3;
  score += 3;
  return { score: Math.min(12, score), note: `최대주주${max.r.toFixed(1)}%${hasInst ? ',기관보유' : ''}` };
}

// scoreFinancialTrend → scoring-core.js 로 이동 (KOSPI/KOSDAQ 공통)

// ══════ 메인 ═══════════════════════════════════════════════
async function main() {
  const useAll = process.argv.includes("--all");
  const listFile = useAll ? "kosdaq-all.json" : "kosdaq-profitable.json";
  const listKey  = useAll ? "all" : "profitable";
  const companies = JSON.parse(fs.readFileSync(path.join(__dirname, listFile), "utf8"))[listKey];
  const total = companies.length;
  console.log(`\n=== KOSDAQ ${useAll ? "전체" : "흑자기업"} ${total}개 전체 점수 계산 ===\n`);

  // 섹터 캐시 로드
  const sectorCacheFile = path.join(__dirname, ".sector_cache.json");
  const sectorMap = fs.existsSync(sectorCacheFile)
    ? JSON.parse(fs.readFileSync(sectorCacheFile, "utf8"))
    : {};

  // 1. DART 재무 전체 배치
  console.log("[1] DART 재무 일괄 수집...");
  const allCorpCodes = companies.map(s => s.corp_code);
  const finRows = await batchFinancials(allCorpCodes);
  const finMap = {};
  for (const s of companies) {
    finMap[s.corp_code] = parseFinancials(finRows.filter(r => r.corp_code === s.corp_code));
  }
  console.log(`  완료: ${Object.keys(finMap).length}개\n`);

  // 이력 재무 조회 (다년도 추세 점수용)
  console.log("[2.5] DB 이력 재무 조회...");
  const historyMap = await fetchHistoricalFinancials(companies.map(s => s.stockCode));
  console.log(`  이력 보유 종목: ${Object.keys(historyMap).length}개\n`);

  // 2. 종목별 가격 + DART 공시
  console.log("[2] 종목별 가격·공시 수집 중...\n");
  const RUN_ID = `kosdaq-${ymd(new Date())}-${Date.now()}`;
  const results = [];
  const failCounts = { quote: 0, disclosure: 0, shareholder: 0 };
  const CHECKPOINT = 50;
  const analysisBatch = [];
  const finBatch = [];
  const histBatch = [];
  const discBatch = [];

  async function upsertTable(table, rows) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !rows.length) return;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) console.warn(`  ${table} upsert 실패: ${res.status}`);
  }

  async function appendTable(table, rows) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !rows.length) return;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) console.warn(`  ${table} insert 실패: ${res.status}`);
  }

  async function fetchHistoricalFinancials(stockCodes) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return {};
    const result = {};
    const BATCH = 200;
    for (let i = 0; i < stockCodes.length; i += BATCH) {
      const chunk = stockCodes.slice(i, i + BATCH);
      const url = `${SUPABASE_URL}/rest/v1/stock_financials`
        + `?stock_code=in.(${chunk.join(",")})`
        + `&analysis_year=lt.${YEAR}`
        + `&report_code=eq.11011`
        + `&order=analysis_year.desc`
        + `&select=stock_code,analysis_year,revenue,op_income,net_income,debt_ratio,cur_ratio,cf_ops`;
      const res = await fetch(url, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      if (!res.ok) continue;
      const rows = await res.json();
      for (const row of rows) {
        if (!result[row.stock_code]) result[row.stock_code] = [];
        result[row.stock_code].push(row);
      }
    }
    return result;
  }

  async function flushDisclosures(batch) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !batch.length) return;
    const valid = batch.filter(d => d.rcept_no);
    if (!valid.length) return;

    const masterRows = valid.map(({ _sentiment_score, ...rest }) => rest);
    const r1 = await fetch(`${SUPABASE_URL}/rest/v1/stock_disclosures?on_conflict=rcept_no`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify(masterRows),
    });
    if (!r1.ok) console.warn(`  stock_disclosures insert 실패: ${r1.status}`);

    const sentRows = valid.map(d => ({
      rcept_no:          d.rcept_no,
      sentiment_score:   d._sentiment_score,
      sentiment_model:   "keyword-v1",
      sentiment_version: "keyword-v1",
      analyzed_at:       new Date().toISOString(),
    }));
    const r2 = await fetch(`${SUPABASE_URL}/rest/v1/stock_disclosure_sentiments?on_conflict=rcept_no,sentiment_version`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify(sentRows),
    });
    if (!r2.ok) console.warn(`  stock_disclosure_sentiments insert 실패: ${r2.status}`);
  }

  for (let i = 0; i < companies.length; i++) {
    const s = companies[i];
    const fin = finMap[s.corp_code] ?? {};

    let quote = null, disclosures = [], shareholders = [];

    try { quote = await getPublicDataQuote(s.stockCode); } catch { failCounts.quote++; }
    await sleep(150);
    try { disclosures = await getDisclosures(s.corp_code); } catch { failCounts.disclosure++; }
    try { shareholders = await getMajorShareholders(s.corp_code); } catch { failCounts.shareholder++; }
    await sleep(DELAY_MS);

    const marketCap  = quote?.marketCap ?? 0;
    const netIncome  = fin.netIncome?.current ?? null;
    const equity     = fin.totalEquity?.current ?? 0;

    const h = scoreFinancialHealth(fin);
    const p = scoreProfitability(fin);
    const v = scoreValuation(marketCap, netIncome, equity, quote?.eps ?? 0, quote?.bps ?? 0, quote?.price ?? 0);
    const d = scoreDisclosure(disclosures);
    const govScore = scoreShareholders(shareholders);
    const trend    = scoreFinancialTrend(historyMap[s.stockCode]);

    const longScore  = h + p + v.score + govScore.score + (trend.score ?? 0);
    const totalScore = longScore + d;
    const currentPrice = quote?.price ?? 0;
    const genAt = new Date().toISOString();

    const tp = calcTargetPrice(currentPrice, quote?.eps ?? 0, quote?.bps ?? 0, fin, marketCap);
    const recommendation = buildRecommendation(longScore, v.note, tp.midTargetPct);

    const _ni  = fin.netIncome?.current  ?? 0;
    const _eq  = fin.totalEquity?.current ?? 0;
    const _rev = fin.revenue?.current    ?? 0;
    const _op  = fin.opIncome?.current   ?? 0;

    const detail = {
      단기_공시이벤트:   { score: d,            max: 15, note: `공시${disclosures.length}건` },
      중장기_재무건전성: { score: h,             max: 25, note: "" },
      중장기_수익성:     { score: p,             max: 25, note: "" },
      중장기_밸류에이션: { score: v.score,       max: 30, note: v.note },
      중장기_지배구조:   { score: govScore.score, max: 12, note: govScore.note },
      다년도_성장흐름:   { score: trend.score,   max: 18, note: trend.note },
    };

    results.push({
      rank: 0,
      stockCode:        s.stockCode,
      corp_name:        s.corp_name,
      currentPrice,
      shortTargetPrice: tp.shortTargetPrice,
      midTargetPrice:   tp.midTargetPrice,
      shortTargetPct:   tp.shortTargetPct,
      midTargetPct:     tp.midTargetPct,
      recommendation,
      marketCapTril:    +(marketCap / 1e12).toFixed(2),
      totalScore,
      shortScore:       d,
      longScore,
      generatedAt:      genAt,
      disclosureScore:  d,
      valNote:          v.note,
      opIncomeTril:     +((s.operatingIncome ?? 0) / 1e12).toFixed(3),
      detail,
    });

    // stock_analysis 배치
    const analysisRow = {
      stock_code: s.stockCode, corp_name: s.corp_name,
      current_price: currentPrice,
      short_target_price: tp.shortTargetPrice, mid_target_price: tp.midTargetPrice,
      short_target_pct: tp.shortTargetPct, mid_target_pct: tp.midTargetPct,
      recommendation, market_cap_tril: +(marketCap / 1e12).toFixed(2),
      mrkt_ctg: "KOSDAQ",
      sector: sectorMap[s.stockCode]?.sector ?? null,
      total_score: totalScore, short_score: d, long_score: longScore,
      detail, generated_at: genAt, updated_at: genAt,
      analysis_run_id: RUN_ID,
    };
    analysisBatch.push(analysisRow);
    const { updated_at: _ua, sector: _sec, ...histRow } = analysisRow;
    histBatch.push({ ...histRow, snapshot_at: genAt });

    // stock_financials 배치
    finBatch.push({
      stock_code:    s.stockCode,
      corp_name:     s.corp_name,
      mrkt_ctg:      "KOSDAQ",
      per:           _ni > 0 && marketCap > 0 ? +(marketCap / _ni).toFixed(2) : null,
      pbr:           _eq > 0 && marketCap > 0 ? +(marketCap / _eq).toFixed(2) : null,
      roe:           _ni > 0 && _eq > 0       ? +(_ni / _eq * 100).toFixed(2)  : null,
      debt_ratio:    fin.totalDebt?.current && _eq > 0
                       ? +(fin.totalDebt.current / _eq * 100).toFixed(2) : null,
      cur_ratio:     fin.curAsset?.current && fin.curLiab?.current > 0
                       ? +(fin.curAsset.current / fin.curLiab.current * 100).toFixed(2) : null,
      op_margin:     _op && _rev > 0 ? +(_op / _rev * 100).toFixed(2) : null,
      revenue_yoy:   fin.revenue?.previous > 0
                       ? +((_rev - fin.revenue.previous) / fin.revenue.previous * 100).toFixed(2) : null,
      op_income_yoy: fin.opIncome?.previous !== 0 && fin.opIncome?.previous != null
                       ? +((_op - fin.opIncome.previous) / Math.abs(fin.opIncome.previous) * 100).toFixed(2) : null,
      net_income:    _ni  || null,
      total_equity:  _eq  || null,
      total_debt:    fin.totalDebt?.current  || null,
      total_asset:   fin.totalAsset?.current || null,
      revenue:       _rev || null,
      op_income:     _op  || null,
      market_cap:    marketCap || null,
      cf_ops:        fin.cfOps ?? null,
      analysis_year: YEAR,
      updated_at:    genAt,
    });

    if (analysisBatch.length >= 50) await upsertTable("stock_analysis",           analysisBatch.splice(0));
    if (finBatch.length      >= 50) await upsertTable("stock_financials",          finBatch.splice(0));
    if (histBatch.length     >= 50) await appendTable("stock_analysis_history",    histBatch.splice(0));

    for (const disc of disclosures) {
      const t = disc.report_nm ?? "";
      const sentScore = disclosureSentiment(t).score;
      discBatch.push({
        rcept_no:         disc.rcept_no ?? null,
        stock_code:       s.stockCode,
        rcept_dt:         disc.rcept_dt ?? null,
        report_nm:        t,
        report_type:      null,
        _sentiment_score: sentScore,
      });
    }
    if (discBatch.length >= 100) await flushDisclosures(discBatch.splice(0));

    if ((i + 1) % CHECKPOINT === 0 || i === companies.length - 1) {
      const pct = (((i+1)/total)*100).toFixed(1);
      console.log(`  [${i+1}/${total}] ${pct}% 완료 — 현재 최고점: ${Math.max(...results.map(r=>r.totalScore))}점`);
    }
  }

  if (analysisBatch.length) await upsertTable("stock_analysis",        analysisBatch);
  if (finBatch.length)      await upsertTable("stock_financials",       finBatch);
  if (histBatch.length)     await appendTable("stock_analysis_history", histBatch);
  if (discBatch.length)     await flushDisclosures(discBatch);

  // 3. 랭킹 + 저장
  results.sort((a, b) => b.totalScore - a.totalScore);
  results.forEach((r, i) => r.rank = i + 1);

  fs.writeFileSync(
    path.join(__dirname, "scored-kosdaq.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), total, results }, null, 2)
  );

  // 4. TOP 10 출력
  console.log("\n" + "═".repeat(100));
  console.log("  KOSDAQ TOP 10");
  console.log("═".repeat(100));
  console.log(`${"순위".padEnd(4)} ${"코드".padEnd(8)} ${"기업명".padEnd(20)} ${"총점".padEnd(6)} ${"시총(조)".padEnd(8)} 밸류에이션`);
  console.log("─".repeat(100));
  for (const r of results.filter(r => r.midTargetPct > 0).slice(0, 10)) {
    console.log([
      String(r.rank).padEnd(4),
      r.stockCode.padEnd(8),
      r.corp_name.slice(0, 18).padEnd(20),
      String(r.totalScore).padEnd(6),
      String(r.marketCapTril).padEnd(8),
      r.valNote,
    ].join(" "));
  }
  console.log("\n저장: scored-kosdaq.json");
  console.log(`수집 실패 — 시세:${failCounts.quote} 공시:${failCounts.disclosure} 주주:${failCounts.shareholder}`);
}

main().catch(e => { console.error("오류:", e); process.exit(1); });
