export const LIVE_COMBO_CAPS = Object.freeze({
  UP: Object.freeze({ hi120: 6, rsi2: 4 }),
  NEUTRAL: Object.freeze({ hi120: 0, rsi2: 8 }),
  DOWN: Object.freeze({ hi120: 0, rsi2: 4 }),
});

export const BACKTEST_COMBO_CAPS = LIVE_COMBO_CAPS;

export const LIVE_MAX_ORDER_VALUE = 100_000;
export const LIVE_MAX_ORDERS_PER_DAY = 3;
// 2026-07-20: 소액 계좌(현금 ~44k) 대응 — 2슬롯 분할 시 슬롯예산(=자본/2≈22k)을 넘는 종목이
// "예산초과 영구"로 큐에서 드롭돼(paper-swing.js:645) 44k로 살 수 있는 한전(33,850) 등을 못 샀음.
// 1슬롯=전액 집중이면 자본 안에서 살 수 있는 최상위 신호를 실제 매수. 계좌 증액 시 2+로 복원 권장.
// (트레이드오프: 1포지션 집중 = 분산 없음. 44k에선 애초에 2종목 분산 불가라 집중이 현실적 정답.)
export const LIVE_SLOTS = 1;
export const LIVE_RSI2_UNIVERSE_LIMIT = 30;
