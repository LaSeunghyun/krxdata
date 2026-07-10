# daily_rankings v6 정비 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `daily_rankings.undervalue_score`(v6 SQL)의 `op_income_yoy` 30점 중복을 단일 15점으로 교정하고, 점수 의미를 정직하게 문서화한다.

**Architecture:** `buildRankingsRefreshSql()`가 반환하는 하드코딩 SQL의 `scored` CTE에서 이익성장 관련 두 CASE 블록(이익추세 15 + 이익YoY 15)을 하나(15)로 병합. SQL이라 유닛테스트 대신 변경 전/후 `daily_rankings` 상위 diff로 검증. 라이브 매매는 이 점수 미참조 → 영향 0.

**Tech Stack:** Node.js ESM, Postgres(Supabase), `node --test`(기존 테스트), execute_sql(MCP) / `node daily-ranking.js --skip-price`(랭킹 재빌드).

---

### Task 1: 변경 전 baseline 캡처

**Files:**
- Create: `scratch/rank-baseline-20260710.json` (검증용 임시, 커밋 제외)

- [ ] **Step 1: 현재 daily_rankings 상위 50 저장**

execute_sql(project_id `onxkbuecwbcueuhwnowx`):
```sql
SELECT rank, stock_code, corp_name, undervalue_score, pbr, per, op_margin, roe
FROM daily_rankings
WHERE rank_date = (SELECT MAX(rank_date) FROM daily_rankings)
ORDER BY rank LIMIT 50;
```
결과를 `scratch/rank-baseline-20260710.json`에 저장. (op_income_yoy 급증주 = SK하이닉스·제주반도체·알테오젠·브이엠 등이 상위에 있는지 확인 — 이들이 변경 후 하향되는 게 성공 신호.)

- [ ] **Step 2: 라이브 매매 미참조 재확인 (회귀 안전)**

Run: `grep -nE "undervalue_score|daily_rankings" paper-swing.js trader.js`
Expected: 매수 후보 선정(momUniverse/rsi2/largeCaps) 경로에 `undervalue_score`/`daily_rankings` 참조 **없음**. (largeCaps는 `stock_analysis` 시총순, daily_rankings 아님.) 있으면 중단하고 재설계.

---

### Task 2: op_income_yoy 중복 블록 병합

**Files:**
- Modify: `daily-ranking.js:417-436` (이익추세 + 이익YoY 두 CASE 블록)

- [ ] **Step 1: 두 블록을 단일 이익성장 블록으로 교체**

`daily-ranking.js`의 아래 구간(현재 417-436):
```
          -- [이익 추세 15pt] 52주 모멘텀 대체 — 이익YoY 방향성
          + CASE
            WHEN sf.op_income_yoy IS NULL THEN 5
            WHEN sf.op_income_yoy >= 100 THEN 15
            WHEN sf.op_income_yoy >= 50  THEN 13
            WHEN sf.op_income_yoy >= 20  THEN 10
            WHEN sf.op_income_yoy >= 0   THEN 7
            WHEN sf.op_income_yoy >= -10 THEN 3
            ELSE 0
          END
          -- [이익YoY 15pt]
          + CASE
            WHEN sf.op_income_yoy IS NULL THEN 0
            WHEN sf.op_income_yoy >= 200 THEN 15
            WHEN sf.op_income_yoy >= 100 THEN 12
            WHEN sf.op_income_yoy >= 50  THEN 9
            WHEN sf.op_income_yoy >= 20  THEN 6
            WHEN sf.op_income_yoy >= 0   THEN 3
            ELSE 0
          END
```
를 다음으로 교체:
```
          -- [이익성장 15pt] op_income_yoy 방향성.
          -- 2026-07-10: 구 "이익추세 15"+"이익YoY 15"가 동일 변수를 30점 이중가중하던 결함을
          --             단일 15점으로 통합(이익 급증주 과편향 제거). NULL→5(중립).
          + CASE
            WHEN sf.op_income_yoy IS NULL THEN 5
            WHEN sf.op_income_yoy >= 100 THEN 15
            WHEN sf.op_income_yoy >= 50  THEN 13
            WHEN sf.op_income_yoy >= 20  THEN 10
            WHEN sf.op_income_yoy >= 0   THEN 7
            WHEN sf.op_income_yoy >= -10 THEN 3
            ELSE 0
          END
```

- [ ] **Step 2: 구문 검사**

Run: `npm run check`
Expected: PASS (syntax OK). 실패 시 교체 구간 괄호/`+` 연산자 정합 확인.

- [ ] **Step 3: 기존 테스트 회귀**

Run: `npm test`
Expected: 기존 테스트 PASS 유지(이 변경은 slot-alloc 등과 무관, 깨지면 안 됨).

- [ ] **Step 4: 커밋**

```bash
git add daily-ranking.js
git commit -m "fix: daily_rankings v6 op_income_yoy 30점 중복 → 단일 15점 통합"
```

---

### Task 3: 점수 의미 정직화 (주석 + 툴 description)

**Files:**
- Modify: `daily-ranking.js:318` (buildRankingsRefreshSql 상단 주석)
- Modify: `mcp-server.js` (get_rankings 툴 description — "저평가" 문구)

- [ ] **Step 1: buildRankingsRefreshSql 상단에 점수 정의 주석 추가**

`export function buildRankingsRefreshSql() {` 바로 위에 추가:
```js
// undervalue_score = 밸류(PBR10+PER5) + 품질(ROE15·영업이익률10·안정성5) + 이익성장(15)
//   + 가격모멘텀(15) + 현금흐름(PCR10) − 부채/이자보상 페널티, ×지주0.6.
//   ⚠ "순수 저평가"가 아니라 밸류+품질+모멘텀 합성점수. 고품질·이익성장주가 상위에 오를 수 있음.
```

- [ ] **Step 2: get_rankings 툴 description 정정**

`mcp-server.js`에서 `get_rankings` 툴의 description 문자열 `"저평가 스코어 기준 랭킹 TOP N을 조회합니다. (최신 daily_rankings 기준)"` 를
`"합성점수(밸류+품질+이익성장+모멘텀) 기준 랭킹 TOP N. (최신 daily_rankings 기준, 순수 저평가 아님)"` 로 교체.
(grep으로 정확 위치 확인: `grep -n "저평가 스코어 기준 랭킹" mcp-server.js`)

- [ ] **Step 3: 구문 검사 + 커밋**

Run: `npm run check`
Expected: PASS
```bash
git add daily-ranking.js mcp-server.js
git commit -m "docs: undervalue_score 의미 정직화(합성점수) + get_rankings description 정정"
```

---

### Task 4: 변경 후 랭킹 재빌드 + diff 검증

**Files:**
- (읽기 전용 검증, 코드 변경 없음)

- [ ] **Step 1: 랭킹만 재빌드 (가격 재조회 없이 새 공식 적용)**

Run: `node daily-ranking.js --skip-price`
Expected: STEP 2 랭킹 계산 완료 로그. 에러 없이 `daily_rankings` 새 rank_date 적재. (`--skip-price`는 STEP1 가격갱신을 건너뛰고 기존 stock_prices/재무로 랭킹만 재계산.)

- [ ] **Step 2: 변경 후 상위 50 캡처 + baseline과 diff**

execute_sql: Task1 Step1과 동일 쿼리로 최신 rank_date 상위 50 조회.
검증 기준:
- 이익 급증 고PER주(SK하이닉스·제주반도체·알테오젠·브이엠 등)의 **순위 하향** 확인(완전 탈락은 아닐 수 있음 — 품질·모멘텀 가점 잔존).
- 밸류+품질 합리주가 상대적으로 **상승**.
- 총 랭킹 종목 수(커버리지)가 baseline과 비슷(±소폭). 급감하면 하드필터/NULL 처리 이상 → 조사.

- [ ] **Step 3: NULL/커버리지 sanity**

execute_sql:
```sql
SELECT COUNT(*) AS n, MIN(undervalue_score) AS lo, MAX(undervalue_score) AS hi,
       AVG(undervalue_score)::numeric(6,2) AS avg
FROM daily_rankings WHERE rank_date = (SELECT MAX(rank_date) FROM daily_rankings);
```
Expected: n이 baseline과 유사, score 범위가 이전보다 상단만 ~15점 낮아짐(max 축소 반영), 음수/NULL 폭증 없음.

---

### Task 5: 코드리뷰 + 마무리

- [ ] **Step 1: code-reviewer 별도 패스**

`superpowers:code-reviewer` 에이전트로 Task2·3 diff 리뷰(self-approve 금지). SQL 병합이 다른 CASE 블록의 `+`/`-` 연산 정합을 깨지 않았는지, 지주사 ×0.6·페널티 위치 유지되는지 확인.

- [ ] **Step 2: 임시 파일 정리**

`scratch/rank-baseline-20260710.json` 삭제(또는 .gitignore 확인). 커밋에 포함 안 됨을 `git status`로 확인.

- [ ] **Step 3: 최종 상태 보고**

변경 전/후 top20 비교표를 사용자에게 보고. 라이브 영향 0(Task1 Step2 근거) 명시.

---

## Self-Review 체크

- **스펙 커버리지**: (1)중복제거=Task2, (2)명칭정합=Task3, (3)추천표준화=문서규칙(코드아님, 별도), 검증=Task4, 라이브안전=Task1 Step2. ✅
- **비목표 준수**: 토스 tech·모델통합·가중치재배분·라이브변경 없음. ✅
- **플레이스홀더 없음**: 교체 SQL 전문 기재. ✅
- **타입/명칭 정합**: `undervalue_score` 컬럼명 불변(소비자 보호), `op_income_yoy` 단일 참조로 감소. ✅
