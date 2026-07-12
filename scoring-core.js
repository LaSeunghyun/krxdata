/**
 * scoring-core.js
 * score-kospi-full.js / score-kosdaq.js 공통 로직
 * - DART 재무 파싱
 * - 다년도 성장·안정성 추세 점수
 * - 공시 호재/악재 키워드 + 감성 분류
 * - 타임아웃 내장 fetch
 */

// ── 공시 키워드 (단일 정의) ──────────────────────────────
export const GOOD_KEYWORDS = ["자기주식", "수주", "실적", "흑자", "배당", "취득"];
export const BAD_KEYWORDS  = ["유상증자", "소송", "대주주매도", "적자", "불성실", "횡령"];

/**
 * 공시 제목 → 감성 분류
 * @param {string} title report_nm
 * @returns {{isGood:boolean, isBad:boolean, score:number}}
 */
export function disclosureSentiment(title) {
  const t = title ?? "";
  const isGood = GOOD_KEYWORDS.some(k => t.includes(k));
  const isBad  = BAD_KEYWORDS.some(k => t.includes(k));
  const score  = isGood && !isBad ? 0.7 : isBad && !isGood ? -0.7 : 0.0;
  return { isGood, isBad, score };
}

// ── 타임아웃 내장 fetch (Node 18+ globalThis.fetch + AbortSignal.timeout) ──
export async function fetchWithTimeout(url, opts = {}, timeoutMs = 20_000) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
}

// ── DART 재무 파싱 ────────────────────────────────────────
export function parseFinancials(rows) {
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
    retained:    get("이익잉여금"),
    capital:     get("자본금"),
    cfOps:       getCF("영업활동현금흐름"),
  };
}

/**
 * 무상증자 여력(방식 A: 표시 플래그) — 재원 근사, total_score 불변.
 * 무증 재원 = 자본잉여금(주식발행초과금 등). fnlttMultiAcnt엔 세부가 없어
 * 자본잉여금 ≈ 자본총계 - 자본금 - 이익잉여금 으로 근사(비지배지분 포함 → 과대 가능, 大中小 판단용).
 * @returns {{reserveRatio:number|null, flag:boolean}} reserveRatio=근사잉여금/자본금, flag=무증 후보(≥3배 & 흑자)
 */
export function estimateBonusCapacity(fin) {
  const eq  = fin?.totalEquity?.current ?? 0;
  const cap = fin?.capital?.current ?? 0;
  const ret = fin?.retained?.current ?? 0;
  const ni  = fin?.netIncome?.current ?? 0;
  if (!(cap > 0) || !(eq > 0)) return { reserveRatio: null, flag: false };
  const surplus = Math.max(eq - cap - ret, 0); // 자본잉여금 근사
  const reserveRatio = +(surplus / cap).toFixed(1);
  const flag = reserveRatio >= 3 && ni > 0; // 재원 풍부(잉여금 자본금 3배+) + 흑자 → 무증 후보
  return { reserveRatio, flag };
}

// ── 다년도 성장·안정성 추세 (DB 이력 기반, max 18점) ─────
export function scoreFinancialTrend(history) {
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

// ── 현금흐름표 + Capex 추출 (fnlttSinglAcntAll rows, sj_div="CF") ─────────
// fnlttMultiAcnt엔 현금흐름표가 없어 cf_ops/capex를 못 얻음 → 별도 SingleAcntAll 호출분 파싱.
// 계정명은 회사마다 표기가 달라 공백제거 후 정규식 부분매칭. 취득/처분 혼동 방지.
const _num = v => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };

export function extractCashflowCapex(rows) {
  const CF = (rows ?? []).filter(r => r.sj_div === "CF");
  const nm = r => (r.account_nm ?? "").replace(/\s/g, "");
  const findTotal = (re, exclude) =>
    CF.find(r => re.test(nm(r)) && !(exclude && exclude.test(nm(r))));
  // "영업활동에서창출된현금"(소계) 제외하고 "영업활동으로인한현금흐름"(순액) 선택
  const opRow  = findTotal(/영업활동.*현금흐름/, /창출/);
  const invRow = findTotal(/투자활동.*현금흐름/);
  // capex = 유형자산·무형자산 취득(절대값 합). 처분(유입) 제외. 부호 관행 회사마다 달라 abs.
  const capexRows = CF.filter(r => /(유형자산|무형자산).*취득/.test(nm(r)) && !/처분/.test(nm(r)));
  const sumAbs = pick => {
    let s = null;
    for (const r of capexRows) { const v = pick(r); if (v != null) s = (s ?? 0) + Math.abs(v); }
    return s;
  };
  return {
    cfOps:     opRow  ? _num(opRow.thstrm_amount)  : null,
    cfInv:     invRow ? _num(invRow.thstrm_amount) : null,
    capex:     sumAbs(r => _num(r.thstrm_amount)),
    capexPrev: sumAbs(r => _num(r.frmtrm_amount)),
  };
}

// fnlttSinglAcntAll(CFS→OFS→fallbackYear) 호출로 현금흐름·capex 수집.
// fetchJson은 호출측 재시도 로직을 주입(각 스크립트가 자체 보유).
export async function fetchCashflowCapex(corpCode, {
  dartKey, base = "https://opendart.fss.or.kr/api",
  year, fallbackYear = null, reprtCode = "11011", fetchJson,
}) {
  const call = async (fsdiv, yr) => {
    const url = new URL(`${base}/fnlttSinglAcntAll.json`);
    url.searchParams.set("crtfc_key", dartKey);
    url.searchParams.set("corp_code", corpCode);
    url.searchParams.set("bsns_year", String(yr));
    url.searchParams.set("reprt_code", reprtCode);
    url.searchParams.set("fs_div", fsdiv);
    let d; try { d = await fetchJson(url.toString()); } catch { return []; }
    return ["000", "013"].includes(d?.status) ? (d.list ?? []) : [];
  };
  const tryYear = async yr => {
    let rows = await call("CFS", yr);
    if (!rows.some(r => r.sj_div === "CF")) rows = await call("OFS", yr);
    return rows;
  };
  let rows = await tryYear(year);
  let usedYear = year;
  if (!rows.some(r => r.sj_div === "CF") && fallbackYear) {
    rows = await tryYear(fallbackYear); usedYear = fallbackYear;
  }
  const hasCF = rows.some(r => r.sj_div === "CF");
  return { ...extractCashflowCapex(rows), source: hasCF ? "ok" : "none", year: hasCF ? usedYear : null };
}

// FCF = 영업활동현금흐름 − capex. 둘 중 하나라도 없으면 null.
export function computeFcf(fin) {
  return (fin?.cfOps != null && fin?.capex != null) ? fin.cfOps - fin.capex : null;
}

// 현금흐름 품질 (max 5): 영업CF>0(+3) + FCF>0(+2). 재무건전성 25점 내 기존 현금 슬롯(5) 대체.
// FCF가 capex를 반영하므로 "capex를 점수에 반영"의 섹터중립·건전한 형태.
export function scoreCashflowQuality(fin) {
  let score = 0; const notes = [];
  if (fin?.cfOps != null && fin.cfOps > 0) { score += 3; notes.push("영업CF+"); }
  if (fin?.fcf   != null && fin.fcf   > 0) { score += 2; notes.push("FCF+"); }
  return { score, note: notes.join(","), max: 5 };
}

// Capex 사이클 지표(비점수, 표시용). capexYoY≥30% & capex>0 → 증설 사이클 신호.
export function capexCycle(fin) {
  const { capex, capexPrev, cfOps } = fin ?? {};
  const capexYoY   = (capex != null && capexPrev != null && capexPrev > 0)
    ? +(((capex - capexPrev) / capexPrev) * 100).toFixed(1) : null;
  const capexToOcf = (capex != null && cfOps != null && cfOps > 0)
    ? +(capex / cfOps).toFixed(2) : null;
  const cycle = capex != null && capex > 0 && capexYoY != null && capexYoY >= 30;
  return { capex: capex ?? null, fcf: fin?.fcf ?? null, capexYoY, capexToOcf, cycle };
}
