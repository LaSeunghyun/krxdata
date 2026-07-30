export const LIVE_COMBO_CAPS = Object.freeze({
  UP: Object.freeze({ hi120: 6, rsi2: 4 }),
  NEUTRAL: Object.freeze({ hi120: 0, rsi2: 8 }),
  DOWN: Object.freeze({ hi120: 0, rsi2: 4 }),
});

export const BACKTEST_COMBO_CAPS = LIVE_COMBO_CAPS;

export const LIVE_MAX_ORDER_VALUE = 100_000;
export const LIVE_MAX_ORDERS_PER_DAY = 3;
// 2026-07-20: 사이징 백테스트+MC(714k, 2023~2026, subsample0.8 ×10시드)로 slots 3 확정 (uni40 기준).
//   결과 — slots별 CAGR중앙/MDD중앙/원금손실:  1=45%/61%/(MC 35%파산, 기각)
//   2=64.6%/36.4%/0런  3=50.6%/29.8%/0런  5=31.5%/25.0%/0런  10=17%/16%.
//   slots=3 = 성장(중앙 50.6%, worst +30.8%)과 안정(MDD 30%)의 최적 균형, 파산 0.
//   전액몰빵(slots=1)은 수익·위험 둘 다 열등 + MC 파산 35%로 데이터 기각.
// 2026-07-24: 유니버스 40→420 확장(사용자 요청) — 그대로(slots3/trail8/tp+4·8)는 5시드 MC서 CAGR 34.3→27.9%↓
//   MDD 18.2→35.4%↑로 전부 악화(대형주 대비 소형주 노이즈↑) 확인. 위험관리 재조정 스윕(단일경로+5시드MC) 결과:
//   slots=5(3/8/10보다 우위, MDD 20.6% vs 36.7%) + trail=6/tp1R=1·tp2R=2(=+6%/+12%, 8·4·8보다 우위)가
//   uni420 최적: 5시드 MC 평균 CAGR 43.9%·MDD 19.9%(uni40 기존 대비도 CAGR+9.6%p 우위, MDD 거의 동급) —
//   slots=6·trail5 등 인접값도 확인했으나 5시드 MC서 slots=5/trail=6 조합이 더 강건(단일경로 순위와 다름, MC로 뒤집힘).
//   sectorcap·rsivol 재스윕도 했으나 기존값(0/1.25) 그대로가 최적 유지.
export const LIVE_SLOTS = 5;
export const LIVE_UNIVERSE_LIMIT = 420;
export const LIVE_RSI2_UNIVERSE_LIMIT = LIVE_UNIVERSE_LIMIT;

// 2026-07-22: 봇 제외종목 — 사용자가 수동 관리하는 개인 보유(봇이 매수·매도·손절 전부 스킵).
//   토스 계좌에 있어도 stock-live가 건드리지 않음. 예: 한화솔루션(009830) 평단 32,219 −14% 물린 것 손절 방지.
export const LIVE_EXCLUDE = new Set(['009830']);

// 2026-07-22: 자본기반 진입(사용자 요청 B — "특정금액 이상되면 구매"). 큰 현금 유입 시 종목수 게이트가
//   현금을 방치(예: 한화솔루션 손절로 588만 유입됐는데 레거시 5종목이 슬롯 채워 신규매수 차단 → 91% 유휴)하는 문제 해결.
//   게이트를 '종목수 < slots' → '자본 기준'으로 전환: perSlot=equity/slots, 유휴현금 ≥ perSlot*minFillFraction 이면 편입.
//   레거시 dust(시가평가 < perSlot*dustFraction)는 슬롯 카운트에서 제외 → 큰 현금이 dust에 막히지 않음.
//   ※ 트레이드오프: 이건 backtest native(현금기반 재투입)와 동일 = MC 중앙 ~56.6%(capped-3의 60.7%보다 낮음).
//     정상 상황선 capped가 미세우위였으나, 큰 현금 방치(0% 수익)는 그보다 훨씬 열등 → 사용자 결정 B로 전환.
//     enabled=false면 기존 종목수 게이트로 롤백.
export const CAPITAL_DEPLOY = Object.freeze({
  enabled: true,
  dustFraction: 0.5,     // 시가평가액 < perSlot*dustFraction 인 포지션은 '슬롯'으로 카운트 안 함(레거시 dust 무시)
  minFillFraction: 0.5,  // 유휴현금 ≥ perSlot*minFillFraction(반슬롯) 이면 편입 실행
});

// 2026-07-22: 섹터 캡(사용자 요청 — "너무 섹터가 똑같아 리스크 크다"). 같은 섹터 동시보유를 max로 제한.
//   근거: backtest-swing --sectorcap 스윕 (slots3·maxpos0·rsiuni30, 2023~2026). MC 6시드 중앙값 —
//     cap0(현행): CAGR72.6%·최종63.3M·MDD33% / cap1: CAGR75.8%·최종67.3M·MDD31.7% / cap2: 71.5%·62.1M·34%.
//   cap=1이 단일경로+MC 방향 일치(강건). 수익은 시드별 3:3 혼전이나 낙폭·최악시드 방어 뚜렷 + 금융 편중 원천차단.
//   섹터 출처=stock_analysis.sector. NULL 섹터는 캡 미적용(카운트 0). enabled=false면 롤백.
// 2026-07-22 재검증(live-parity+MC): 섹터캡 "우위"는 생존편향 이상화 엔진 결과였고, 현실 엔진선 효과가 노이즈(부호가 tp에 따라 뒤집힘).
//   +4/8 config에선 cap0(해제)이 중앙 최종 10.9M > cap1 9.95M. 사용자 "수익 높은 쪽" 지시 → enabled=false로 해제.
//   ※ 금융 편중 다시 허용됨(수익 우선). 상시 검증기(validate-hypotheses.mjs)가 이 판정을 매일 재확인 → 뒤집히면 경보.
export const SECTOR_CAP = Object.freeze({
  // ★ 2026-07-30: 활성화했다가 **검증 결과 효과 0으로 나와 되돌렸다.**
  //   30시드 MC(노이즈 바닥 0.268, mc-rotate에서 측정):
  //     off      CAGR 35.0% · MDD 20.2% · Calmar 1.73
  //     캡 2     CAGR 34.0% · MDD 19.8% · Calmar 1.72  (Δ-0.01 = 효과 없음)
  //     캡 3     CAGR 32.1% · MDD 21.0% · Calmar 1.53  (Δ-0.20 = 노이즈 내)
  //     캡 1     CAGR 26.0% · MDD 21.2% · Calmar 1.22  (Δ-0.51 = **실질 악화**) ← 이게 구 기본값이었다
  //   단일경로에서 MDD 25.7%→15.2%로 보였던 개선이 30시드에서 소멸(20.2%→19.8%).
  //   추정 메커니즘: rsi2가 한 섹터로 슬롯을 채우는 날은 그 섹터가 과매도인 날이고,
  //   그때 대안 후보는 과매도가 아니다. 캡은 좋은 신호를 나쁜 신호로 바꾼다.
  //   ※ max 1이 실질 악화였다는 점은 기록해둔다 — 켜려면 최소 2 이상이어야 한다.
  enabled: false,
  max: 2,
});

/**
 * ★ 2026-07-30: stock_analysis.sector 보정 맵.
 *
 * 문제: SECTOR_CAP이 쓰는 `stock_analysis.sector`가 핵심 종목에서 틀렸다. 목표(반도체 편중 차단)와
 * 정반대로 작동한다 — **SK스퀘어를 금융으로 통과시키고 LG전자를 반도체로 막는다.**
 *   SK스퀘어(402340)  DB 금융·보험      실제 SK하이닉스 지분 20% 보유 반도체 지주사
 *   SK(034730)        DB 금융·보험      실제 하이닉스 최상위 지배 지주사
 *   LG전자(066570)    DB 반도체·전자부품  실제 가전·전장
 *   현대차(005380)    DB 조선·운송장비   실제 자동차
 *   삼성SDI(006400)   DB 기계·장비      실제 배터리
 *   두산에너빌리티(034020) DB 자동차·부품  실제 발전설비
 *
 * 분류 근거는 이름이 아니라 **실측 잔차상관**이다. 60거래일 수익률에서 횡단면 평균(시장요인)을
 * 뺀 잔차를 SK하이닉스와 상관 낸 값(도출: diag 스크립트, 상위 시총 30 유니버스):
 *   SK하이닉스 1.000 · SK스퀘어 0.806 · 삼성전자 0.689 · SK 0.581 · 삼성전기 0.479 · 삼성물산 0.464
 *   ── 임계 0.45 ──
 *   삼성생명 0.200 · LS일렉트릭 0.048 · HD현대일렉트릭 0.039 · LG전자 -0.062 · NAVER -0.308
 * 시장요인을 빼기 전에는 현대차 0.550 · HD현대일렉트릭 0.561로 베타에 섞여 구분이 안 됐다.
 *
 * ※ 한계: 60일 상관은 국면에 따라 변한다. 정적 목록이므로 **분기마다 재도출해야 한다.**
 *   AI/메모리 사이클이 꺾이면 상관 구조가 바뀌고 이 목록은 낡는다.
 */
export const SECTOR_OVERRIDE = Object.freeze({
  '000660': '반도체복합',   // SK하이닉스
  '402340': '반도체복합',   // SK스퀘어 — DB는 금융·보험
  '005930': '반도체복합',   // 삼성전자
  '034730': '반도체복합',   // SK — DB는 금융·보험
  '009150': '반도체복합',   // 삼성전기
  '028260': '반도체복합',   // 삼성물산
  '066570': '가전·전장',    // LG전자 — DB는 반도체·전자부품(오분류)
  '005380': '자동차',       // 현대차 — DB는 조선·운송장비
  '006400': '2차전지',      // 삼성SDI — DB는 기계·장비
  '034020': '발전설비',     // 두산에너빌리티 — DB는 자동차·부품
});

/** stock_analysis.sector 에 보정을 덮어씌운다. 양쪽(라이브·백테)이 같은 함수를 쓰게 한다. */
export function applySectorOverride(sectorMap) {
  return { ...sectorMap, ...SECTOR_OVERRIDE };
}

// 2026-07-22: 백테스트 캠페인 승자 이식 (skipNrsi + rsivol1.5). combo-v2 baseline 대비 MC 6시드 전승:
//   CAGR 19.4→36.6%, MDD 22.4→20.3%, Calmar 0.87→1.80. rsi2(과매도) 매수를 —
//   (1) 투매 거래량 동반(당일 ≥ 20일평균×volMin)에만 (2) NEUTRAL 레짐선 스킵.
//   근거: 투매확인=진짜 패닉반등만(가짜신호 제거) + NEUTRAL rsi2는 우리 실거래서 순손실. 리서치·데이터 둘 다 지지.
//   ※ 여전히 생존편향 포함(절대수치는 낙관)이나 baseline 대비 상대우위는 6/6 강건. hi120(돌파)엔 미적용.
export const RSI_ENTRY_FILTER = Object.freeze({
  // ★ 2026-07-29 변경: 1.25 → 0 (필터 해제). 사용자 승인.
  //   왜 바꾸나: 2026-07-22 채택 근거가 "1.25 vs 1.5" 비교였다 — **필터를 안 쓰는 경우(0)와 비교한 적이 없다.**
  //   필터의 존재 자체가 미검증이었다.
  //   측정 9대 2로 0 우세:
  //     MC IS   Calmar 1.19 vs 0.73 · 시드 7승3패 · MDD 16.22 vs 19.09
  //     MC OOS  Calmar 2.87 vs 2.99(-4%) · 시드 6승4패 · **중앙 CAGR 56.20 vs 45.80** · MDD 18.43 vs 18.82
  //     워크포워드 3개월창 6승3패(9창) · **6개월창 3승0패** (CAGR 67.7 vs 47.1 · MDD 8.6 vs 13.1)
  //   유일한 패배는 OOS **평균** Calmar -4%이고 10시드 중 2개(-54·-34)가 끌어내린 값. 중앙값은 0 우세.
  //   메커니즘: 필터 제거 → 후보 증가(체결 +5%) → 분산 개선 → **MDD가 모든 측정에서 낮다.**
  //     원래 논리("투매 확인으로 가짜신호 제거")는 신호 품질을 올리지만 분산을 깎는 대가가 계산되지 않았다.
  //   ★ 프론티어 근거: rsivol×ATR 5조합의 IS/OOS 순위상관이 **-1.0**(완전 역순)이다. 지배적 점이 없고
  //     국면은 워크포워드에서 예측 불가로 나왔다 → **최악 구간 Calmar가 가장 높은 점**을 고른다.
  //     vol0 1.16 > 현행 0.93 > ATRmax5 0.79 > ATR순위 0.70. vol0가 유일하게 양쪽 MDD도 개선.
  volMin: 0,         // rsi2 매수 시 당일거래량 ≥ 20일평균 × 이 배수 (투매 확인). 0=off. 되돌리려면 1.25.
  skipNeutral: true, // NEUTRAL 레짐선 rsi2 매수 스킵
});

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
// 2026-07-24: 유니버스 420 확장에 맞춰 trail 8→6, tp1R/tp2R 1→2 재조정(5시드 MC 최적, LIVE_SLOTS 주석 참조).
export const PARTIAL_TP = Object.freeze({
  enabled: true,
  tp1Pct: 6,   // +6% → 절반 익절 (=trail6%×tp1R1, 2026-07-24 uni420 재조정)
  tp2Pct: 12,  // +12% → 잔량 절반 추가 익절 (=trail6%×tp2R2). 트레일도 6%로 축소(uni420 소형주 변동성 대응)
});

// 2026-07-25: 수급붕괴 청산 (사용자 제안 → 백테 검증 → 사용자 배포 결정).
//   hi120(돌파) 보유분만 대상. 최근 days 거래일 누적 (기관+외국인) 순매수 ≤ 0 이면 익절/손절 도달 전에도 전량 청산.
//   근거(라이브패리티 10시드 MC, uni420·slots5·trail6·tp1r1·tp2r2):
//     CAGR 36.8→37.2%(+0.5%p = 중립, 4승6패) / **MDD 22.3→20.5%(-1.8%p, 6승4패)** / Calmar 1.65→1.82
//     낙폭 개선이 최악 시드에 집중(23.6→18.2 · 23.0→18.3 · 25.5→20.0 · 27.5→18.3) = 나쁜 꼬리 절단
//     단일경로선 윈도 3~20 전 구간이 베이스라인 상회(플래토=실제효과 근거)하나 MC서 CAGR은 flat으로 수렴 → **수익개선 아님, 낙폭도구**
//   데이터 = stock_investor_flows(KIS, 매일 18:00 cron, 422종목·30일 롤링). KRX(pykrx) 수치와 완전일치 실측 확인.
//   수급은 장마감 후 확정이므로 T-1 기준 판정(백테와 동일). 데이터 10일 미확보 종목은 룰 미적용(통과).
export const FLOW_EXIT = Object.freeze({
  enabled: true,
  days: 10,        // 누적 윈도(거래일). MC서 d5는 기각(CAGR -3.1%p), d10 채택
  threshold: 0,    // 누적 순매수(억) ≤ 이 값이면 청산. 0=순매도 전환
});

// 2026-07-22: Corporate-action 서킷브레이커 (사용자 지적 — 무상증자·액면분할 권리락 급락에 헐값 자동매도 방지).
//   직전 관측 대비 dropPct 초과 급락 = 기계적 조정 가능성 → 자동매도 전면 보류 + 텔레그램 경보.
//   ret이 clearRet 이상 회복(평단 조정/신주 반영) 시 정상 재개. 백테스트는 수정주가라 미재현 = 라이브 전용 안전가드.
export const CA_GUARD = Object.freeze({
  enabled: true,
  dropPct: 25,     // 직전 관측 대비 -25% 초과 1스텝 급락 → corporate action 의심(대형주 유기적 급락은 극히 드묾)
  clearRet: -10,   // 수익률이 이 값(%) 이상 회복되면 조정 반영된 것 → 정상 청산로직 재개
});

export const FORECAST_GUARD = Object.freeze({
  enabled: true,
  shadow: true,          // true=기록만(실집행 없음), false=실제 이익보호 집행 (백테스트 검증 후 전환)
  probDiff: 15,          // 하락확률−상승확률 ≥ 이 %p면 하락경보 (call_direction=='down' 아니어도)
  minConf: 50,           // 위 확률차 조건의 최소 confidence
  harvestRetPct: 3,      // 이 수익률(%) 이상 종목만 이익보호 대상
  bearTrailPct: 3,       // 하락경보 시 트레일 폭 (평시 8% → 3%로 조임)
});
