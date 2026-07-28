const REGIME_RSI_FACTOR = Object.freeze({ UP: 1, NEUTRAL: 0.85, DOWN: 0.5 });

export function buildLiveCandidates(rows, {
  regime,
  rsiMax = 10,
  minBreakout = 3,
  allowUpRsi = true,
  rsiVolMin = 0,    // rsi2 확인필터: 거래량비(당일/20일평균) ≥ 이 값 (투매 확인). 0=off
  closeLocMin = 0,  // rsi2 확인필터: 종가위치((c-l)/(h-l)) ≥ 이 값 (강한 마감). 0=off
  volSurge = null,  // 거래량급증 진입 sub {volMin,dayRetMin,closeLocMin}. null=off(라이브 기본 — 검증 전까지 동작 불변). DOWN 레짐 제외.
  regimeOf = null,  // 2026-07-27 검증용: 종목별 레짐 함수 (row → 'UP'|'NEUTRAL'|'DOWN'). null=시장 프록시 단일 레짐(현행 라이브).
} = {}) {
  const candidates = [];
  for (const row of rows) {
    const reg = regimeOf ? (regimeOf(row) ?? regime) : regime;
    const volOk = !rsiVolMin || Number(row.volRatio ?? 1) >= rsiVolMin;
    const clOk = !closeLocMin || Number(row.closeLoc ?? 1) >= closeLocMin;
    if (Number(row.rsi) < rsiMax && (reg !== 'UP' || allowUpRsi) && volOk && clOk) {
      candidates.push({
        ...row,
        sub: 'rsi2',
        conviction: (rsiMax - Number(row.rsi)) * (REGIME_RSI_FACTOR[reg] ?? 0.85),
      });
    }
    if (reg === 'UP' && Number(row.breakoutPct) >= minBreakout) {
      candidates.push({
        ...row,
        sub: 'hi120',
        conviction: Math.min(10, Number(row.breakoutPct)),
      });
    }
    // 거래량급증 진입: 대량거래(volRatio)+양봉(dayRet)+강한마감(closeLoc)이 동반된 모멘텀. 촉매(공시/뉴스)는 대개 거래량으로 먼저 드러남.
    if (volSurge && reg !== 'DOWN'
      && Number(row.volRatio ?? 0) >= volSurge.volMin
      && Number(row.dayRet ?? -1e9) >= (volSurge.dayRetMin ?? 0)
      && Number(row.closeLoc ?? 0) >= (volSurge.closeLocMin ?? 0)) {
      candidates.push({
        ...row,
        sub: 'volsurge',
        conviction: Math.min(10, Number(row.volRatio) * 2) * (REGIME_RSI_FACTOR[reg] ?? 0.85),
      });
    }
  }
  candidates.sort((a, b) => {
    const convictionOrder = b.conviction - a.conviction;
    if (convictionOrder) return convictionOrder;
    if (a.sub === b.sub) return 0;
    return a.sub === 'hi120' ? -1 : 1;
  });
  return candidates;
}

export function liveCandidateBudget({
  cash,
  equity,
  slots,
  conviction,
  strongThreshold,
  strongFraction,
  exposureMultiplier = 1,
}) {
  const perSlot = Math.floor(equity / slots);
  const baseBudget = conviction >= strongThreshold ? Math.floor(cash * strongFraction) : Math.min(cash, perSlot);
  const multiplier = Math.max(0, Math.min(1, Number(exposureMultiplier) || 0));
  return Math.floor(baseBudget * multiplier);
}
