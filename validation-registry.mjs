// 상시 검증 가설 레지스트리 (2026-07-22, 2026-08-22 라이브 계약 동기화)
// 오늘 세션에서 돌린 모든 백테스트/판정 + 데이터 가설을 등록.
// validate-hypotheses.mjs 가 매일 live-parity + MC 로 재검증 → validation_ledger 적재 → 판정이 뒤집히면 텔레그램 경보.
// ※ 실계좌 파라미터는 절대 자동 변경 안 함. 경보 → 사람 + 백테스트/MC 재확인 → 사람이 결정.

import {
  LIVE_SLOTS, LIVE_UNIVERSE_LIMIT, TRAIL_PCT, PARTIAL_TP, RSI_ENTRY_FILTER,
} from './strategy-contract.mjs';

/**
 * ★ 2026-08-22 갱신 — base 를 **계약에서 파생**시킨다(하드코딩 폐기).
 *
 * ═══ 왜 ═══
 * 직전까지 base 는 `slots 3 · rsiuni 40 · tp1r 0.5 · tp2r 1 · to 20260611` 하드코딩이었다(2026-07-22 기준).
 * 그 사이 라이브는 07-24 유니버스 420 확장에 맞춰 `slots 5 · trail 8→6 · tp1R/tp2R 1→2` 로 옮겼고
 * 07-29 에 `rsivol` 을 껐다(`RSI_ENTRY_FILTER.volMin 1.25→0`, 사용자 승인).
 * → **VM 일일 크론이 약 4주간 라이브와 다른 전략을 재검증했다.** 게다가 `--to 20260611` 은
 *   방법론 §1-B 가 "가장 큰 함정"으로 지목한 **폭락 제외 구간**이라 방어장치 검정이 성립하지 않았다.
 *
 * 하드코딩을 다시 넣으면 같은 드리프트가 재발한다. 그래서 `strategy-contract.mjs` 에서 파생시키고
 * `tests/validation-registry.test.js` 가 계약과의 일치를 기계 검증한다.
 *
 * ═══ 포함 이유가 자명하지 않은 것들 ═══
 * · `--gapaxis --scenpolicy gap-pol.json` — 라이브 `stock-live.mjs gapPolicyToday()` 가 매일 005930
 *   시가갭으로 G1/G2 면 trail 6→10 · tp 6/12→10/20 을 **상시 오버라이드**한다. 빼면 라이브가 아닌
 *   전략을 기준선으로 삼게 된다. (단 갭정책 자체의 채택 근거는 오염 소스 위에 있다 — mc-volthrottle.mjs 주석 참조)
 * · `--capital 6000000` — 실계좌 규모. mc-*.mjs 들은 백테 기본 10,000,000 을 쓰므로
 *   **mc-* 결과와 이 크론 결과는 자본이 다르다**(비율지표는 거의 같지만 정수주 사이징에서 갈릴 수 있다).
 * · `--rsiuni` 제거 — live-parity 에선 유니버스가 LIVE_UNI 로 고정돼 무효다(2026-07-22 확인).
 * · `--stoppct` 미지정 — backtest-swing.mjs STRATEGIES['combo-v2'].stopPct 가 이미 15 로 HARD_STOP_PCT 와 같다.
 *
 * ═══ 궤적 불연속 ═══
 * 이 변경 이후 같은 hyp_id 라도 **다른 설정에서 잰 값**이다. ledger 비교 시 `lp_version` 으로 가른다.
 */
export const LIVE_PARITY_VERSION = '2026-08-22';

const tp1R = PARTIAL_TP.tp1Pct / TRAIL_PCT;   // 6 / 6 = 1
const tp2R = PARTIAL_TP.tp2Pct / TRAIL_PCT;   // 12 / 6 = 2

export const BACKTEST_FROM = '20230102';
export const BACKTEST_TO = '20260724';        // 방법론 §1-B: 폭락 포함. 캔들 캐시 최대일에 맞춘다.

// override(변형)는 runner가 앞에 prepend → backtest-swing argOf(indexOf=첫값) 규칙상 override가 base를 이긴다.
// presence 플래그를 끄는 arm 은 `__DROP:--flag` 를 쓴다(validation-lib.mjs mergeArgs).
export const LIVE_PARITY_BASE = Object.freeze([
  '--strategies', 'combo-v2', '--live-parity',
  ...(RSI_ENTRY_FILTER.skipNeutral ? ['--skipneutralrsi'] : []),
  '--slots', String(LIVE_SLOTS),
  '--liveuni', String(LIVE_UNIVERSE_LIMIT),
  '--trail', String(TRAIL_PCT),
  '--tp1r', String(tp1R), '--tp2r', String(tp2R),
  '--rsivol', String(RSI_ENTRY_FILTER.volMin),
  '--sectorcap', '0',
  '--gapaxis', '--scenpolicy', 'gap-pol.json',
  '--from', BACKTEST_FROM, '--to', BACKTEST_TO, '--capital', '6000000',
]);

// 각 가설: variants 각각을 MC(subsample 0.8 × seeds) 돌려 medianFinal(중앙 최종자본) 최대인 쪽이 '현재 승자'.
// myVerdict = 내가 내린 판정. currentWinner 가 myVerdict 와 어긋나면 FLIP 경보.
// ⚠️ myVerdict 는 "라이브 현재값" 이어야 의미가 있다 — 어긋나면 경보가 상시 울려 신호가 죽는다.
export const HYPOTHESES = Object.freeze([
  { id: 'slots', desc: '슬롯 수(분산도)', myVerdict: 's5',
    myVerdictNote: '라이브 LIVE_SLOTS=5. 2026-07-24 uni420 확장 때 3→5(MDD 20.6% vs 36.7%). 이전 판정 s3 은 uni40 시절 값',
    variants: { s3: ['--slots', '3'], s5: ['--slots', '5'], s8: ['--slots', '8'] } },

  { id: 'sectorcap', desc: '섹터캡', myVerdict: 'cap0',
    myVerdictNote: '노이즈, cap0 소폭 우위(생존편향 정정). cap1 은 Δ-0.51 악화(방법론 §5)',
    variants: { cap0: ['--sectorcap', '0'], cap1: ['--sectorcap', '1'], cap2: ['--sectorcap', '2'] } },

  // 이름은 trail 기준 실제 익절 %. 라이브 trail 6 → tp1R 1 = +6%, tp2R 2 = +12%.
  // 구 이름 tp_4_8/tp_8_16 은 trail 8 시절 산식이라 폐기(라이브가 6으로 내려와 의미가 어긋났다).
  { id: 'partialtp', desc: '부분익절 레벨(trail 배수)', myVerdict: 'tp_6_12',
    myVerdictNote: '라이브 PARTIAL_TP 6%/12% (=trail6×1, ×2). 2026-07-24 uni420 재조정. 이전 판정 tp_4_8 은 trail8 시절 값',
    variants: { tp_3_6: ['--tp1r', '0.5', '--tp2r', '1'], tp_6_12: ['--tp1r', '1', '--tp2r', '2'], tp_12_24: ['--tp1r', '2', '--tp2r', '4'] } },

  { id: 'rotate', desc: '최약슬롯 교체(로테이션)', myVerdict: 'off',
    myVerdictNote: '기각 — Calmar 1.73→0.37 · 시드 0승 30패(방법론 §5)',
    variants: { off: [], on: ['--rotate'] } },

  { id: 'regimeexp', desc: '레짐 노출 스로틀(약세 현금보유)', myVerdict: 'full',
    myVerdictNote: '기각 — 풀투자>스로틀(MC: CAGR 19.4>15.6, MDD 22.4<24.4). rsi2가 DOWN서도 벌고 레짐 감지 지연',
    variants: { full: [], throttle: ['--regimeexp', '1.0,0.7,0.5'] } },

  { id: 'relstop', desc: '상대손절(시장 대비 N배 하락 시 매도)', myVerdict: 'off',
    myVerdictNote: '기각 — MC서 CAGR↓·MDD↑. mean-reversion 엣지와 충돌(반등할 눌림을 컷)',
    variants: { off: [], on2: ['--relstop', '2'], on3: ['--relstop', '3'] } },

  // ★ 2026-07-29 라이브가 volMin 1.25 → 0 으로 되돌렸다(사용자 승인). base 가 그 값을 따라가므로
  //   off 는 빈 variant 로 충분하다. 이전 myVerdict 'on' 은 07-22 채택 시점 값이라 라이브와 모순이었다.
  { id: 'rsivol', desc: 'rsi2 투매 거래량 확인', myVerdict: 'off',
    myVerdictNote: '라이브 RSI_ENTRY_FILTER.volMin=0(2026-07-29 사용자 승인으로 되돌림). 07-22 채택본은 uni40·slots3 시절 측정',
    variants: { off: [], on125: ['--rsivol', '1.25'], on150: ['--rsivol', '1.5'] } },

  // ★ presence 플래그라 prepend 로 못 끈다 → base 에서 빼는 __DROP: 을 쓴다.
  //   구 winner_stack 가설(baseline:[] vs winner:[skipneutral+rsivol1.25])을 대체한다.
  //   base 가 라이브를 담게 되면서 baseline:[] 이 skipneutral 을 상속받아 두 arm 이 같아졌기 때문이다.
  { id: 'skipneutral', desc: 'NEUTRAL 레짐 rsi2 스킵(라이브 적용중)', myVerdict: 'on',
    myVerdictNote: '라이브 RSI_ENTRY_FILTER.skipNeutral=true. 허용 시 Δ-1.05 · 6승54패(방법론 §5 통과 3축 중 하나)',
    variants: { on: [], off: ['__DROP:--skipneutralrsi'] } },

  // 승자 위 스택이 아니라 **라이브 위 스택**으로 바꿨다(base 가 라이브라 중복 지정이 불필요해졌다).
  { id: 'volsize', desc: '변동성 사이징(ATR 타겟, 라이브 위 스택)', myVerdict: 'off',
    myVerdictNote: '기각 — Calmar 1.80→1.13(MC). 고변동 투매반등(엣지)을 downsize해 수익 붕괴',
    variants: { off: [], on: ['--atrsize', '3'] } },

  // 갭정책이 base 에 들어왔다 → 그 자체를 매일 재검증한다. 채택 근거가 오염 소스(candles-daily.jsonl,
  // 가짜 가격점프 18종목) 위에 있었고 정제본 단일경로에선 Δ+0.05 뿐이었다(mc-volthrottle.mjs 주석).
  { id: 'gappolicy', desc: '갭정책(G1/G2 시 trail·tp 확대) — 라이브 상시 적용중', myVerdict: 'on',
    myVerdictNote: '라이브 stock-live.mjs gapPolicyToday() 상시. ⚠️ 원 채택근거는 오염 소스 기반 — 정제본 재검증 중',
    variants: { on: [], off: ['__DROP:--gapaxis', '__DROP:--scenpolicy'] } },

  // 메타 모니터: 이상화 vs live-parity 갭(생존편향 크기) 추적. 승자 안 뽑고 갭 비율만 INFO 기록.
  { id: 'liveparity_gap', desc: 'live-parity vs 이상화(생존편향 갭)', monitor: true,
    myVerdictNote: '이상화 과대(생존편향) — 갭 축소 여부 추적',
    variants: { liveparity: [], idealized: ['__DROP_LIVE_PARITY__'] } },
]);

// 바벨 배분 가설 (2026-07-22 사용자 요청): 안정 75%(combo-v2 live-parity) + 공격 15%(hi120 모멘텀 UP게이트) + 현금 10%.
//   분기 리밸런싱. 100% 안정 대비 최종자본 우위인지 매일 재검증. ※ 공격 sleeve(hi120)는 momUniverse=생존편향 → 바벨쪽 낙관적임(정직 단서).
export const BARBELL = Object.freeze({
  id: 'barbell_75_15',
  desc: '바벨 안정75%(combo-v2)+공격15%(hi120)+현금10% vs 100% 안정',
  myVerdict: 'stable100',
  myVerdictNote: '리서치 바벨(P1-3) 전부 REJECTED — 100% 안정 대비 우위 불확실',
  aggressiveArgs: ['--strategies', 'hi120', '--hislots', '2', '--hiregime', 'up',
    '--from', BACKTEST_FROM, '--to', BACKTEST_TO, '--capital', '6000000'],
  weights: { core: 0.75, sat: 0.15, cash: 0.10 },
});

// 데이터 기반(비-백테스트) 가설 — runner가 별도 처리.
export const DATA_HYPOTHESES = Object.freeze([
  { id: 'forecast_edge', type: 'forecast-skill', desc: '예측 방향 엣지', myVerdictNote: '미검증(anti-predictive, HOLD)' },
  { id: 'live_track', type: 'live-track', desc: '라이브 실거래 트랙레코드(진짜 OOS)', myVerdictNote: '표본 축적 중' },
]);
