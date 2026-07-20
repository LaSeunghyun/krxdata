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

// 2026-07-20: 확신도 기반 포지션 사이징 (사용자 요청 — "확실한 종목이면 한두개 몰빵 허용").
//   후보의 conviction(0~10) 이 strongThreshold 이상이면 5분산을 채우지 않고
//   현금의 strongFraction 을 그 한 종목에 집중 매수(몰빵). 그 외엔 기존 균등분산.
//   conviction 산식(stock-live.mjs): hi120=돌파%(≤10), rsi2=(10-rsi2)×레짐계수(UP1.0/NEUTRAL0.85/DOWN0.5).
//   조정 예) strongFraction=1.0 → 확실종목 1개 전액몰빵 / strongThreshold↑ → 몰빵 조건 더 엄격.
//   ※ 이 오버레이는 사용자 재량 요청이며 combo-v2 백테스트(분산 전제, PF1.98)로 검증된 값 아님.
export const CONVICTION_SIZING = Object.freeze({
  enabled: true,
  strongThreshold: 7,   // conviction(0~10) 이 값 이상 → "확실" → 집중(몰빵)
  strongFraction: 0.5,  // 확실 종목 1건에 현금의 이 비율 투입 (0.5=최대 2종목, 1.0=전액 1종목)
});
