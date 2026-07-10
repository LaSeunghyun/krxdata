# 단기 기술 팩터 복원 설계 (scoring v2 기술지표 블렌드)

- 날짜: 2026-07-10
- 대상 repo: `C:\claudeT\files` (krxdata)
- 상태: 설계 확정 대기 (사용자 리뷰 전)

## Context (왜 하는가)

KRXDATA 스코어링은 `total_score`가 **밸류에이션(30)+재무건전성(25)+수익성(25)+지배구조(12)+다년도성장(18) = 장기 110점**에 편중돼 있고, 단기는 **공시이벤트(15점) 하나뿐**이다. 현 스코어러 `score-kospi-full.js:168`은 주석 그대로 *"단기 기술지표(모멘텀/거래량/변동성)는 주가 이력을 수집하지 않아 산출하지 않는다"* 로 기술 신호를 아예 뺐다. (과거 배점에 있던 변동성20/거래량수급25/기술모멘텀30 = 75점은 "이력미수집 0점"으로 죽어 있다가 v2에서 항목째 제거됨.)

결과: **추세가 죽고 거래량이 실종된 저유동 밸류주(태광산업·하이록코리아·미원에스씨 등)가 밸류 점수만으로 랭킹 상위에 오르는 편향.** 2026-07-06 거래대금 30억 하드필터로 극단 케이스는 걸렀으나, "싸지만 안 움직이는" 트랩이 여전히 상위권에 낀다.

한편 `daily-ranking.js`는 **이미 매일 `getDailyCandles(code, 252)`로 일봉을 받아**(refresh52w 경로, `daily-ranking.js:266`) 52주 고저·거래대금을 계산 중이다. 즉 추세·거래량 데이터는 파이프라인에 이미 있고 스코어링에 안 물렸을 뿐이다. 기술 계산 로직도 `paper-swing.js`(rsi2·hi120·ATR)에 검증된 형태로 존재한다.

**목표:** 이미 수집되는 토스 일봉으로 단기 기술 팩터(추세·거래량·변동성)를 산출해 `total_score`에 **균형 비중(~25점, 전체의 약 17%)**으로 블렌드한다. 죽은 밸류주는 감점하되 우량 밸류주가 뒤집히지 않는 선. 새 데이터소스·새 지표로직 없이 **기존 자산 연결**.

## 결정 사항 (사용자 확정)

| 항목 | 결정 |
|------|------|
| 배점 철학 | **균형 블렌드** — 기술 총 25점(펀더 125 + 기술 25 → 기술 ≈ 17%) |
| 계산 위치 | **`daily-ranking.js`** (candles 이미 fetch·매일 갱신·역할 분리) |
| 검증 | point-in-time **백테스트 sanity 포함** + `code-reviewer` 별도 패스 |

## 비목표 (YAGNI)

- 라이브 자동매매 로직 변경: **하지 않는다.** paper-swing 매수 유니버스는 momentum(hi120/rsi2)+시총순 largeCaps(`ORDER BY market_cap_tril`)이며 `total_score`를 쓰지 않는다 → 스코어 변경은 **실주문에 영향 0.**
- 백테스트로 가중치 최적화(그리드 서치): 하지 않는다. 사용자가 "균형 블렌드"를 택함. 백테스트는 **역효과 여부 sanity 확인용**이지 튜닝용이 아니다.
- score-full 배치에서 candle fetch: 하지 않는다(중복·stale).

## 아키텍처

### 1) 순수 함수 `scoreTechnical(candles)` — `scoring-core.js`에 추가

- 입력: 토스 일봉 배열(최신순) `[{timestamp,open,high,low,close,volume}]` (daily-ranking이 넘김)
- 출력: `{ score:number(0~25), sub:{trend,volume,volatility}, note:string }`
- 계산(paper-swing 로직 재사용/공유):
  - **추세 ~10점**: 종가 vs MA20/60/120 정배열 단계 + 60/120일 수익률 부호·크기. (paper-swing hi120·MA 유틸 참조)
  - **거래량 ~8점**: 최근 5d 평균거래량 / 20d 평균 비율. 1.0 이상(관심 유입) 가점, 0.6 미만(실종) 감점.
  - **변동성·위치 ~7점**: 52주 위치(0~100%) + ATR/근접성. 바닥 방치(하위·저거래)와 과열 고점(상위 극단) 양쪽 감점, 중상단 건전 추세 가점.
- 표본 부족(candles < ~60봉: 신규상장·장기정지) → `score=null`, note "이력부족". NULL은 total_score 합산에서 0 취급하되 **감점 아님**(오배제 방지, turnover NULL 정책과 동일).
- 순수 함수 = 백테스트/유닛테스트에서 동일 입력 재사용 가능(scoring v2 pure-core 원칙 유지).

### 2) daily-ranking.js `refresh52w` 블록에 연결

- 위치: `daily-ranking.js:264-277` — 이미 `const candles = await getDailyCandles(code, 252)` 존재.
- 그 candles로 `const tech = scoreTechnical(candles)` 호출(추가 fetch 0). `buffer.push({..., tech: tech.score, techDetail: tech})`.
- **갱신 경로 한정 주의:** turnover와 동일하게 tech_score는 **refresh52w(full 토스) 경로에서만** 채워진다. `--skip-price`(ranking-only)·공공데이터 폴백 경로엔 candles가 없어 미갱신 → SQL COALESCE로 기존값 보존. 일 1회 full 갱신(`KRXDATA-DailyFull` 04:00)이 담당. 커버리지 로그로 stale 감지.

### 3) 저장 스키마 + total_score 재계산

- `stock_analysis`에 컬럼 추가(`ALTER ... ADD COLUMN IF NOT EXISTS`, turnover 컬럼과 동일 패턴):
  - `tech_score numeric` (0~25, NULL 허용)
  - `tech_detail jsonb` (sub 점수·note)
- flush UPDATE SQL(`daily-ranking.js:213-226`) 확장:
  - VALUES/컬럼에 `tech_score`, `tech_detail` 추가
  - `SET tech_score = COALESCE(v.tech_score, sa.tech_score)`, `tech_detail = COALESCE(v.tech_detail, sa.tech_detail)`
  - `total_score = COALESCE(sa.short_score,0) + COALESCE(sa.long_score,0) + COALESCE(v.tech_score, sa.tech_score, 0)` 로 재계산
  - (short_score=공시, long_score=펀더는 score-full이 이미 적재한 값을 읽음)

### 4) 랭킹 반영

- `buildRankingsRefreshSql()`(`daily-ranking.js:318`)의 scored CTE 정렬 기준이 `total_score`를 읽으면 자동 반영. **구현 시 확인 필요** — CTE가 점수를 자체 재계산하면 거기에도 `tech_score`를 더한다(단일 소스 유지). detail 표시는 read 시 `tech_detail`을 `detail.단기_기술`로 병합.

### 5) 검증

- **백테스트 sanity** (`backtest-pit.js` 재사용): 과거 시점 기준 블렌드 total_score 상위 N vs 기존 total_score 상위 N의 forward 수익률(예: 20d/60d) 비교. 블렌드가 **유의하게 나쁘지 않을 것**(≥ 기존 또는 근접)이 통과 기준. 나쁘면 배점(25점) 하향 후 재검.
- **유닛 테스트**: `scoreTechnical`에 대해 (a) 상승정배열+거래량증가=고점, (b) 하락+거래량실종=저점, (c) 표본부족=null 케이스 픽스처.
- **라이브 회귀**: paper-swing 매수 경로가 total_score 미참조임을 grep로 재확인(설계 가정 고정).
- `code-reviewer` 별도 패스(self-approve 금지).

## 영향 파일

- `scoring-core.js` — `scoreTechnical()` 순수함수 추가 (+ 필요 시 paper-swing의 MA/ATR/hi120 유틸을 core로 승격해 공유)
- `daily-ranking.js` — refresh52w 블록 연결, flush UPDATE SQL 확장, ALTER 컬럼, buildRankingsRefreshSql 정렬 확인
- `paper-swing.js` — (선택) 공용 유틸을 core에서 import하도록 리팩터(중복 제거, 동작 불변)
- `backtest-pit.js` — sanity 비교 스크립트(있으면 재사용, 없으면 최소 추가)
- 테스트 픽스처 1개

## 롤백

- `total_score` 재계산은 daily-ranking UPDATE에 한정. tech 컬럼/합산을 제거하면 즉시 원복(펀더 점수는 score-full이 별도 보유). daily_rankings는 다음 갱신 시 복원.
