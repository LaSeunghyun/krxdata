/**
 * score-kospi-full.js
 * KOSPI 흑자기업 전체(672개) 점수 계산 → Top 10 출력 + DB upsert
 *
 * 운영 API 전제: PUBLIC_DATA_API_KEY (srtnCd 필터 정상 동작)
 * 실행: node score-kospi-full.js
 * 결과: scored-kospi-full.json
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { ANALYSIS_YEAR, ANALYSIS_YEAR_FALLBACK, SCORE_BATCH_SIZE, SCORE_DELAY_MS } from "./config.js";
import { calcTargetPrice, buildRecommendation } from "./stock-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const DART_KEY   = process.env.DART_API_KEY;
const PUBLIC_KEY = process.env.PUBLIC_DATA_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const DART_BASE   = "https://opendart.fss.or.kr/api";
const PUBLIC_BASE = "https://apis.data.go.kr/1160100/service";
const YEAR        = ANALYSIS_YEAR;
const YEAR_FB     = ANALYSIS_YEAR_FALLBACK;
const BATCH_SIZE  = SCORE_BATCH_SIZE;
const DELAY_MS    = SCORE_DELAY_MS;

if (!DART_KEY)   { console.error("DART_API_KEY 미설정"); process.exit(1); }
if (!PUBLIC_KEY) { console.error("PUBLIC_DATA_API_KEY 미설정"); process.exit(1); }

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const pad    = n => String(n).padStart(2, "0");
const ymd    = d => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
const today  = () => ymd(new Date());
const daysAgo= n => { const d = new Date(); d.setDate(d.getDate()-n); return ymd(d); };

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", ...opts.headers }, timeout: 20000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── DART 재무 배치 ────────────────────────────────────────
async function getMultiFinancials(corpCodes, year, fsdiv) {
  const url = new URL(`${DART_BASE}/fnlttMultiAcnt.json`);
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("corp_code", corpCodes.join(","));
  url.searchParams.set("bsns_year", year);
  url.searchParams.set("reprt_code", "11011");
  url.searchParams.set("fs_div", fsdiv);
  const d = await fetchJson(url.toString());
  if (!["000","013"].includes(d.status)) console.warn(`  DART ${fsdiv}/${year}: ${d.status}`);
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

function parseFinancials(rows) {
  const get = (...names) => {
    for (const nm of names) {
      const row = rows.find(r => r.account_nm?.trim() === nm && r.sj_div !== "CF");
      if (row) return {
        current:  Number(String(row.thstrm_amount  ?? "0").replace(/,/g, "")),
        previous: Number(String(row.frmtrm_amount  ?? "0").replace(/,/g, "")),
        before:   Number(String(row.bfefrmtrm_amount??"0").replace(/,/g, "")),
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
    retained:    get("이익잉여금"),
    cfOps:       getCF("영업활동현금흐름"),
  };
}

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

// ── DART 공시 ────────────────────────────────────────────
async function getDisclosures(corpCode) {
  const url = new URL(`${DART_BASE}/list.json`);
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bgn_de", daysAgo(30));
  url.searchParams.set("end_de", today());
  url.searchParams.set("sort", "date");
  url.searchParams.set("sort_mth", "desc");
  url.searchParams.set("page_count", "100");
  const d = await fetchJson(url.toString());
  return d.list ?? [];
}

// ── 주요 주주 ─────────────────────────────────────────────
async function getMajorShareholders(corpCode) {
  const url = new URL(`${DART_BASE}/majorstock.json`);
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", YEAR);
  url.searchParams.set("reprt_code", "11011");
  const d = await fetchJson(url.toString());
  return d.list ?? [];
}

// ══════ 점수 계산 ═════════════════════════════════════════

function scoreMomentum(history) {
  if (history.length < 20) return { score: 0, note: "데이터부족" };
  const closes = history.map(r => Number(r.clpr));
  const cur = closes[closes.length - 1];
  const ma5  = closes.slice(-5).reduce((s,v)=>s+v,0) / 5;
  const ma20 = closes.slice(-20).reduce((s,v)=>s+v,0) / 20;
  const ma60 = closes.length >= 60 ? closes.slice(-60).reduce((s,v)=>s+v,0)/60 : null;
  let aligned = 0;
  if (cur > ma5) aligned++;
  if (ma5 > ma20) aligned++;
  if (ma60 && ma20 > ma60) aligned++;
  const hi52 = Math.max(...closes), lo52 = Math.min(...closes);
  const pos52 = hi52 > lo52 ? (cur - lo52) / (hi52 - lo52) : 0.5;
  const dir5  = closes[closes.length-1] > closes[closes.length-6] ? 1 : 0;
  const maScore  = aligned >= 3 ? 15 : aligned >= 2 ? 10 : aligned >= 1 ? 5 : 0;
  const posScore = pos52 > 0.7 ? 10 : pos52 > 0.5 ? 7 : pos52 > 0.3 ? 4 : 2;
  return { score: maScore + posScore + (dir5 ? 5 : 0), note: `MA정배열${aligned}/3, 52주${(pos52*100).toFixed(0)}%` };
}

function scoreVolume(history) {
  if (history.length < 20) return { score: 0, note: "데이터부족" };
  const vol20avg = history.slice(-20).reduce((s,r)=>s+Number(r.trqu),0)/20;
  const vol5avg  = history.slice(-5).reduce((s,r)=>s+Number(r.trqu),0)/5;
  const ratio    = vol20avg > 0 ? vol5avg / vol20avg : 1;
  const burst    = history.slice(-5).some(r => Number(r.trqu) > vol20avg * 2);
  const ratioScore = ratio>1.5?15:ratio>1.2?12:ratio>0.8?8:4;
  return { score: ratioScore + (burst?7:3) + (vol5avg>vol20avg?3:0), note: `거래량비율${ratio.toFixed(2)}x${burst?' 급증':''}` };
}

function scoreVolatility(history) {
  if (history.length < 20) return { score: 0, note: "데이터부족" };
  const h20 = history.slice(-20);
  const range20pct = (Math.max(...h20.map(r=>Number(r.hipr))) - Math.min(...h20.map(r=>Number(r.lopr)))) / Math.min(...h20.map(r=>Number(r.lopr))) * 100;
  const closes = h20.map(r=>Number(r.clpr));
  let peak = closes[0], mdd = 0;
  for (const c of closes) { peak=Math.max(peak,c); mdd=Math.min(mdd,(c-peak)/peak*100); }
  const rangeScore = range20pct<15?12:range20pct<25?9:range20pct<35?5:2;
  return { score: rangeScore + (mdd>-5?8:mdd>-10?6:mdd>-20?3:0), note: `변동폭${range20pct.toFixed(1)}%,MDD${mdd.toFixed(1)}%` };
}

function scoreDisclosure(disclosures) {
  const GOOD = ["자기주식","수주","실적","흑자","배당","취득"];
  const BAD  = ["유상증자","소송","대주주매도","적자","불성실"];
  let good=0, bad=0;
  for (const d of disclosures) {
    const t = d.report_nm ?? "";
    if (GOOD.some(k=>t.includes(k))) good++;
    if (BAD.some(k=>t.includes(k)))  bad++;
  }
  const cnt = disclosures.length;
  return { score: Math.max(0,Math.min(15,(cnt>5?5:cnt>2?4:cnt>0?2:0)+Math.min(7,good*3)-Math.min(5,bad*2)+3)),
           note: `공시${cnt}건(호재${good}/악재${bad})` };
}

function scoreFinancialHealth(fin) {
  let score=0; const notes=[];
  if (fin.totalDebt && fin.totalEquity) {
    const r = fin.totalDebt.current/fin.totalEquity.current*100;
    score += r<100?10:r<200?7:r<300?3:0;
    notes.push(`부채${r.toFixed(0)}%`);
  }
  if (fin.curAsset && fin.curLiab && fin.curLiab.current>0) {
    const r = fin.curAsset.current/fin.curLiab.current*100;
    score += r>=200?7:r>=100?5:1; notes.push(`유동${r.toFixed(0)}%`);
  } else { score+=3; }
  if (fin.cfOps>0) { score+=5; notes.push("현금흐름+"); }
  if (fin.retained?.current > fin.retained?.previous) { score+=3; notes.push("잉여금증가"); }
  return { score: Math.min(25,score), note: notes.join(",") };
}

function scoreProfitability(fin) {
  let score=0; const notes=[];
  if (fin.revenue) {
    const yoy1 = fin.revenue.previous>0?(fin.revenue.current-fin.revenue.previous)/fin.revenue.previous*100:0;
    const yoy2 = fin.revenue.before>0?(fin.revenue.previous-fin.revenue.before)/fin.revenue.before*100:0;
    const avg  = (yoy1+yoy2)/2;
    score += avg>15?10:avg>5?7:avg>0?4:1; notes.push(`매출YoY${avg>0?'+':''}${avg.toFixed(0)}%`);
  }
  if (fin.opIncome) {
    const yoy = fin.opIncome.previous>0
      ?(fin.opIncome.current-fin.opIncome.previous)/Math.abs(fin.opIncome.previous)*100
      :fin.opIncome.current>0?999:-999;
    score += yoy>20?6:yoy>0?4:1; notes.push(`영업YoY${Math.min(yoy,999).toFixed(0)}%`);
    if (fin.revenue?.current>0) {
      const m = fin.opIncome.current/fin.revenue.current*100;
      score += m>15?4:m>7?2:0; notes.push(`영업률${m.toFixed(1)}%`);
    }
  }
  if (fin.netIncome) {
    const all3 = [fin.netIncome.current,fin.netIncome.previous,fin.netIncome.before].every(v=>v>0);
    score += all3?5:fin.netIncome.current>0?3:0;
    notes.push(all3?"순이익3년흑자":"순이익흑자");
  }
  return { score: Math.min(25,score), note: notes.join(",") };
}

function scoreValuation(fin, marketCap) {
  if (!marketCap||marketCap<=0) return { score:5, note:"시총없음" };
  let score=0; const notes=[];
  const ni = fin.netIncome?.current ?? 0;
  if (ni>0) {
    const per = marketCap/ni;
    let ps=0;
    if (per<5)       { ps=12; notes.push(`PER${per.toFixed(1)}(극저평가)`); }
    else if (per<10) { ps=18; notes.push(`PER${per.toFixed(1)}(저평가)`); }
    else if (per<15) { ps=15; notes.push(`PER${per.toFixed(1)}(적정)`); }
    else if (per<20) { ps=10; notes.push(`PER${per.toFixed(1)}(다소고)`); }
    else if (per<30) { ps=5;  notes.push(`PER${per.toFixed(1)}(고평가)`); }
    else             { ps=2;  notes.push(`PER${per.toFixed(1)}(과매수)`); }
    score+=ps;
  } else { notes.push("순손실"); }
  const eq = fin.totalEquity?.current ?? 0;
  if (eq>0) {
    const pbr = marketCap/eq;
    score += pbr<0.5?6:pbr<1?5:pbr<2?3:pbr<4?1:0;
    notes.push(`PBR${pbr.toFixed(2)}`);
  }
  score+=3;
  return { score: Math.min(30,score), note: notes.join(",") };
}

function scoreShareholders(shareholders) {
  if (!shareholders.length) return { score:6, note:"데이터없음" };
  const max = shareholders.reduce((m,s)=>{
    const r = parseFloat(s.stkqty_irds_rt ?? s.trmend_posesn_stock_co ?? "0");
    return r>m.r?{r,name:s.nm}:m;
  }, {r:0,name:""});
  let score = max.r>=30?6:max.r>=20?4:2;
  const hasInst = shareholders.some(s=>(s.nm??"").includes("기관")||parseFloat(s.stkqty_irds_rt??"0")>5);
  if (hasInst) score+=3;
  score+=3;
  return { score: Math.min(12,score), note: `최대주주${max.r.toFixed(1)}%${hasInst?',기관보유':''}` };
}

// ── 다년도 성장·안정성 추세 (DB 이력 기반, max 18점) ─────
function scoreFinancialTrend(history) {
  if (!history || history.length < 2) return { score: null, note: "이력없음", maxScore: 0 };
  const sorted = [...history].sort((a, b) => b.analysis_year - a.analysis_year);
  let score = 0;
  const notes = [];

  // ① 매출 성장 흐름 (max 4, +3% 이상만 성장으로 인정)
  const revs = sorted.filter(h => h.revenue > 0);
  if (revs.length >= 2) {
    const growYears = revs.slice(0, -1).filter((h, i) =>
      (h.revenue - revs[i + 1].revenue) / revs[i + 1].revenue * 100 >= 3
    ).length;
    score += growYears >= 2 ? 4 : growYears >= 1 ? 2 : 0;
    notes.push(`매출성장${growYears}년`);
  }

  // ② 영업이익 성장 흐름 (max 4, +3% 이상만 인정)
  const ops = sorted.filter(h => h.op_income !== null && h.op_income > 0);
  if (ops.length >= 2) {
    const growYears = ops.slice(0, -1).filter((h, i) =>
      (h.op_income - ops[i + 1].op_income) / Math.abs(ops[i + 1].op_income) * 100 >= 3
    ).length;
    score += growYears >= 2 ? 4 : growYears >= 1 ? 2 : 0;
    notes.push(`영업이익성장${growYears}년`);
  }

  // ③ 부채비율 개선 추세 (max 3, 낮을수록 좋음)
  const debts = sorted.filter(h => h.debt_ratio !== null);
  if (debts.length >= 2) {
    const improving = debts.slice(0, -1).filter((h, i) => h.debt_ratio < debts[i + 1].debt_ratio).length;
    score += improving >= 2 ? 3 : improving >= 1 ? 2 : 0;
    notes.push(`부채${improving >= 1 ? '개선' : '악화'}`);
  }

  // ④ 유동비율 개선 추세 (max 2, 높을수록 좋음)
  const curs = sorted.filter(h => h.cur_ratio !== null);
  if (curs.length >= 2) {
    const improving = curs.slice(0, -1).filter((h, i) => h.cur_ratio > curs[i + 1].cur_ratio).length;
    score += improving >= 1 ? 2 : 0;
    notes.push(`유동${improving >= 1 ? '개선' : '악화'}`);
  }

  // ⑤ 영업현금흐름 지속성 (max 5, 가장 조작 어려운 품질 신호)
  const cfs = sorted.filter(h => h.cf_ops !== null);
  if (cfs.length >= 1) {
    const posCount = cfs.filter(h => h.cf_ops > 0).length;
    score += posCount === cfs.length ? 5 : posCount >= cfs.length * 0.7 ? 3 : posCount > 0 ? 1 : 0;
    notes.push(`현금흐름${posCount}/${cfs.length}년+`);
  }

  return { score: Math.min(18, score), note: notes.join(","), maxScore: 18 };
}

// ── DB upsert helpers ────────────────────────────────────
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
const upsertRows = rows => upsertTable("stock_analysis", rows);
const upsertFinancials = rows => upsertTable("stock_financials", rows);

// ── DB 이력 재무 조회 (analysis_year < YEAR) ──────────────
async function fetchHistoricalFinancials(stockCodes) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return {};
  const result = {};
  const BATCH = 200;
  for (let i = 0; i < stockCodes.length; i += BATCH) {
    const chunk = stockCodes.slice(i, i + BATCH);
    const url = `${SUPABASE_URL}/rest/v1/stock_financials`
      + `?stock_code=in.(${chunk.join(",")})`
      + `&analysis_year=lt.${YEAR}`
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

// ── 공시 마스터 + 감성 분리 적재 ─────────────────────────
async function flushDisclosures(batch) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !batch.length) return;
  // rcept_no null인 것 제외
  const valid = batch.filter(d => d.rcept_no);
  if (!valid.length) return;

  // 1) stock_disclosures 마스터 (rcept_no unique → ignore duplicates)
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

  // 2) stock_disclosure_sentiments (rcept_no, sentiment_version unique → ignore duplicates)
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

// 이력 테이블은 append-only (merge-duplicates 없음)
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

// ══════ 메인 ══════════════════════════════════════════════
async function main() {
  const useAll = process.argv.includes("--all");
  const listFile = useAll ? "kospi-all.json" : "kospi-profitable.json";
  const listKey  = useAll ? "all" : "profitable";
  const companies = JSON.parse(fs.readFileSync(path.join(__dirname, listFile), "utf8"))[listKey];
  const total = companies.length;
  console.log(`\n=== KOSPI ${useAll ? "전체" : "흑자기업"} ${total}개 전체 점수 계산 ===\n`);

  // 섹터 캐시 로드
  const sectorCacheFile = path.join(__dirname, ".sector_cache.json");
  const sectorMap = fs.existsSync(sectorCacheFile)
    ? JSON.parse(fs.readFileSync(sectorCacheFile, "utf8"))
    : {};

  // 1. DART 재무 배치
  console.log("[1] DART 재무 일괄 수집...");
  const allCorpCodes = companies.map(s => s.corp_code);
  const finRows = await batchFinancials(allCorpCodes);
  const finMap = {};
  for (const s of companies)
    finMap[s.corp_code] = parseFinancials(finRows.filter(r => r.corp_code === s.corp_code));
  console.log(`  완료: ${Object.keys(finMap).length}개\n`);

  // 이력 재무 조회 (다년도 추세 점수용)
  console.log("[2.5] DB 이력 재무 조회...");
  const historyMap = await fetchHistoricalFinancials(companies.map(s => s.stockCode));
  console.log(`  이력 보유 종목: ${Object.keys(historyMap).length}개\n`);

  // 2. 종목별 주가이력 + 공시 + 주주
  console.log("[2] 종목별 데이터 수집 + 점수 계산...\n");
  const RUN_ID = `kospi-${ymd(new Date())}-${Date.now()}`;
  const results = [];
  const CHECKPOINT = 50;
  const dbBatch = [];
  const finBatch = [];
  const histBatch = [];
  const discBatch = [];

  for (let i = 0; i < companies.length; i++) {
    const s = companies[i];
    const fin = finMap[s.corp_code] ?? {};

    let quote=null, disclosures=[], shareholders=[], marketCap=0;

    try { quote = await getPublicDataQuote(s.stockCode); } catch { /* 무시 */ }
    if (quote) marketCap = quote.marketCap;

    await sleep(150);
    try { disclosures = await getDisclosures(s.corp_code); } catch { /* 무시 */ }
    try { shareholders = await getMajorShareholders(s.corp_code); } catch { /* 무시 */ }
    await sleep(DELAY_MS);

    const currentPrice = quote?.price ?? 0;

    // 단기 (기술지표 제외 — 이력 데이터 불필요한 항목만)
    const momentum   = { score: 0, note: "이력미수집" };
    const volume     = { score: 0, note: "이력미수집" };
    const volatility = { score: 0, note: "이력미수집" };
    const disclosure = scoreDisclosure(disclosures);
    const shortTotal = disclosure.score;

    // 중장기
    const health   = scoreFinancialHealth(fin);
    const profit   = scoreProfitability(fin);
    const valuation= scoreValuation(fin, marketCap);
    const govScore = scoreShareholders(shareholders);
    const trend    = scoreFinancialTrend(historyMap[s.stockCode]);
    const longTotal= health.score+profit.score+valuation.score+govScore.score+(trend.score ?? 0);
    const totalScore = shortTotal+longTotal;

    // 목표가 + 추천
    const tp  = calcTargetPrice(currentPrice, quote?.eps ?? 0, quote?.bps ?? 0, fin, marketCap);
    const rec = buildRecommendation(longTotal, valuation.note, tp.midTargetPct);

    const row = {
      rank: 0, stockCode: s.stockCode, corp_name: s.corp_name,
      currentPrice, shortTargetPrice: tp.shortTargetPrice, midTargetPrice: tp.midTargetPrice,
      shortTargetPct: tp.shortTargetPct, midTargetPct: tp.midTargetPct,
      recommendation: rec, marketCapTril: +(marketCap/1e12).toFixed(2),
      totalScore, shortScore: shortTotal, longScore: longTotal,
      generatedAt: new Date().toISOString(),
      detail: {
        단기_기술모멘텀:  { score: momentum.score,   max:30, note: momentum.note },
        단기_거래량수급:  { score: volume.score,     max:25, note: volume.note },
        단기_변동성:     { score: volatility.score,  max:20, note: volatility.note },
        단기_공시이벤트:  { score: disclosure.score, max:15, note: disclosure.note },
        중장기_재무건전성: { score: health.score,    max:25, note: health.note },
        중장기_수익성:   { score: profit.score,      max:25, note: profit.note },
        중장기_밸류에이션: { score: valuation.score, max:30, note: valuation.note },
        중장기_지배구조:  { score: govScore.score,   max:12, note: govScore.note },
        다년도_성장흐름:  { score: trend.score,      max: 18, note: trend.note },
      }
    };
    results.push(row);

    // DB 배치 적재 — stock_analysis
    const analysisRow = {
      stock_code: s.stockCode, corp_name: s.corp_name,
      current_price: currentPrice, short_target_price: tp.shortTargetPrice,
      mid_target_price: tp.midTargetPrice, short_target_pct: tp.shortTargetPct,
      mid_target_pct: tp.midTargetPct, recommendation: rec,
      market_cap_tril: +(marketCap/1e12).toFixed(2),
      mrkt_ctg: "KOSPI",
      sector: sectorMap[s.stockCode]?.sector ?? null,
      total_score: totalScore, short_score: shortTotal, long_score: longTotal,
      detail: row.detail, generated_at: row.generatedAt, updated_at: row.generatedAt,
      analysis_run_id: RUN_ID,
    };
    dbBatch.push(analysisRow);
    const { updated_at: _ua, sector: _sec, ...histRow } = analysisRow;
    histBatch.push({ ...histRow, snapshot_at: row.generatedAt });
    if (dbBatch.length  >= 50) { await upsertRows(dbBatch.splice(0)); }
    if (histBatch.length >= 50) { await appendTable("stock_analysis_history", histBatch.splice(0)); }

    // DB 배치 적재 — stock_financials
    const _ni  = fin.netIncome?.current  ?? 0;
    const _eq  = fin.totalEquity?.current ?? 0;
    const _rev = fin.revenue?.current    ?? 0;
    const _op  = fin.opIncome?.current   ?? 0;
    finBatch.push({
      stock_code:    s.stockCode,
      corp_name:     s.corp_name,
      mrkt_ctg:      "KOSPI",
      per:           _ni > 0 && marketCap > 0 ? +( marketCap / _ni).toFixed(2) : null,
      pbr:           _eq > 0 && marketCap > 0 ? +( marketCap / _eq).toFixed(2) : null,
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
      net_income:    _ni   || null,
      total_equity:  _eq   || null,
      total_debt:    fin.totalDebt?.current  || null,
      total_asset:   fin.totalAsset?.current || null,
      revenue:       _rev  || null,
      op_income:     _op   || null,
      market_cap:    marketCap || null,
      cf_ops:        fin.cfOps ?? null,
      analysis_year: YEAR,
      updated_at:    row.generatedAt,
    });
    if (finBatch.length >= 50) await upsertFinancials(finBatch.splice(0));

    for (const d of disclosures) {
      const t = d.report_nm ?? "";
      const GOOD = ["자기주식","수주","실적","흑자","배당","취득"];
      const BAD  = ["유상증자","소송","대주주매도","적자","불성실","횡령"];
      const isGood = GOOD.some(k => t.includes(k));
      const isBad  = BAD.some(k => t.includes(k));
      const sentScore = isGood && !isBad ? 0.7 : isBad && !isGood ? -0.7 : 0.0;
      discBatch.push({
        rcept_no:         d.rcept_no ?? null,
        stock_code:       s.stockCode,
        rcept_dt:         d.rcept_dt ?? null,
        report_nm:        t,
        report_type:      null,
        _sentiment_score: sentScore,  // sentiments 테이블용 임시 필드
      });
    }
    if (discBatch.length >= 100) await flushDisclosures(discBatch.splice(0));

    if ((i+1) % CHECKPOINT === 0 || i === companies.length-1) {
      const pct = (((i+1)/total)*100).toFixed(1);
      console.log(`  [${i+1}/${total}] ${pct}% — 현재 최고점: ${Math.max(...results.map(r=>r.totalScore))}점`);
    }
  }
  if (dbBatch.length)   await upsertRows(dbBatch);
  if (finBatch.length)  await upsertFinancials(finBatch);
  if (histBatch.length) await appendTable("stock_analysis_history", histBatch);
  if (discBatch.length) await flushDisclosures(discBatch);

  // 3. 랭킹 + 저장
  results.sort((a,b) => b.totalScore-a.totalScore);
  results.forEach((r,i) => r.rank=i+1);
  fs.writeFileSync(path.join(__dirname, "scored-kospi-full.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), total, results }, null, 2));

  // 4. TOP 10
  console.log("\n" + "═".repeat(115));
  console.log("  KOSPI TOP 10");
  console.log("═".repeat(115));
  console.log(`${"순위".padEnd(4)} ${"코드".padEnd(8)} ${"기업명".padEnd(20)} ${"총점".padEnd(5)} ${"현재가".padEnd(9)} ${"단기목표".padEnd(10)} ${"장기목표".padEnd(10)} ${"장기%".padEnd(7)} 추천`);
  console.log("─".repeat(115));
  for (const r of results.filter(r => r.midTargetPct > 0).slice(0,10)) {
    console.log([
      String(r.rank).padEnd(4),
      r.stockCode.padEnd(8),
      r.corp_name.slice(0,18).padEnd(20),
      String(r.totalScore).padEnd(5),
      String(r.currentPrice.toLocaleString()).padEnd(9),
      String(r.shortTargetPrice.toLocaleString()).padEnd(10),
      String(r.midTargetPrice.toLocaleString()).padEnd(10),
      `${r.midTargetPct>0?'+':''}${r.midTargetPct}%`.padEnd(7),
      r.recommendation.slice(0,40),
    ].join(" "));
  }
  console.log(`\n저장: scored-kospi-full.json | DB upsert 완료`);
}

main().catch(e => { console.error("오류:", e); process.exit(1); });
