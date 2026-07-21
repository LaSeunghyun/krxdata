export const LIVE_COMBO_CAPS = Object.freeze({
  UP: Object.freeze({ hi120: 6, rsi2: 4 }),
  NEUTRAL: Object.freeze({ hi120: 0, rsi2: 8 }),
  DOWN: Object.freeze({ hi120: 0, rsi2: 4 }),
});

export const BACKTEST_COMBO_CAPS = LIVE_COMBO_CAPS;

export const LIVE_MAX_ORDER_VALUE = 100_000;
export const LIVE_MAX_ORDERS_PER_DAY = 3;
// 2026-07-20: 사이징 백테스트+MC(714k, 2023~2026, subsample0.8 ×10시드)로 slots 3 확정.
//   결과 — slots별 CAGR중앙/MDD중앙/원금손실:  1=45%/61%/(MC 35%파산, 기각)
//   2=64.6%/36.4%/0런  3=50.6%/29.8%/0런  5=31.5%/25.0%/0런  10=17%/16%.
//   slots=3 = 성장(중앙 50.6%, worst +30.8%)과 안정(MDD 30%)의 최적 균형, 파산 0.
//   전액몰빵(slots=1)은 수익·위험 둘 다 열등 + MC 파산 35%로 데이터 기각.
export const LIVE_SLOTS = 3;
export const LIVE_RSI2_UNIVERSE_LIMIT = 30;

// 2026-07-20: 확신도 기반 포지션 사이징 (사용자 요청 — "확실한 종목이면 한두개 몰빵 허용").
//   후보의 conviction(0~10) 이 strongThreshold 이상이면 5분산을 채우지 않고
//   현금의 strongFraction 을 그 한 종목에 집중 매수(몰빵). 그 외엔 기존 균등분산.
//   conviction 산식(stock-live.mjs): hi120=돌파%(≤10), rsi2=(10-rsi2)×레짐계수(UP1.0/NEUTRAL0.85/DOWN0.5).
//   ※ strongFraction 0.5 = 강신호 시 동적으로 slots=2(2종목)까지만 집중 → MC 검증 견고·고성장 구간.
//   ※ strongFraction 1.0(단일종목 전액몰빵)은 slots=1과 동일 = MC 파산 35%로 데이터 기각. 올리지 말 것.
//     strongThreshold↑ → 몰빵 조건 더 엄격.
export const CONVICTION_SIZING = Object.freeze({
  enabled: true,
  strongThreshold: 7,   // conviction(0~10) 이 값 이상 → "확실" → 집중(2종목 몰빵)
  strongFraction: 0.5,  // 확실 종목 1건에 현금 50% (= slots=2 상당, 견고구간). 1.0 금지(slots=1 파산위험)
});

// 2026-07-21: 예측 연동 이익보호 (forecast_ledger → 매매). 사용자 요청 "하락 예측 시 +종목 수익화".
//   하락경보(KOSPI 프록시 예측)일 때: 수익종목(+harvestRetPct↑) 트레일을 bearTrailPct로 조여 이익 확정,
//   패자·신규진입은 보류. forecast track record 0(오늘 시작)이라 shadow=true로 시작 —
//   실제 매도 없이 저널·로그에만 "이익보호 했을 것" 기록 → forecast-replay 백테스트 검증 후 shadow=false로 활성화.
//   임계(probDiff·minConf·harvestRetPct·bearTrailPct)는 백테스트로 확정 예정.
// 2026-07-21: 부분익절 (백테스트+MC 확정 — 순수트레일 대비 CAGR 50.6% vs 38.1%, MDD 31 vs 42, 승률 59 vs 53.5, 전부 개선).
//   기존 live는 순수트레일(열등)이었음. combo-v2 백테스트 tp1R=1/tp2R=2(=trailPct×N) 이식.
//   +tp1Pct 도달 → 절반 익절 / +tp2Pct 도달 → 잔량 절반 추가익절 / 나머지는 트레일(승자 태우기 유지).
export const PARTIAL_TP = Object.freeze({
  enabled: true,
  tp1Pct: 4,   // +4% → 절반 익절 (2026-07-21 백테스트+MC: +8/16 대비 CAGR 50.6→56.6·MDD 31→30·승률 59→61 전부 개선)
  tp2Pct: 8,   // +8% → 잔량 절반 추가 익절. 트레일은 8% 유지(러너 1/4는 넓게 태워 꼬리 포착)
});

export const FORECAST_GUARD = Object.freeze({
  enabled: true,
  shadow: true,          // true=기록만(실집행 없음), false=실제 이익보호 집행 (백테스트 검증 후 전환)
  probDiff: 15,          // 하락확률−상승확률 ≥ 이 %p면 하락경보 (call_direction=='down' 아니어도)
  minConf: 50,           // 위 확률차 조건의 최소 confidence
  harvestRetPct: 3,      // 이 수익률(%) 이상 종목만 이익보호 대상
  bearTrailPct: 3,       // 하락경보 시 트레일 폭 (평시 8% → 3%로 조임)
});
