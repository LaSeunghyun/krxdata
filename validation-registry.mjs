// 상시 검증 가설 레지스트리 (2026-07-22)
// 오늘 세션에서 돌린 모든 백테스트/판정 + 데이터 가설을 등록.
// validate-hypotheses.mjs 가 매일 live-parity + MC 로 재검증 → validation_ledger 적재 → 판정이 뒤집히면 텔레그램 경보.
// ※ 실계좌 파라미터는 절대 자동 변경 안 함. 경보 → 사람 + 백테스트/MC 재확인 → 사람이 결정.

// live-parity 기준 args = 현재 라이브 config 반영 (slots3, rsiuni40, tp+4/8, sectorcap off). backtest 기간·자본 고정.
// override(변형)는 runner가 앞에 prepend → backtest-swing argOf(indexOf=첫값) 규칙상 override가 base를 이긴다.
export const LIVE_PARITY_BASE = Object.freeze([
  '--strategies', 'combo-v2', '--live-parity',
  '--slots', '3', '--rsiuni', '40', '--tp1r', '0.5', '--tp2r', '1', '--sectorcap', '0',
  '--from', '20230102', '--to', '20260611', '--capital', '6000000',
]);

// 각 가설: variants 각각을 MC(subsample 0.8 × seeds) 돌려 medianFinal(중앙 최종자본) 최대인 쪽이 '현재 승자'.
// myVerdict = 오늘 내가 내린 판정. currentWinner 가 myVerdict 와 어긋나면 FLIP 경보.
export const HYPOTHESES = Object.freeze([
  { id: 'slots', desc: '슬롯 수(분산도)', myVerdict: 's3', myVerdictNote: '3 최적',
    variants: { s2: ['--slots', '2'], s3: ['--slots', '3'], s5: ['--slots', '5'] } },
  { id: 'sectorcap', desc: '섹터캡', myVerdict: 'cap0', myVerdictNote: '노이즈, cap0 소폭 우위(생존편향 정정)',
    variants: { cap0: ['--sectorcap', '0'], cap1: ['--sectorcap', '1'] } },
  { id: 'partialtp', desc: '부분익절 레벨', myVerdict: 'tp_4_8', myVerdictNote: '+4/8 > +8/16',
    variants: { tp_4_8: ['--tp1r', '0.5', '--tp2r', '1'], tp_8_16: ['--tp1r', '1', '--tp2r', '2'] } },
  { id: 'rotate', desc: '최약슬롯 교체(로테이션)', myVerdict: 'off', myVerdictNote: '기각(효과 없음/음수)',
    variants: { off: [], on: ['--rotate'] } },
  { id: 'regimeexp', desc: '레짐 노출 스로틀(약세 현금보유)', myVerdict: 'full', myVerdictNote: '기각 — 풀투자>스로틀(MC: CAGR 19.4>15.6, MDD 22.4<24.4). rsi2가 DOWN서도 벌고 레짐 감지 지연',
    variants: { full: [], throttle: ['--regimeexp', '1.0,0.7,0.5'] } },
  { id: 'relstop', desc: '상대손절(시장 대비 N배 하락 시 매도)', myVerdict: 'off', myVerdictNote: '기각 — MC서 CAGR↓·MDD↑. mean-reversion 엣지와 충돌(반등할 눌림을 컷)',
    variants: { off: [], on2: ['--relstop', '2'], on3: ['--relstop', '3'] } },
  { id: 'rsivol', desc: 'rsi2 투매 거래량 확인(≥1.5배)', myVerdict: 'on', myVerdictNote: '★승자 요소 — 거래량 급증 동반 과매도만 매수. MC서 CAGR 대폭↑',
    variants: { off: [], on: ['--rsivol', '1.25'] } },
  { id: 'winner_stack', desc: '★캠페인 승자: NEUTRAL스킵+거래량1.5배 (현 라이브)', myVerdict: 'winner', myVerdictNote: 'baseline 대비 MC 6/6 전승: CAGR 19.4→36.6%, MDD 22.4→20.3%, Calmar 0.87→1.80. 2026-07-22 라이브 반영',
    variants: { baseline: [], winner: ['--skipneutralrsi', '--rsivol', '1.25'] } },
  { id: 'volsize', desc: '변동성 사이징(ATR 타겟, 승자 위 스택)', myVerdict: 'off', myVerdictNote: '기각 — 승자 Calmar 1.80→1.13(MC). 고변동 투매반등(엣지)을 downsize해 수익 붕괴. mean-reversion엔 역효과',
    variants: { off: ['--skipneutralrsi', '--rsivol', '1.25'], on: ['--skipneutralrsi', '--rsivol', '1.25', '--atrsize', '3'] } },
  // ※ universe 가설 제거(2026-07-22): --rsiuni 가 live-parity 에선 무효(유니버스가 LIVE_UNIVERSE_LIMIT 고정) → u30/40/100 동일 = 테스트 불가.
  // 메타 모니터: 이상화 vs live-parity 갭(생존편향 크기) 추적. 승자 뽑는 게 아니라 갭 비율만 INFO 기록. 'idealized'는 --live-parity 제거.
  { id: 'liveparity_gap', desc: 'live-parity vs 이상화(생존편향 갭)', monitor: true, myVerdictNote: '이상화 과대(생존편향) — 갭 축소 여부 추적',
    variants: { liveparity: [], idealized: ['__DROP_LIVE_PARITY__'] } },
]);

// 바벨 배분 가설 (2026-07-22 사용자 요청): 안정 75%(combo-v2 live-parity) + 공격 15%(hi120 모멘텀 UP게이트) + 현금 10%.
//   분기 리밸런싱. 100% 안정 대비 최종자본 우위인지 매일 재검증. ※ 공격 sleeve(hi120)는 momUniverse=생존편향 → 바벨쪽 낙관적임(정직 단서).
export const BARBELL = Object.freeze({
  id: 'barbell_75_15',
  desc: '바벨 안정75%(combo-v2)+공격15%(hi120)+현금10% vs 100% 안정',
  myVerdict: 'stable100',
  myVerdictNote: '리서치 바벨(P1-3) 전부 REJECTED — 100% 안정 대비 우위 불확실',
  aggressiveArgs: ['--strategies', 'hi120', '--hislots', '2', '--hiregime', 'up', '--from', '20230102', '--to', '20260611', '--capital', '6000000'],
  weights: { core: 0.75, sat: 0.15, cash: 0.10 },
});

// 데이터 기반(비-백테스트) 가설 — runner가 별도 처리.
export const DATA_HYPOTHESES = Object.freeze([
  { id: 'forecast_edge', type: 'forecast-skill', desc: '예측 방향 엣지', myVerdictNote: '미검증(anti-predictive, HOLD)' },
  { id: 'live_track', type: 'live-track', desc: '라이브 실거래 트랙레코드(진짜 OOS)', myVerdictNote: '표본 축적 중' },
]);
