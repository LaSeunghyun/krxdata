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
    cfOps:       getCF("영업활동현금흐름"),
  };
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
