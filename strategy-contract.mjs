export const LIVE_COMBO_CAPS = Object.freeze({
  UP: Object.freeze({ hi120: 6, rsi2: 4 }),
  NEUTRAL: Object.freeze({ hi120: 0, rsi2: 8 }),
  DOWN: Object.freeze({ hi120: 0, rsi2: 4 }),
});

export const BACKTEST_COMBO_CAPS = LIVE_COMBO_CAPS;

export const LIVE_MAX_ORDER_VALUE = 100_000;
export const LIVE_MAX_ORDERS_PER_DAY = 3;
// 2026-07-20: 코인자금 이전으로 계좌 ~714k 증액 → 분산 복원(combo-v2 엣지는 5~10종목 분산에서 나옴).
// 714k/5 ≈ 143k/슬롯 = 대형주 대부분 매수 가능 + 5분산으로 단일종목 리스크 완화.
export const LIVE_SLOTS = 5;
export const LIVE_RSI2_UNIVERSE_LIMIT = 30;
