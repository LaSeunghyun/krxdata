# KRXDATA 스코어링 v2 — 구현 스펙 (Haiku 구현 대상)

> 작성: Opus 4.8 / 목적: Haiku가 추측 없이 구현하고, 골든 테스트로 정확성을 객관 판정.
> **Loop A(정확성)** 종료 조건 = 이 스펙의 모든 골든 테스트 green + 리뷰 체크리스트 통과.
> **Loop B(성능)** = 사용자가 실데이터로 `backtest.js` 실행 → IC 리포트 → Opus 해석/재가중. 코드 루프와 분리.

---

## 0. 모듈 구조

| 파일 | 담당 | 순수성 | 구현자 |
|------|------|--------|--------|
| `scoring-core.js` | 기존 공통 파서 (`parseFinancials` 등) | 순수 | (기존) |
| `normalize.js` | 섹터 횡단면 정규화 | **순수** | Haiku |
| `factors.js` | 원시 팩터 계산 | **순수** | Haiku |
| `backtest.js` | IC·포워드수익·point-in-time (코어 수학) | **순수 코어** + 얇은 DB 레이어 | 코어=Haiku, DB레이어=Opus |
| `score.js` | kospi/kosdaq 단일 파이프라인 (`--market=`) | 비순수 (IO) | Haiku |
| `config.js` | 상수 추가 | — | Haiku |

> **원칙**: 위험한 수학(look-ahead, 정규화, IC, 분기 YoY)은 전부 순수 함수로 격리한다. DB/API IO는 순수 함수를 호출하는 얇은 래퍼만 둔다. 골든 테스트는 순수 함수만 대상으로 한다.

---

## 1. `normalize.js`

```js
// 모든 함수는 입력을 변형하지 않는다(no mutation). 비유한값(NaN/Infinity/null/undefined)은 결측으로 취급.

export function mean(values: number[]): number          // 빈 배열 → 0
export function std(values: number[]): number           // 모집단 표준편차(population, /n). n<2 또는 분산0 → 0

export function winsorize(
  values: number[], lowerP = 0.01, upperP = 0.99
): number[]
//  R-7 선형보간 분위수로 lo=quantile(lowerP), hi=quantile(upperP) 산출 후 [lo,hi]로 clamp.
//  quantile: idx = p*(n-1); i=floor(idx); frac=idx-i; q = s[i] + frac*(s[i+1]-s[i])  (s=오름차순 정렬)
//  길이 보존. 입력 순서 보존.

export function sectorZScores(
  rows: object[], valueKey: string, sectorKey: string,
  opts?: { winsor?: [number, number] | null }   // 기본 [0.01, 0.99]; null이면 winsorize 생략
): number[]
//  반환: 입력 rows와 같은 길이·순서의 z-score 배열.
//  섹터별로: 해당 섹터의 유한값만 모아 (옵션)winsorize → mean/std → z=(v-mean)/std.
//  결측(비유한) 값 → 0 (섹터 중립, 페널티 금지).
//  섹터 std===0 (단일 종목 포함) → 그 섹터 전부 0. NaN/Infinity 절대 반환 금지.
```

### 골든 테스트 (`tests/normalize.test.js`)
- `winsorize([0,10,...,100], 0.1, 0.9)` → `[10,10,20,30,40,50,60,70,80,90,90]`
- `std([2,4,4,4,5,5,7,9])` → `2`
- `sectorZScores` : 섹터 A `[10,20,30]` → `[-1.2247, 0, 1.2247]`(±1e-3); 섹터 B `[5,5]` → `[0,0]`; 결측 → `0`

---

## 2. `factors.js`

`fin` = `parseFinancials()` 결과. 각 항목은 `{current, previous, before}` 또는 `null`. `cfOps`는 `number|null`.

```js
export function valueFactors(fin, marketCap: number): { per: number|null, pbr: number|null }
//  per = (netIncome.current > 0 && marketCap > 0) ? marketCap / netIncome.current : null
//  pbr = (totalEquity.current > 0 && marketCap > 0) ? marketCap / totalEquity.current : null
//        ↑ 자본잠식(자본총계<=0) → pbr=null (절대 음수 PBR 금지)

export function qualityFactors(fin): {
  roe: number|null, debtRatio: number|null, curRatio: number|null, cfPositive: 0|1|null
}
//  roe       = (ni>0 && eq>0)      ? ni/eq*100 : null
//  debtRatio = (eq>0)              ? totalDebt.current/eq*100 : null   // 자본잠식 → null
//  curRatio  = (curLiab.current>0) ? curAsset.current/curLiab.current*100 : null
//  cfPositive= cfOps==null ? null : (cfOps>0 ? 1 : 0)

export function quarterlyYoY(currentQ: number, yearAgoQ: number): number|null
//  yearAgoQ > 0  → (currentQ - yearAgoQ) / yearAgoQ * 100
//  yearAgoQ === 0→ null  (분모 0 가드)
//  yearAgoQ < 0  → currentQ > 0 ? 999 (흑자전환) : (currentQ - yearAgoQ) / Math.abs(yearAgoQ) * 100

export function sameQuarterYoY(
  quarterRows: { year: number, quarter: number, value: number }[]
): { current: number, yearAgo: number } | null
//  가장 최근 (year=Y, quarter=Q) 선택 → 같은 분기 전년(year=Y-1, quarter=Q)을 짝지음.
//  ★계절성 제거: 직전분기(Q-1)가 아니라 반드시 전년 동분기(Y-1,Q)와 비교.
//  전년 동분기 없으면 null.
```

### 골든 테스트 (`tests/factors.test.js`)
- `valueFactors({netIncome:{current:100}, totalEquity:{current:500}}, 1000)` → `{per:10, pbr:2}`
- 자본잠식 `totalEquity.current=-50` → `pbr:null` / 적자 `netIncome.current=-10` → `per:null` / `marketCap=0` → 둘다 null
- `qualityFactors`: debtRatio(300/600)=50, eq≤0→null, curRatio(200/100)=200, curLiab0→null, cfOps 5→1 / -3→0 / null→null
- `quarterlyYoY(120,100)=20`, `(50,-10)=999`, `(50,0)=null`, `(-5,-10)=50`, `(-15,-10)=-50`
- `sameQuarterYoY([{2026,Q1,120},{2025,Q1,100},{2025,Q4,200}])` → `{current:120, yearAgo:100}` (Q4 200 무시)

---

## 3. `backtest.js` (순수 코어)

```js
export function spearmanIC(pairs: [number, number][]): number
//  스피어만 순위상관. 각 축 순위변환(동순위=평균순위) 후 피어슨.
//  분산 0(상수축) 또는 n<2 → 0 반환 (NaN 금지). 범위 [-1, 1].

export function excessReturn(p0, pN, b0, bN): number|null
//  (pN/p0 - 1) - (bN/b0 - 1).  p0<=0 또는 b0<=0 → null.

export function pointInTimeFinancials(rows: object[], asOf: string): object[]
//  rcept_dt(YYYYMMDD 또는 ISO 문자열) <= asOf 인 행만. 경계(===) 포함. ★look-ahead 차단.

export function alignForward(
  snapshots: { stock_code: string, date: string, price: number }[],
  horizonDays: number, toleranceDays: number
): { stock_code: string, t: string, p0: number, pN: number }[]
//  각 (종목, 시점 T)에 대해 [T+h-tol, T+h+tol] 구간의 가장 가까운 미래 스냅샷을 pN으로.
//  ★T 자신·과거 스냅샷은 pN으로 절대 사용 금지. 구간 내 미래 스냅샷 없으면 그 (종목,T)는 결과에서 제외.
//  date는 'YYYY-MM-DD'. 일수차 = round((Date.parse(b)-Date.parse(a))/86400000).

export function quantileSpread(rows, scoreKey, retKey, q = 0.2): number
//  scoreKey 내림차순 정렬 → 상위 q 비율 retKey 평균 − 하위 q 비율 retKey 평균.
```

### 골든 테스트 (`tests/backtest.test.js`)
- `spearmanIC([[1,1],[2,2],[3,3],[4,4]])=1` / 역순 `=-1` / 상수축 `[[5,1],[5,2],[5,3]]=0` / 비선형단조 `[[1,1],[2,4],[3,9]]=1`  ← **planted-signal**
- `excessReturn(100,110,200,210)≈0.05` / `p0=0 → null`
- `pointInTimeFinancials([{rcept_dt:'20260301'},{rcept_dt:'20260515'}],'20260401')` → 0301행만  ← **look-ahead 차단**
- `alignForward([{X,'2026-01-01',100},{X,'2026-01-26',110},{X,'2025-12-07',90}], 25, 5)` → `[{X, t:'2026-01-01', p0:100, pN:110}]` (과거 90·T자신 미사용)
- `quantileSpread(점수1..10·수익=점수, 'score','ret', 0.2)=8`

---

## 4. `config.js` 추가

```js
export const BACKTEST_HORIZONS = [20, 60];   // 영업일(≈1M,3M)
export const BACKTEST_TOLERANCE = 5;         // 정렬 허용일
export const WINSOR_BOUNDS = [0.01, 0.99];
export const FACTOR_WEIGHTS = {              // 초기 equal-weight; Loop B에서 IC비례 갱신
  value: 1, quality: 1, growth: 1, earningsMomentum: 1,
  priceMomentum: 1, trend: 1, governance: 1, event: 0   // event=공시: IC검증 전 0(probation)
};
```

---

## 5. DB / 수집 변경 (통합 검증 — 골든 테스트 대상 아님)

- `stock_financials`에 `report_code TEXT`(11011/11013/11014), `rcept_dt TEXT`, `quarter INT` 컬럼 추가(마이그레이션).
- DART 수집에 분기보고서(11013/14) 1콜 추가 → 분기 행 별도 적재(연간 행과 `report_code`로 구분).
- ⚠️ `stock_analysis_history`에는 **sector 컬럼이 없다**(기존 코드가 제외). backtest에서 섹터별 분석 시 `stock_analysis`에서 join 필요.
- 분기 미제출 종목은 graceful 처리: earningsMomentum 팩터 결측 → `sectorZScores`가 0(중립)으로 흡수.

---

## 6. Definition of Done

**Loop A (코드 정확성) — 자동 반복 가능, 데이터 불필요**
- [ ] `npm test` 전부 green (normalize/factors/backtest 골든 테스트)
- [ ] `npm run check` 통과(문법)
- [ ] 리뷰 체크리스트:
  - [ ] 모든 순수 함수가 NaN/Infinity 미반환 (분모0·빈배열·결측 가드)
  - [ ] `pointInTimeFinancials`·`alignForward`에 look-ahead 누수 없음
  - [ ] `sameQuarterYoY`가 전년 동분기 비교(직전분기 아님)
  - [ ] 결측 → 0/null 중립 처리 (절대점수 페널티 금지)
  - [ ] 입력 불변(no mutation)

**Loop B (예측 성능) — 사용자 실행 + 시간 필요, 코드 루프와 분리**
- 사용자가 누적 history로 `backtest.js` 실행 → 합성 IC > v1 baseline, 분위 스프레드 양수·단조, top분위 hit rate>50%
- 미달 시 코드 버그가 아니라 **팩터 재가중/제거**(FACTOR_WEIGHTS) 문제 → Opus가 IC 분해 보고 결정
