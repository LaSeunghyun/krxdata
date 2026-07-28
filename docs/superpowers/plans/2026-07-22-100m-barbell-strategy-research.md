# 600만원→1억원 바벨 전략 연구 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로컬 데이터로 제한된 전략 후보를 동일 조건에서 검증하고, 코어 2/3·위성 1/3 조합의 MC·스트레스·1억원 도달 가능성을 재현 가능한 보고서로 만든다.

**Architecture:** 기존 `backtest-swing.mjs`는 체결 시뮬레이터로 유지하고 일별 자산곡선 JSON 출력만 추가한다. 순수 모듈이 자산곡선 요약, 바벨 결합, 위성 손실 중단, block bootstrap, 등급 판정을 담당하며 별도 실행기가 후보별 백테스트와 `subsample 0.8 × 20시드`를 호출한다.

**Tech Stack:** Node.js ESM, `node:test`, 기존 Toss 일봉 캐시, Markdown/JSON 결과물

**User override:** 현재 작업 트리에서 진행하며 worktree와 커밋을 만들지 않는다.

---

## File map

- Create `research-strategies.mjs`: 중기 추세/현금과 hi120 레짐 게이트의 순수 판단 함수
- Create `research-metrics.mjs`: 성과 요약, 바벨 결합, 위성 중단, bootstrap, 판정
- Create `research-candidates.mjs`: 최대 9개 후보와 실행 인자 단일 출처
- Create `research-backtest-output.mjs`: 백테스터의 일별 자산곡선 기록·직렬화
- Create `run-100m-research.mjs`: 백테스트 실행, MC/스트레스 집계, 보고서 생성
- Create `tests/research-strategies.test.js`: 전략 판단의 look-ahead 방지와 경계 테스트
- Create `tests/research-metrics.test.js`: 리밸런싱, MDD, bootstrap, 등급 테스트
- Create `tests/research-candidates.test.js`: 후보 수와 금지 실험 재도입 방지
- Modify `backtest-swing.mjs`: 연구 후보와 일별 자산곡선 dump 지원
- Create `research-results/100m-barbell-2026-07-22/summary.json`: 기계 판독 결과
- Create `research-results/100m-barbell-2026-07-22/REPORT.md`: 사용자 판정 보고서

### Task 1: 연구 전략 순수 함수

**Files:**
- Create: `tests/research-strategies.test.js`
- Create: `research-strategies.mjs`

- [ ] **Step 1: 실패 테스트 작성**

```js
test('absoluteTrendOn은 현재 인덱스 이후 가격을 보지 않는다', () => {
  const base = [80, 90, 100, 110, 120];
  assert.equal(absoluteTrendOn(base, 4, 3), true);
  assert.equal(absoluteTrendOn([...base, 1], 4, 3), true);
});

test('hi120 레짐 게이트는 UP에서만 진입을 허용한다', () => {
  assert.equal(hi120RegimeAllows('UP', 'up'), true);
  assert.equal(hi120RegimeAllows('NEUTRAL', 'up'), false);
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test tests/research-strategies.test.js`
Expected: `ERR_MODULE_NOT_FOUND`

- [ ] **Step 3: 최소 구현**

```js
export function absoluteTrendOn(closes, index, lookback = 120) {
  if (index < lookback - 1) return false;
  const window = closes.slice(index - lookback + 1, index + 1);
  return closes[index] > window.reduce((a, b) => a + b, 0) / window.length;
}

export function hi120RegimeAllows(regime, gate = 'all') {
  return gate === 'all' || regime === 'UP';
}
```

- [ ] **Step 4: GREEN 확인**

Run: `node --test tests/research-strategies.test.js`
Expected: all pass

### Task 2: 연구 성과·바벨·MC 판정 모듈

**Files:**
- Create: `tests/research-metrics.test.js`
- Create: `research-metrics.mjs`

- [ ] **Step 1: 실패 테스트 작성**

```js
test('summarizeCurve는 CAGR과 MDD를 계산한다', () => {
  const out = summarizeCurve([{ day: '20240102', equity: 100 }, { day: '20250102', equity: 121 }], 100);
  assert.ok(out.cagr > 20 && out.cagr < 22);
  assert.equal(out.mdd, 0);
});

test('combineBarbell은 위성 MDD 35%에서 현금화한다', () => {
  const core = curve([100, 100, 100]);
  const satellite = curve([100, 60, 120]);
  const out = combineBarbell(core, satellite, { initialCapital: 600, satelliteStopMdd: 35 });
  assert.equal(out.satelliteStopped, true);
  assert.equal(out.curve.at(-1).equity, 520);
});

test('classifyResearchResult는 데이터 게이트 실패 시 LIVE_ELIGIBLE을 금지한다', () => {
  assert.equal(classifyResearchResult(passingMetrics, { pointInTimeUniverse: false }), 'SHADOW_ONLY');
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test tests/research-metrics.test.js`
Expected: `ERR_MODULE_NOT_FOUND`

- [ ] **Step 3: 최소 구현**

다음 계산을 그대로 구현한다.

```js
export function summarizeCurve(curve, initialCapital) {
  let peak = initialCapital;
  let mdd = 0;
  for (const { equity } of curve) {
    peak = Math.max(peak, equity);
    mdd = Math.max(mdd, (peak - equity) / peak * 100);
  }
  const years = curve.length / 248;
  const finalCapital = curve.at(-1)?.equity ?? initialCapital;
  return { finalCapital, cagr: (Math.pow(finalCapital / initialCapital, 1 / years) - 1) * 100, mdd };
}

export function combineBarbell(coreCurve, satelliteCurve, {
  initialCapital = 6_000_000,
  satelliteStopMdd = Infinity,
} = {}) {
  let core = initialCapital * 2 / 3;
  let satellite = initialCapital / 3;
  let satellitePeak = satellite;
  let satelliteStopped = false;
  let previousQuarter = null;
  const curve = [];
  for (let i = 0; i < coreCurve.length; i++) {
    if (i > 0) {
      core *= coreCurve[i].equity / coreCurve[i - 1].equity;
      if (!satelliteStopped) satellite *= satelliteCurve[i].equity / satelliteCurve[i - 1].equity;
    }
    satellitePeak = Math.max(satellitePeak, satellite);
    if (!satelliteStopped && (satellitePeak - satellite) / satellitePeak * 100 >= satelliteStopMdd) satelliteStopped = true;
    const quarter = coreCurve[i].day.slice(0, 4) + Math.ceil(Number(coreCurve[i].day.slice(4, 6)) / 3);
    if (!satelliteStopped && previousQuarter && quarter !== previousQuarter) {
      const total = core + satellite;
      core = total * 2 / 3;
      satellite = total / 3;
      satellitePeak = satellite;
    }
    previousQuarter = quarter;
    curve.push({ day: coreCurve[i].day, equity: core + satellite });
  }
  return { curve, satelliteStopped };
}

export function summarizeMonteCarlo(runs) {
  const mdds = runs.map(x => x.mdd).sort((a, b) => a - b);
  return { medianMdd: mdds[Math.floor(mdds.length / 2)], worstMdd: Math.max(...mdds), ruinSeeds: runs.filter(x => x.mdd >= 80).length };
}

export function classifyResearchResult(metrics, dataQuality) {
  const riskPass = metrics.mcMedianMdd <= 20 && metrics.mcWorstMdd <= 30 && metrics.stressMdd <= 35 && metrics.stressFinal >= metrics.initialCapital && metrics.ruinSeeds === 0;
  if (!riskPass) return 'REJECTED';
  const returnPass = metrics.cagr >= 75.54;
  const dataPass = dataQuality.pointInTimeUniverse && dataQuality.includesDelisted && dataQuality.start <= '20160101';
  return returnPass && dataPass && metrics.shadowDays >= 60 ? 'LIVE_ELIGIBLE' : 'SHADOW_ONLY';
}
```

판정 상수는 CAGR 75.54%, MC MDD 중앙값 20%, 최악 30%, 스트레스 MDD 35%, 스트레스 원금 600만원을 그대로 사용한다.

- [ ] **Step 4: GREEN 확인**

Run: `node --test tests/research-metrics.test.js`
Expected: all pass

### Task 3: 후보 레지스트리

**Files:**
- Create: `tests/research-candidates.test.js`
- Create: `research-candidates.mjs`

- [ ] **Step 1: 실패 테스트 작성**

```js
test('실행 후보는 9개 이하이고 ID가 유일하다', () => {
  assert.ok(RESEARCH_CANDIDATES.length <= 9);
  assert.equal(new Set(RESEARCH_CANDIDATES.map(x => x.id)).size, RESEARCH_CANDIDATES.length);
});

test('기각된 몰빵·확대·로테이션 인자가 없다', () => {
  const args = RESEARCH_CANDIDATES.flatMap(x => x.args ?? []).join(' ');
  assert.doesNotMatch(args, /--slots 1|--rsiuni (100|200)|--rotate/);
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test tests/research-candidates.test.js`
Expected: `ERR_MODULE_NOT_FOUND`

- [ ] **Step 3: 8개 후보 등록**

```js
export const RESEARCH_CANDIDATES = [
  { id: 'A1', strategy: 'combo-v2', role: 'core', args: LIVE_PARITY_ARGS },
  { id: 'A2', strategy: 'trend-cash', role: 'core', args: ['--strategies', 'trend-cash'] },
  { id: 'A3', role: 'core', unavailable: 'point-in-time fundamentals unavailable' },
  { id: 'B2', strategy: 'combo-v2', role: 'core', args: [...LIVE_PARITY_ARGS, '--volshadow', '1'] },
  { id: 'B3', strategy: 'combo-v2', role: 'core', args: [...LIVE_PARITY_ARGS, '--maxholdr', '3', '--maxholdh', '40'] },
  { id: 'C1', strategy: 'hi120', role: 'satellite', args: ['--strategies', 'hi120', '--hislots', '2', '--hiregime', 'all'] },
  { id: 'C2', strategy: 'hi120', role: 'satellite', args: ['--strategies', 'hi120', '--hislots', '2', '--hiregime', 'up'] },
  { id: 'C3', derivedFrom: 'C2', role: 'satellite', satelliteStopMdd: 35 },
];
```

- [ ] **Step 4: GREEN 확인**

Run: `node --test tests/research-candidates.test.js`
Expected: all pass

### Task 4: 백테스터 연구 출력과 후보 연결

**Files:**
- Modify: `backtest-swing.mjs`
- Create: `research-backtest-output.mjs`
- Test: `tests/research-strategies.test.js`

- [ ] **Step 1: 일별 자산곡선 계약 테스트 추가 후 RED 확인**

```js
test('recordDailyEquity는 전달받은 당일 평가액만 기록한다', () => {
  const book = { daily: [] };
  recordDailyEquity(book, '20250102', 6_100_000);
  assert.deepEqual(book.daily, [{ day: '20250102', equity: 6_100_000 }]);
});
```

Run: `node --test tests/research-strategies.test.js`
Expected: missing export로 fail

- [ ] **Step 2: 출력 헬퍼와 백테스터 연결**

```js
export function recordDailyEquity(book, day, equity) {
  (book.daily ??= []).push({ day, equity });
}

export function serializeResearchBook(book) {
  return { cash: book.cash, maxDD: book.maxDD, trades: book.trades, daily: book.daily ?? [] };
}
```

- `trend-cash`를 주간 리밸런싱·시장 MA120 절대추세 게이트·상위 3개 120일 모멘텀으로 추가
- `hi120`에 `--hislots 2`, `--hiregime all|up`만 추가
- 각 book에 `daily: []`를 두고 매 거래일 equity를 기록
- `--dump` JSON에 `daily`, `trades`, `cash`, `maxDD`, 실행 메타데이터를 저장
- `swing-rank`가 ACTIVE가 아닐 때 원격 랭킹 쿼리를 생략

- [ ] **Step 3: GREEN 및 실제 소형 실행 확인**

Run: `node --test tests/research-strategies.test.js`
Expected: all pass

Run: `node backtest-swing.mjs --from 20250102 --to 20250331 --capital 6000000 --strategies trend-cash --dump research-smoke.json`
Expected: exit 0, dump에 `books.trend-cash.daily` 존재

### Task 5: 연구 실행기와 보고서

**Files:**
- Create: `run-100m-research.mjs`

- [ ] **Step 1: 실행기 계약 테스트를 후보 테스트에 추가 후 RED 확인**

```js
test('buildCandidateCommand는 공통 연구 인자를 한 번씩 생성한다', () => {
  const args = buildCandidateCommand(RESEARCH_CANDIDATES[0], {
    from: '20230102', to: '20260611', capital: 6_000_000, dump: 'x.json', seed: 1, subsample: 0.8, stress: 0,
  });
  assert.deepEqual(args.slice(0, 6), ['backtest-swing.mjs', '--from', '20230102', '--to', '20260611', '--capital']);
  assert.equal(args.filter(x => x === '--seed').length, 1);
});
```

- [ ] **Step 2: 실행기 구현**

명령 생성은 다음 구현을 사용한다.

```js
export function buildCandidateCommand(candidate, run) {
  return [
    'backtest-swing.mjs', '--from', run.from, '--to', run.to,
    '--capital', String(run.capital), ...candidate.args,
    '--dump', run.dump, '--seed', String(run.seed ?? 0),
    '--subsample', String(run.subsample ?? 1), '--stress', String(run.stress ?? 0),
  ];
}
```

실행기는 다음 순서를 고정한다.

1. A1, A2, B2, B3, C1, C2 기준 실행
2. 각 후보 `subsample 0.8 × seed 1..20`
3. 각 후보 비용·슬리피지 스트레스 실행
4. C2에서 위성 35% 손실 중단 C3 파생
5. `A1+C1`, `B2+C2`, `A2+C3` 바벨 조합
6. 20일 block bootstrap 20시드로 5년 종료자산과 1억원 도달률 계산
7. 데이터 게이트와 위험 기준으로 등급 판정
8. JSON과 Markdown 보고서 저장

- [ ] **Step 3: 정적 검사**

Run: `node --check run-100m-research.mjs`
Expected: exit 0

### Task 6: 전체 검증과 실험 실행

**Files:**
- Create: `research-results/100m-barbell-2026-07-22/summary.json`
- Create: `research-results/100m-barbell-2026-07-22/REPORT.md`

- [ ] **Step 1: 전체 테스트와 정적 검사**

Run: `npm.cmd test`
Expected: 125개 기존 테스트와 신규 테스트 전부 pass

Run: `npm.cmd run check`
Expected: syntax errors 0

- [ ] **Step 2: 전체 연구 실행**

Run: `node run-100m-research.mjs --from 20230102 --to 20260611 --capital 6000000 --seeds 20 --subsample 0.8`
Expected: 후보별 기준·MC·스트레스 결과와 세 바벨 조합 보고서 생성

- [ ] **Step 3: 결과 무결성 확인**

- 후보 수 9개 이하
- 각 실행 시드 20개
- 모든 수치가 finite
- 보고서에 데이터 범위 2021-09-29~2026-06-12와 생존편향 표시
- `LIVE_ELIGIBLE`이 데이터 게이트를 우회하지 않음
- VM·실계좌 파일과 서비스에 변경 없음
