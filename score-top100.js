/**
 * score-top100.js
 * 영업이익 상위 100개 기업 대상 스펙 기준 점수 계산 → 상위 10개 출력
 *
 * 실행: node score-top100.js
 * 결과: scored-stocks.json
 *
 * 채점 항목 (뉴스/웹서치 제외):
 *   단기  : 기술적모멘텀(30) + 거래량수급(25) + 변동성(20) + 공시이벤트(15) = 90pt
 *   중장기 : 재무건전성(25) + 수익성트렌드(25) + 밸류에이션(30) + 지배구조(12) = 92pt
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { ANALYSIS_YEAR, ANALYSIS_YEAR_FALLBACK, SCORE_DELAY_MS, TOP_STOCK_LIMIT } from "./config.js";
import { calcTargetPrice, buildRecommendation } from "./stock-utils.js";

const require   = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, ".env") });

const DART_KEY   = process.env.DART_API_KEY;
const PUBLIC_KEY = process.env.PUBLIC_DATA_API_KEY;
const DART_BASE  = "https://opendart.fss.or.kr/api";
const PUBLIC_BASE= "https://apis.data.go.kr/1160100/service";
const YEAR       = ANALYSIS_YEAR;
const YEAR_FB    = ANALYSIS_YEAR_FALLBACK;
const TOP_N      = TOP_STOCK_LIMIT;
const DELAY_MS   = SCORE_DELAY_MS;

if (!DART_KEY || !PUBLIC_KEY) { console.error("API 키 미설정"); process.exit(1); }

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const pad    = n => String(n).padStart(2, "0");
const ymd    = d => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
const today  = () => ymd(new Date());
const daysAgo= n => { const d = new Date(); d.setDate(d.getDate()-n); return ymd(d); };

async function fetchJson(url, timeout = 30000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally { clearTimeout(id); }
}

// ── DART fnlttMultiAcnt (최대 100개) ─────────────────────
async function getMultiFinancials(corpCodes, year, fsdiv) {
  const url = new URL(`${DART_BASE}/fnlttMultiAcnt.json`);
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("corp_code", corpCodes.join(","));
  url.searchParams.set("bsns_year", year);
  url.searchParams.set("reprt_code", "11011");
  url.searchParams.set("fs_div", fsdiv);
  const d = await fetchJson(url.toString());
  if (!["000","013"].includes(d.status)) console.warn(`  DART ${fsdiv}/${year} 오류: ${d.status}`);
  return d.list ?? [];
}

async function getFullFinancials(corpCodes) {
  let list = await getMultiFinancials(corpCodes, YEAR, "CFS");
  const found = new Set(list.map(r => r.corp_code));
  const miss1 = corpCodes.filter(c => !found.has(c));
  if (miss1.length) {
    const ofs = await getMultiFinancials(miss1, YEAR, "OFS");
    list = [...list, ...ofs];
  }
  const found2 = new Set(list.map(r => r.corp_code));
  const miss2 = corpCodes.filter(c => !found2.has(c));
  if (miss2.length) {
    let fb = await getMultiFinancials(miss2, YEAR_FB, "CFS");
    const foundFB = new Set(fb.map(r => r.corp_code));
    const miss3 = miss2.filter(c => !foundFB.has(c));
    if (miss3.length) fb = [...fb, ...await getMultiFinancials(miss3, YEAR_FB, "OFS")];
    list = [...list, ...fb];
  }
  return list;
}

// ── 재무 데이터 파싱 ──────────────────────────────────────
function parseFinancials(rows) {
  const get = (...names) => {
    for (const name of names) {
      const row = rows.find(r => r.account_nm?.trim() === name && r.sj_div !== "CF");
      if (row) {
        return {
          current:  Number(String(row.thstrm_amount ?? "0").replace(/,/g, "")),
          previous: Number(String(row.frmtrm_amount ?? "0").replace(/,/g, "")),
          before:   Number(String(row.bfefrmtrm_amount ?? "0").replace(/,/g, "")),
        };
      }
    }
    return null;
  };
  const getCF = name => {
    const row = rows.find(r => r.account_nm?.trim() === name && r.sj_div === "CF");
    if (!row) return null;
    return Number(String(row.thstrm_amount ?? "0").replace(/,/g, ""));
  };

  return {
    revenue:    get("매출액"),
    opIncome:   get("영업이익", "영업이익(손실)"),
    netIncome:  get("당기순이익", "당기순이익(손실)"),
    totalAsset: get("자산총계"),
    totalEquity:get("자본총계"),
    totalDebt:  get("부채총계"),
    curAsset:   get("유동자산"),
    curLiab:    get("유동부채"),
    retained:   get("이익잉여금"),
    cfOps:      getCF("영업활동현금흐름"),
  };
}

// ── 주가 이력 수집 ────────────────────────────────────────
async function getStockHistory(stockCode) {
  const url = new URL(`${PUBLIC_BASE}/GetStockSecuritiesInfoService/getStockPriceInfo`);
  url.searchParams.set("serviceKey", PUBLIC_KEY);
  url.searchParams.set("resultType", "json");
  url.searchParams.set("numOfRows", "80");
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("beginBasDt", daysAgo(90));
  url.searchParams.set("endBasDt", today());
  url.searchParams.set("srtnCd", stockCode);
  const data = await fetchJson(url.toString());
  const items = data?.response?.body?.items?.item ?? [];
  const all = Array.isArray(items) ? items : [items];
  return all.filter(r => r.srtnCd === stockCode)
            .sort((a,b) => a.basDt.localeCompare(b.basDt));
}

// ── DART 공시 목록 ────────────────────────────────────────
async function getDisclosures(corpCode) {
  const url = new URL(`${DART_BASE}/list.json`);
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bgn_de", daysAgo(30));
  url.searchParams.set("end_de", today());
  url.searchParams.set("sort", "date");
  url.searchParams.set("sort_mth", "desc");
  url.searchParams.set("page_count", "50");
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

// ══════════════════════════════════════════════════════════
// 점수 계산
// ══════════════════════════════════════════════════════════

// 단기 ①: 기술적 모멘텀 (30pt)
function scoreMomentum(history) {
  if (history.length < 20) return { score: 0, note: "데이터 부족" };
  const closes = history.map(r => Number(r.clpr));
  const cur = closes[closes.length - 1];

  const ma5  = closes.slice(-5).reduce((s,v)=>s+v,0) / 5;
  const ma20 = closes.slice(-20).reduce((s,v)=>s+v,0) / 20;
  const ma60 = closes.length >= 60 ? closes.slice(-60).reduce((s,v)=>s+v,0) / 60 : null;

  // 정배열: 현재가 > MA5 > MA20 > MA60
  let aligned = 0;
  if (cur > ma5) aligned++;
  if (ma5 > ma20) aligned++;
  if (ma60 && ma20 > ma60) aligned++;

  // 52주 위치
  const hi52 = Math.max(...closes);
  const lo52 = Math.min(...closes);
  const pos52 = hi52 > lo52 ? (cur - lo52) / (hi52 - lo52) : 0.5;

  // 최근 5일 방향
  const dir5 = closes[closes.length-1] > closes[closes.length-6] ? 1 : 0;

  const maScore  = aligned >= 3 ? 15 : aligned >= 2 ? 10 : aligned >= 1 ? 5 : 0;
  const posScore = pos52 > 0.7 ? 10 : pos52 > 0.5 ? 7 : pos52 > 0.3 ? 4 : 2;
  const dirScore = dir5 ? 5 : 0;
  const score = maScore + posScore + dirScore;

  return { score, note: `MA정배열${aligned}/3, 52주위치${(pos52*100).toFixed(0)}%` };
}

// 단기 ②: 거래량/수급 (25pt)
function scoreVolume(history) {
  if (history.length < 20) return { score: 0, note: "데이터 부족" };
  const recent = history.slice(-20);
  const vol20avg = recent.reduce((s,r)=>s+Number(r.trqu),0) / 20;
  const vol5avg  = history.slice(-5).reduce((s,r)=>s+Number(r.trqu),0) / 5;
  const ratio    = vol20avg > 0 ? vol5avg / vol20avg : 1;

  const burst    = history.slice(-5).some(r => Number(r.trqu) > vol20avg * 2);

  const ratioScore = ratio > 1.5 ? 15 : ratio > 1.2 ? 12 : ratio > 0.8 ? 8 : 4;
  const burstScore = burst ? 7 : 3;
  const trendScore = vol5avg > vol20avg ? 3 : 0;
  const score = ratioScore + burstScore + trendScore;

  return { score, note: `거래량비율${ratio.toFixed(2)}x${burst?' 급증':''}` };
}

// 단기 ③: 변동성/리스크 (20pt)
function scoreVolatility(history) {
  if (history.length < 20) return { score: 0, note: "데이터 부족" };
  const h20 = history.slice(-20);
  const highs = h20.map(r => Number(r.hipr));
  const lows  = h20.map(r => Number(r.lopr));
  const closes= h20.map(r => Number(r.clpr));

  const range20pct = (Math.max(...highs) - Math.min(...lows)) / Math.min(...lows) * 100;

  // MDD (최대낙폭)
  let peak = closes[0], mdd = 0;
  for (const c of closes) {
    peak = Math.max(peak, c);
    mdd  = Math.min(mdd, (c - peak) / peak * 100);
  }

  const rangeScore = range20pct < 15 ? 12 : range20pct < 25 ? 9 : range20pct < 35 ? 5 : 2;
  const mddScore   = mdd > -5  ? 8  : mdd > -10 ? 6 : mdd > -20 ? 3 : 0;
  const score = rangeScore + mddScore;

  return { score, note: `변동폭${range20pct.toFixed(1)}%, MDD${mdd.toFixed(1)}%` };
}

// 단기 ④: 공시/이벤트 (15pt)
function scoreDisclosure(disclosures) {
  const GOOD = ["자기주식", "수주", "실적", "흑자", "배당", "취득"];
  const BAD  = ["유상증자", "소송", "대주주매도", "적자", "불성실"];

  let good = 0, bad = 0;
  for (const d of disclosures) {
    const t = d.report_nm ?? "";
    if (GOOD.some(k => t.includes(k))) good++;
    if (BAD.some(k => t.includes(k))) bad++;
  }
  const cnt = disclosures.length;
  const cntScore  = cnt > 5 ? 5  : cnt > 2 ? 4 : cnt > 0 ? 2 : 0;
  const typeScore = Math.min(7, good * 3) - Math.min(5, bad * 2);
  const score = Math.max(0, Math.min(15, cntScore + typeScore + 3));

  return { score, note: `공시${cnt}건(호재${good}/악재${bad})` };
}

// 중장기 ①: 재무 건전성 (25pt)
function scoreFinancialHealth(fin) {
  let score = 0;
  const notes = [];

  // 부채비율 (10pt)
  if (fin.totalDebt && fin.totalEquity) {
    const debtRatio = fin.totalDebt.current / fin.totalEquity.current * 100;
    if (debtRatio < 100)      { score += 10; notes.push(`부채${debtRatio.toFixed(0)}%`); }
    else if (debtRatio < 200) { score += 7;  notes.push(`부채${debtRatio.toFixed(0)}%`); }
    else if (debtRatio < 300) { score += 3;  notes.push(`부채${debtRatio.toFixed(0)}%(주의)`); }
    else                      { score += 0;  notes.push(`부채${debtRatio.toFixed(0)}%(위험)`); }
  }

  // 유동비율 (7pt)
  if (fin.curAsset && fin.curLiab && fin.curLiab.current > 0) {
    const curRatio = fin.curAsset.current / fin.curLiab.current * 100;
    if (curRatio >= 200)      score += 7;
    else if (curRatio >= 100) score += 5;
    else                      score += 1;
    notes.push(`유동${curRatio.toFixed(0)}%`);
  } else {
    score += 3; // 금융업 등 유동비율 무의미 시 중간값
  }

  // 영업활동현금흐름 양수 (5pt)
  if (fin.cfOps !== null && fin.cfOps !== undefined) {
    if (fin.cfOps > 0) { score += 5; notes.push("현금흐름+"); }
    else                { notes.push("현금흐름-"); }
  }

  // 이익잉여금 증가 추세 (3pt)
  if (fin.retained?.current > fin.retained?.previous) {
    score += 3; notes.push("잉여금증가");
  }

  return { score, note: notes.join(", ") };
}

// 중장기 ②: 수익성 트렌드 (25pt)
function scoreProfitability(fin) {
  let score = 0;
  const notes = [];

  // 매출 YoY 3년 성장 (10pt)
  if (fin.revenue) {
    const yoy1 = fin.revenue.previous > 0 ? (fin.revenue.current - fin.revenue.previous) / fin.revenue.previous * 100 : 0;
    const yoy2 = fin.revenue.before > 0 ? (fin.revenue.previous - fin.revenue.before) / fin.revenue.before * 100 : 0;
    const avgYoY = (yoy1 + yoy2) / 2;
    if (avgYoY > 15)      { score += 10; notes.push(`매출YoY+${avgYoY.toFixed(0)}%`); }
    else if (avgYoY > 5)  { score += 7; notes.push(`매출YoY+${avgYoY.toFixed(0)}%`); }
    else if (avgYoY > 0)  { score += 4; notes.push(`매출YoY+${avgYoY.toFixed(0)}%`); }
    else                  { score += 1; notes.push(`매출YoY${avgYoY.toFixed(0)}%`); }
  }

  // 영업이익 YoY + 영업이익률 추세 (10pt)
  if (fin.opIncome) {
    const yoy = fin.opIncome.previous > 0
      ? (fin.opIncome.current - fin.opIncome.previous) / Math.abs(fin.opIncome.previous) * 100
      : fin.opIncome.current > 0 ? 999 : -999;
    if (yoy > 20)      { score += 6; notes.push(`영업이익YoY+${Math.min(yoy,999).toFixed(0)}%`); }
    else if (yoy > 0)  { score += 4; notes.push(`영업이익YoY+${yoy.toFixed(0)}%`); }
    else               { score += 1; notes.push(`영업이익YoY${yoy.toFixed(0)}%`); }

    // 영업이익률
    if (fin.revenue?.current > 0) {
      const margin = fin.opIncome.current / fin.revenue.current * 100;
      if (margin > 15)     { score += 4; notes.push(`영업률${margin.toFixed(1)}%`); }
      else if (margin > 7) { score += 2; notes.push(`영업률${margin.toFixed(1)}%`); }
      else                 { notes.push(`영업률${margin.toFixed(1)}%`); }
    }
  }

  // 당기순이익 흑자 지속 (5pt)
  if (fin.netIncome) {
    const allPos = [fin.netIncome.current, fin.netIncome.previous, fin.netIncome.before].every(v => v > 0);
    const curPos = fin.netIncome.current > 0;
    if (allPos)     { score += 5; notes.push("순이익3년흑자"); }
    else if (curPos){ score += 3; notes.push("순이익흑자"); }
  }

  return { score, note: notes.join(", ") };
}

// 중장기 ③: 밸류에이션 (30pt) — PER(18) + PBR(6) + 업종대비(6, skip→3)
function scoreValuation(fin, marketCap) {
  if (!marketCap || marketCap <= 0) return { score: 5, note: "시총없음" };
  let score = 0;
  const notes = [];

  // PER (18pt)
  const ni = fin.netIncome?.current ?? 0;
  if (ni <= 0) {
    notes.push("순손실(PER불가)");
    // 0pt
  } else {
    const per = marketCap / ni;
    let perScore = 0;
    if (per < 5)        { perScore = 12; notes.push(`PER${per.toFixed(1)}(극저평가)`); }
    else if (per < 10)  { perScore = 18; notes.push(`PER${per.toFixed(1)}(저평가)`); }
    else if (per < 15)  { perScore = 15; notes.push(`PER${per.toFixed(1)}(적정)`); }
    else if (per < 20)  { perScore = 10; notes.push(`PER${per.toFixed(1)}(다소고)`); }
    else if (per < 30)  { perScore = 5;  notes.push(`PER${per.toFixed(1)}(고평가)`); }
    else                { perScore = 2;  notes.push(`PER${per.toFixed(1)}(과매수)`); }
    score += perScore;
  }

  // PBR (6pt)
  const eq = fin.totalEquity?.current ?? 0;
  if (eq > 0) {
    const pbr = marketCap / eq;
    if (pbr < 0.5)      { score += 6; notes.push(`PBR${pbr.toFixed(2)}`); }
    else if (pbr < 1)   { score += 5; notes.push(`PBR${pbr.toFixed(2)}`); }
    else if (pbr < 2)   { score += 3; notes.push(`PBR${pbr.toFixed(2)}`); }
    else if (pbr < 4)   { score += 1; notes.push(`PBR${pbr.toFixed(2)}`); }
    else                { score += 0; notes.push(`PBR${pbr.toFixed(2)}(고)`); }
  }

  score += 3; // 업종 대비 기본점수 (웹서치 없이)
  return { score: Math.min(30, score), note: notes.join(", ") };
}

// 중장기 ④: 지배구조/주주 (12pt)
function scoreShareholders(shareholders) {
  if (!shareholders.length) return { score: 6, note: "데이터없음" };
  let score = 0;
  const notes = [];

  // 최대주주 지분율
  const maxHolder = shareholders.reduce((m, s) => {
    const r = parseFloat(s.stkqty_irds_rt ?? s.trmend_posesn_stock_co ?? "0");
    return r > m.r ? { r, name: s.nm } : m;
  }, { r: 0, name: "" });

  if (maxHolder.r >= 30)     { score += 6; notes.push(`최대주주${maxHolder.r.toFixed(1)}%`); }
  else if (maxHolder.r >= 20){ score += 4; notes.push(`최대주주${maxHolder.r.toFixed(1)}%`); }
  else                       { score += 2; notes.push(`최대주주${maxHolder.r.toFixed(1)}%(분산)`); }

  // 기관/외국인 보유 여부
  const hasInst = shareholders.some(s =>
    (s.nm ?? "").includes("기관") || (s.nm ?? "").includes("국민") ||
    parseFloat(s.stkqty_irds_rt ?? "0") > 5
  );
  if (hasInst) { score += 3; notes.push("기관보유"); }

  score += 3; // 대주주 매매 기본점수
  return { score: Math.min(12, score), note: notes.join(", ") };
}

// ══════════════════════════════════════════════════════════
// 메인
// ══════════════════════════════════════════════════════════
async function main() {
  // 1. 상위 100개 로드
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "profitable-stocks.json"), "utf8"));
  const top100 = raw.profitable.slice(0, TOP_N);
  console.log(`\n=== 영업이익 상위 ${TOP_N}개 종합 점수 계산 ===\n`);

  // 2. DART 재무 일괄 수집 (1회 API 콜로 100개)
  console.log("[1] DART 재무 데이터 수집 중...");
  const corpCodes = top100.map(s => s.corp_code);
  const finRows = await getFullFinancials(corpCodes);
  const finMap = {}; // corp_code → parsed financials
  for (const s of top100) {
    const rows = finRows.filter(r => r.corp_code === s.corp_code);
    finMap[s.corp_code] = parseFinancials(rows);
  }
  console.log(`  완료: ${Object.keys(finMap).length}개\n`);

  // 3. 주가 이력 + 공시 + 주주 — 종목별 순차 수집
  console.log("[2] 종목별 데이터 수집 + 점수 계산 중...\n");
  const results = [];

  for (let i = 0; i < top100.length; i++) {
    const s = top100[i];
    process.stdout.write(`  [${i+1}/${TOP_N}] ${s.stockCode} ${s.corp_name} ... `);

    let history = [], disclosures = [], shareholders = [], marketCap = 0;

    // 주가 이력
    try {
      history = await getStockHistory(s.stockCode);
      if (history.length > 0) {
        marketCap = Number(history[history.length - 1].mrktTotAmt ?? 0);
      }
    } catch (e) { console.warn(`주가오류: ${e.message}`); }

    await sleep(200);

    // 공시
    try { disclosures = await getDisclosures(s.corp_code); } catch { /* 무시 */ }

    // 주요 주주
    try { shareholders = await getMajorShareholders(s.corp_code); } catch { /* 무시 */ }

    await sleep(DELAY_MS);

    const fin = finMap[s.corp_code] ?? {};

    // 단기 점수
    const momentum   = scoreMomentum(history);
    const volume     = scoreVolume(history);
    const volatility = scoreVolatility(history);
    const disclosure = scoreDisclosure(disclosures);
    const shortTotal = momentum.score + volume.score + volatility.score + disclosure.score;

    // 중장기 점수
    const health   = scoreFinancialHealth(fin);
    const profit   = scoreProfitability(fin);
    const valuation= scoreValuation(fin, marketCap);
    const govScore = scoreShareholders(shareholders);
    const longTotal= health.score + profit.score + valuation.score + govScore.score;

    const totalScore = shortTotal + longTotal;
    const currentPrice = history.length > 0 ? Number(history[history.length-1].clpr) : 0;

    // 목표가 + 추천
    const tp = calcTargetPrice(currentPrice, 0, 0, fin, marketCap);
    const recommendation = buildRecommendation(longTotal, valuation.note, tp.midTargetPct);

    results.push({
      rank: 0,
      stockCode: s.stockCode,
      corp_name: s.corp_name,
      currentPrice,
      shortTargetPrice: tp.shortTargetPrice,
      midTargetPrice:   tp.midTargetPrice,
      shortTargetPct:   tp.shortTargetPct,
      midTargetPct:     tp.midTargetPct,
      recommendation,
      marketCapTril: +(marketCap / 1e12).toFixed(2),
      totalScore,
      shortScore: shortTotal,
      longScore: longTotal,
      generatedAt: new Date().toISOString(),
      detail: {
        단기_기술모멘텀: { score: momentum.score,    max: 30, note: momentum.note },
        단기_거래량수급: { score: volume.score,      max: 25, note: volume.note },
        단기_변동성:    { score: volatility.score,  max: 20, note: volatility.note },
        단기_공시이벤트: { score: disclosure.score,  max: 15, note: disclosure.note },
        중장기_재무건전성:{ score: health.score,    max: 25, note: health.note },
        중장기_수익성:  { score: profit.score,      max: 25, note: profit.note },
        중장기_밸류에이션:{ score: valuation.score, max: 30, note: valuation.note },
        중장기_지배구조: { score: govScore.score,   max: 12, note: govScore.note },
      }
    });

    console.log(`총점 ${totalScore} (단기${shortTotal}/중장기${longTotal})`);
  }

  // 4. 랭킹 정렬
  results.sort((a, b) => b.totalScore - a.totalScore);
  results.forEach((r, i) => r.rank = i + 1);

  // 5. 저장
  const output = { generatedAt: new Date().toISOString(), results };
  fs.writeFileSync(path.join(__dirname, "scored-stocks.json"), JSON.stringify(output, null, 2));

  // 6. 상위 10개 출력
  console.log("\n" + "═".repeat(80));
  console.log("  TOP 10 종합 점수 랭킹");
  console.log("═".repeat(80));
  console.log(`${"순위".padEnd(4)} ${"종목코드".padEnd(8)} ${"기업명".padEnd(18)} ${"총점".padEnd(6)} ${"단기".padEnd(6)} ${"중장기".padEnd(6)} ${"시총(조)".padEnd(8)} 주요 지표`);
  console.log("─".repeat(100));

  for (const r of results.slice(0, 10)) {
    const line = [
      String(r.rank).padEnd(4),
      r.stockCode.padEnd(8),
      r.corp_name.slice(0,16).padEnd(18),
      String(r.totalScore).padEnd(6),
      String(r.shortScore).padEnd(6),
      String(r.longScore).padEnd(6),
      String(r.marketCapTril).padEnd(8),
      r.detail["중장기_밸류에이션"].note.slice(0,30),
    ].join(" ");
    console.log(line);
  }

  console.log("\n결과 저장: scored-stocks.json");
}

main().catch(e => { console.error("오류:", e); process.exit(1); });
