/**
 * stock-utils.js
 * 목표가 계산 + 추천 텍스트 공통 유틸
 */

/**
 * 업종별 적정 PER (stock-analysis 워크플로 기준 중앙값)
 *  - 바이오·제약·헬스케어: 22 / IT·플랫폼·반도체·게임·미디어·통신: 17 / 제조·금융·유통·기타: 12
 * @param {string|null} sector  섹터명
 * @returns {number} 적정 PER
 */
export function sectorFairPer(sector) {
  const s = String(sector ?? "");
  if (/바이오|제약|헬스|의료/.test(s)) return 22;
  if (/IT|플랫폼|소프트|반도체|인터넷|게임|미디어|콘텐츠|통신/.test(s)) return 17;
  return 12; // 제조·금융·유통·기타 기본값
}

/**
 * 목표가 산출
 * @param {number} currentPrice  현재가
 * @param {number} eps           EPS (원, Naver 기준 우선 / 없으면 DART 추산)
 * @param {number} bps           BPS (원)
 * @param {object} fin           parseFinancials() 결과
 * @param {number} marketCap     시가총액 (원, 0이면 BPS 기반)
 * @param {number} fairPer       업종별 적정 PER (기본 12 — 호출부에서 sectorFairPer로 전달)
 * @returns {{shortTargetPrice:number|null, midTargetPrice:number|null, shortTargetPct:number|null, midTargetPct:number|null, marketPer:number|null, growthPremium:boolean}}
 */
export function calcTargetPrice(currentPrice, eps, bps, fin, marketCap, fairPer = 12) {
  if (!currentPrice || currentPrice <= 0)
    return { shortTargetPrice: 0, midTargetPrice: 0, shortTargetPct: 0, midTargetPct: 0, marketPer: null, growthPremium: false };

  const ni  = fin?.netIncome?.current  ?? 0;
  const eq  = fin?.totalEquity?.current ?? 0;

  // ── EPS / BPS 확보 ───────────────────────────────────────
  let effectiveEps = eps > 0 ? eps : 0;
  let effectiveBps = bps > 0 ? bps : 0;

  // Naver EPS 없을 때 DART 순이익 ÷ 주식 수(시총/현재가)로 추산
  if (effectiveEps === 0 && ni > 0 && marketCap > 0 && currentPrice > 0) {
    const shares = marketCap / currentPrice;
    effectiveEps = Math.round(ni / shares);
  }
  // BPS도 없을 때 DART 자본총계 ÷ 주식 수로 추산
  if (effectiveBps === 0 && eq > 0 && marketCap > 0 && currentPrice > 0) {
    const shares = marketCap / currentPrice;
    effectiveBps = Math.round(eq / shares);
  }

  // ── 적정 PER (업종별) ────────────────────────────────────
  const FAIR_PER = fairPer > 0 ? fairPer : 12;
  const FAIR_PBR = 1.0;

  // ── 시장 PER · 성장 프리미엄 감지 ────────────────────────
  // 시장이 적정 PER의 2.5배를 초과하는 가격을 부여하면(예: 전력 슈퍼사이클 성장주) PER 기반
  // 적정가 모델은 의미를 잃고 -90%대 가짜 "하락위험"을 만든다 → 목표가 미산출(null), 프리미엄 표기.
  const marketPer = (ni > 0 && marketCap > 0) ? +(marketCap / ni).toFixed(1) : null;
  const growthPremium = marketPer != null && marketPer > FAIR_PER * 2.5;
  if (growthPremium) {
    return { shortTargetPrice: null, midTargetPrice: null, shortTargetPct: null, midTargetPct: null, marketPer, growthPremium: true };
  }

  let midTarget = 0;
  if (effectiveEps > 0) {
    midTarget = Math.round(FAIR_PER * effectiveEps);
  } else if (effectiveBps > 0) {
    // EPS 음수·0이면 PBR 1.0 기준 목표가
    midTarget = Math.round(FAIR_PBR * effectiveBps);
  }

  // 목표가가 현재가보다 낮더라도 그대로 유지 (오히려 고평가 신호로 활용)
  const shortTarget = midTarget > 0
    ? Math.round((currentPrice + midTarget) / 2)
    : 0;

  const shortPct = shortTarget > 0
    ? +((shortTarget - currentPrice) / currentPrice * 100).toFixed(1)
    : 0;
  const midPct = midTarget > 0
    ? +((midTarget - currentPrice) / currentPrice * 100).toFixed(1)
    : 0;

  return {
    shortTargetPrice: shortTarget,
    midTargetPrice:   midTarget,
    shortTargetPct:   shortPct,
    midTargetPct:     midPct,
    marketPer,
    growthPremium:    false,
  };
}

/**
 * 추천 한 줄 텍스트 생성
 * @param {number} longScore     중장기 점수
 * @param {string} valNote       밸류에이션 note (e.g. "PER7.7(저평가), PBR0.61")
 * @param {number|null} midTargetPct  중기 목표가 상승률 (%)
 * @param {object} [opts]        { growthPremium?: boolean }
 */
export function buildRecommendation(longScore, valNote, midTargetPct, opts = {}) {
  // PER 문자열 파싱
  const perMatch = (valNote ?? "").match(/PER([\d.]+)\(([^)]+)\)/);
  const perStr   = perMatch ? `PER ${perMatch[1]}배 ${perMatch[2]}` : "";

  // 상승여력 / 위험 — 성장 프리미엄(시장 PER ≫ 적정 PER)일 때는 가짜 "하락위험"을 표기하지 않는다.
  let upsideStr;
  if (opts.growthPremium) {
    upsideStr = "밸류에이션 부담(성장 기대 선반영)";
  } else if (midTargetPct > 0) {
    upsideStr = `상승여력 +${midTargetPct}%`;
  } else if (midTargetPct != null && midTargetPct < -5) {
    upsideStr = `하락위험 ${midTargetPct}%`;
  } else {
    upsideStr = "";
  }

  // 액션 — 성장 프리미엄 종목은 midTargetPct가 null이므로 목표가 의존 분기를 타지 않게 처리.
  const mtp = midTargetPct ?? 0;
  let action;
  if      (longScore >= 80 && mtp >  15) action = "중장기 적극 매수 검토";
  else if (longScore >= 70 && mtp >   5) action = "중장기 매수 검토";
  else if (longScore >= 70)              action = "중장기 보유 검토";
  else if (longScore >= 55 && mtp >   5) action = "분할 매수 고려";
  else if (longScore >= 55)              action = "관망 유지";
  else if (longScore >= 40)              action = "투자 주의";
  else                                   action = "매수 비권고";

  return [perStr, upsideStr, action].filter(Boolean).join(", ");
}
