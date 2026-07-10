# daily_rankings v6 정비 설계 (스코어링 일관성 교정)

- 날짜: 2026-07-10
- 대상 repo: `C:\claudeT\files` (krxdata)
- 상태: 설계 재작성 (v1 "토스 tech 팩터" 폐기 → v6 정비로 전환)

## Context (왜 하는가)

종목 추천이 나쁘다는 문제를 파고든 결과, **스코어링 표현이 3종으로 갈라져 서로 불일치**함이 드러났다:

1. **`stock_analysis.total_score`** (`score-kospi-full.js`) — 밸류·재무 편중, 단기는 공시 15점뿐. 직접 `ORDER BY total_score`로 조회하면 **저유동 밸류트랩(태광·하이록·미원)이 상위**. (추천 실수의 실제 원인 = 이 테이블을 조회함.)
2. **`daily_rankings.undervalue_score`** (`daily-ranking.js buildRankingsRefreshSql`, = `get_rankings`/앱이 보여주는 것) — 하드코딩 SQL. **품질+이익모멘텀+가격모멘텀 편중**이라 "저평가 점수" 1위가 SK하이닉스(PBR 12.9)·제주반도체(PER 78)·알테오젠(PER 130). 이름과 실제가 불일치.
3. **백테스트 모델** (`backtest-pit.mjs` → `config.js FACTOR_WEIGHTS` + `normalize.js` 섹터중립 z-score, "scoring v2 pure-core") — PIT 검증되지만 위 둘과 다른 코드경로. **v6 SQL을 검증하지 않음.**

`stock_prices`(오늘까지 최신, 2,610종목, 70만행)로 가격 모멘텀은 이미 계산되고 있어 **토스 일봉으로 이력을 새로 수집할 필요는 없다**(v1 스펙 폐기 사유).

**목표:** 추천을 `daily_rankings` 기준으로 통일하고, v6 SQL의 명백한 결함을 최소·안전하게 교정한다. 큰 모델 통합(3종 → 1종)은 별도 프로젝트로 남긴다(YAGNI).

## 결정 사항 (사용자 확정)

| 항목 | 결정 |
|------|------|
| 방향 | **v6 정비** (토스 tech 신규 팩터 폐기 / 두 모델 통합·백테스트 재작성은 범위 밖) |
| 추천 소스 | `daily_rankings`로 통일 (raw `total_score` 직접 조회 금지) |

## 확정 변경 (최소·안전)

### 1) `op_income_yoy` 30점 중복 제거 [correctness]
- 현재 `buildRankingsRefreshSql`에서 **동일 변수 `op_income_yoy`가 두 블록으로 30점** 부여:
  - `daily-ranking.js:417-426` "이익 추세" (max 15, NULL→5)
  - `daily-ranking.js:427-436` "이익 YoY" (max 15, NULL→0)
- → **단일 "이익성장" 블록(max 15)으로 병합.** NULL→5(중립) 유지. 이익 급증주 과편향 제거. 이게 v6를 밸류/품질 쪽으로 되돌리는 핵심 레버.

### 2) 명칭 정합 [honesty] — 컬럼명은 유지, 의미만 정정
- `undervalue_score` 컬럼명은 소비자(`get_rankings` 툴·앱)가 의존 → **개명하지 않음**(파괴적).
- 대신 `buildRankingsRefreshSql` 상단 주석에 "이 점수 = 밸류(15) + 품질(ROE·마진) + 이익성장(15) + 가격모멘텀(15) + 현금흐름(PCR) 합성 — 순수 저평가 아님" 명시. `get_rankings` 툴 description도 동일 문구로 수정.

### 3) 추천 조회 표준화
- 앞으로 종목 추천/랭킹은 `daily_rankings`(최신 rank_date) + 유동성/밸류트랩 렌즈로만. `stock_analysis.total_score` 직접 정렬 금지(문서·습관 규칙, 코드 아님).

## 비목표 (YAGNI)

- **토스 일봉 tech 팩터 신설**: 폐기(모멘텀 이미 stock_prices로 반영).
- **3종 모델 통합 / v6를 FACTOR_WEIGHTS z-score로 대체**: 큰 작업 → 별도 프로젝트.
- **freed 15점 재배분 최적화**: 하지 않음. 백테스트가 v6를 검증 못 하므로(다른 모델) 근거 없는 가중치 조정은 금지. 중복 제거만으로 편향 완화. (재배분이 필요하면 3종 통합 프로젝트에서 백테스트로.)
- **라이브 매매 로직**: 불변. `momUniverse`(ret60)·largeCaps(시총순)는 `undervalue_score`/`daily_rankings` 미참조 → 실주문 영향 0.

## 아키텍처 / 영향 파일

- `daily-ranking.js` — `buildRankingsRefreshSql()`의 이익추세+이익YoY 두 블록을 단일 이익성장 블록으로 병합(순 -15점 max). 상단 주석 정정.
- `mcp-server.js` (또는 툴 정의 위치) — `get_rankings` description 문구 정정.
- (신규) `scripts/rank-diff.mjs` — 검증용: 변경 전/후 `daily_rankings` 상위 N diff + NULL/커버리지 점검(자동 게이트 아님, 육안+기계 확인).

## 검증

- **회귀 안전(라이브)**: `grep`로 `undervalue_score`/`daily_rankings` 참조가 paper-swing 매수 경로에 없음을 재확인(설계 가정 고정).
- **변경 전/후 diff**: `buildRankingsRefreshSql`을 read-only로 실행(별도 임시 컬럼/뷰)해 top50 변화 확인 — 이익급증 고PER주가 내려가고 품질+합리밸류가 올라오는지 육안 검토. SK하이닉스류가 무조건 빠지진 않되(품질·모멘텀 여전히 가점) 순위 하향.
- NULL 폭증·커버리지 급감 없음(중복 제거는 감점이 아니라 max 축소라 대량 탈락 없어야 함).
- `code-reviewer` 별도 패스(self-approve 금지).

## 롤백
- 단일 SQL 블록 변경 → 병합 커밋 revert 시 즉시 원복. `daily_rankings`는 다음 04:00 full 갱신에서 재생성.
