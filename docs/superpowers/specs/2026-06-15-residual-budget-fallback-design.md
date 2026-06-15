# 잔여 예산 차순위 분산 (slots2 하이브리드) — 설계

작성: 2026-06-15 / MC3 I17 후속 / 대상: `paper-swing.js` 라이브 트레이딩

## 배경
첫 실매매(6/15)에서 후성 매수가 시장가 증거금(상한가 기준) 문제로 실패 → 지정가 전환으로 해결. 이 과정에서 드러난 구조적 한계: **한 종목 목표 수량을 매수가능금액 부족으로 다 못 채울 때, 잔여 예산이 놀게 된다.** 검증된 동결 구성은 slots2(2종목 분산)인데, 라이브는 잔여 예산을 차순위 종목으로 분산하는 로직이 없어 사실상 집중되거나 현금이 유휴화된다.

## 목표
매수 시 목표 수량/예산을 다 못 채우면 **살 수 있는 만큼만 사고, 잔여 예산으로 차순위 hi120 종목을 분산 매수**한다. backtest slots2 분포(원금손실 2.5%)를 라이브가 대표하도록 유지한다.

## 비목표 (YAGNI)
- 임의 종목 매수 (전략 시그널 외) — 절대 금지, 백테스트 무효화
- 동적 슬롯 확대(dynslot) — I11에서 기각됨
- 매도(청산) 측 변경 — 기존 시장가 즉시 청산 유지

## 결정 사항 (brainstorming 합의)
| 항목 | 결정 |
|---|---|
| 발동 시점 | **하이브리드** — 큐 생성(전일 close) + 집행(당일 morning) 둘 다 |
| 차순위 후보 공급 | **큐 생성 시 후보 리스트 동봉 저장** (executeLiveQueue는 소비만) |
| 분산 단위 | **슬롯 예산 `floor(equity/SLOTS)`, 총 보유 SLOTS(2)개 상한** |
| 무한 분산 방지 | 보유 SLOTS 상한으로 자동 (별도 임계 불필요) |
| 잔여 < 슬롯예산 | 1주도 못 사면 스킵 → 현금 보유 |
| 레짐/필터 | UP 레짐 한정(caps D) + badCodes 제외 (큐 생성 시 필터) |
| 주문 유형 | 매수 지정가(현재가) / 매도 시장가 (기존) |

## 데이터 흐름
1. **전일 close — `evaluateLiveHoldings`**
   - UP 레짐일 때 momUniverse 순회 → hi120 돌파 시그널(`breakoutPct >= minBreakout`) & `badCodes` 제외 종목을 **우선순위 순으로 (빈 슬롯 수 + 여유분, 최대 5개)** `live_queue`에 BUY 항목으로 적재
   - 각 BUY 목표 qty = `floor(슬롯예산 × liveAtrMult / 지정가)`, 슬롯예산 = `floor(equity/SLOTS)`
   - 큐 순서: SELL(청산) 먼저, 그다음 BUY 우선순위 순
2. **당일 morning — `executeLiveQueue`**
   - 현재 보유 슬롯 수(`heldSlots`) 파악
   - 큐 BUY를 우선순위대로 순회하되 **`heldSlots < SLOTS`인 동안만** 집행
   - 각 종목: `qty = min(목표qty, floor(min(슬롯예산, 매수가능금액) / (지정가×1.01)))` → 살 수 있는 만큼 지정가 매수
   - 체결 성공 시 `heldSlots++`. 슬롯·예산 여유 있으면 다음 후보로 자동 진행
   - `heldSlots == SLOTS` 도달 시 중단, 남은 BUY는 remaining으로 보류

## 핵심 규칙 상세
- **분산 단위**: 차순위도 슬롯 예산 단위. backtest `closePhase` 신규진입(슬롯별 `floor(equity/slots)`로 momUniverse 순회)과 동일 원리 → 정합
- **상한**: 총 보유 종목 SLOTS(2)개. 무한 분산 자동 방지
- **스킵 조건**: 잔여 매수가능금액으로 차순위 종목 1주도 못 사면 매수 안 함(현금 보유) — 별도 임계값 불필요
- **필터**: 후보 리스트는 큐 생성 단계에서 이미 UP 레짐 + hi120 시그널 + badCodes 제외를 거친 것만 포함

## backtest 정합성
- backtest `closePhase` 신규진입은 슬롯별 `budget()=floor(equity/slots)` 예산으로 momUniverse 순회, qty<1이면 차순위(`buy()` false → 다음 종목)
- 본 설계는 동일 원리를 라이브 집행 시점에도 적용 → MC slots2 분포(p5 30,805 / median 62,400 / 원금손실 2.5%) 대표성 유지
- 잔존 차이: backtest 종가진입 vs 라이브 익일 시가 (I16에서 이미 인지·정량화, 본 설계가 추가 차이 도입 안 함)

## 엣지·에러 처리
- **지정가 미체결**: `waitLiveFill` 타임아웃 → 보류(remaining), `live_halt` 미설정, 다음 회차 재시도
- **매도→매수 현금 의존**: 큐 SELL 먼저 정렬, 매수 전 `cashBuyingPower` 폴링(기존 60초)
- **후보 리스트 소진**: 남은 슬롯은 현금 보유 (강제 매수 안 함)
- **주문 오류(422 등)**: 기존 `live_halt` 안전중단 유지

## 컴포넌트 경계 (단위 분리)
순수 함수로 분리해 단위 테스트 가능하게:
- `pickBuyCandidates(momUniverse, regime, badCodes, signals, slotsToFill, headroom)` → 우선순위 BUY 후보 배열
- `allocateSlots(candidates, heldSlots, SLOTS, equity, cashAvailable, prices)` → 집행할 (종목, qty) 배열
- 실주문(`createOrder`)·상태저장(`saveStateKey`)은 이 순수 함수 결과를 소비하는 얇은 래퍼

## 테스트 전략
- `pickBuyCandidates` / `allocateSlots` 순수 함수 단위 테스트 (슬롯 카운트, 예산 클램프, 후보 소비, 상한, 스킵 조건)
- 실주문 경로는 dry-run 플래그(`LIVE_DRY_RUN`)로 큐 시뮬레이션 — 실제 주문 없이 집행 결정 검증
- 회귀: 기존 단일 종목 큐(후성 케이스)가 동일하게 동작하는지 확인

## 실행 환경 메모
- 30k 소액 계좌, 실거래, 토스 지정가
- GH Actions는 토스 IP 403(화이트리스트)이라 실주문 불가 → 향후 Oracle Cloud Always Free 고정IP 워커에서 집행 예정. 본 설계는 실행 환경과 무관(executeLiveQueue 로직)
