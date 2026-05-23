/**
 * stock-utils.js
 * 목표가 계산 + 추천 텍스트 공통 유틸
 */

/**
 * 목표가 산출
 * @param {number} currentPrice  현재가
 * @param {number} eps           EPS (원, Naver 기준 우선 / 없으면 DART 추산)
 * @param {number} bps           BPS (원)
 * @param {object} fin           parseFinancials() 결과
 * @param {number} marketCap     시가총액 (원, 0이면 BPS 기반)
 */
export function calcTargetPrice(currentPrice, eps, bps, fin, marketCap) {
  if (!currentPrice || currentPrice <= 0)
    return { shortTargetPrice: 0, midTargetPrice: 0, shortTargetPct: 0, midTargetPct: 0 };

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

  // ── 적정 PER (업종 기본값: 제조/일반 12배) ──────────────
  const FAIR_PER = 12;
  const FAIR_PBR = 1.0;

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
  };
}

/**
 * 추천 한 줄 텍스트 생성
 * @param {number} longScore     중장기 점수
 * @param {string} valNote       밸류에이션 note (e.g. "PER7.7(저평가), PBR0.61")
 * @param {number} midTargetPct  중기 목표가 상승률 (%)
 */
export function buildRecommendation(longScore, valNote, midTargetPct) {
  // PER 문자열 파싱
  const perMatch = (valNote ?? "").match(/PER([\d.]+)\(([^)]+)\)/);
  const perStr   = perMatch ? `PER ${perMatch[1]}배 ${perMatch[2]}` : "";

  // 상승여력
  const upsideStr = midTargetPct > 0
    ? `상승여력 +${midTargetPct}%`
    : midTargetPct < -5
      ? `하락위험 ${midTargetPct}%`
      : "";

  // 액션
  let action;
  if      (longScore >= 80 && midTargetPct >  15) action = "중장기 적극 매수 검토";
  else if (longScore >= 70 && midTargetPct >   5) action = "중장기 매수 검토";
  else if (longScore >= 70)                       action = "중장기 보유 검토";
  else if (longScore >= 55 && midTargetPct >   5) action = "분할 매수 고려";
  else if (longScore >= 55)                       action = "관망 유지";
  else if (longScore >= 40)                       action = "투자 주의";
  else                                            action = "매수 비권고";

  return [perStr, upsideStr, action].filter(Boolean).join(", ");
}
