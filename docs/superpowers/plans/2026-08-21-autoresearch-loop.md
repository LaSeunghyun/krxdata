# combo-v2 Autoresearch 안전장치 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** autoresearch 루프가 안전하게 돌 수 있도록 배선검증·교차오염 게이트·기각축 대조·세션 검증을 기계화한다.

**Architecture:** 순수 판정 로직을 테스트 가능한 모듈(`validation-lib.mjs`·`autoresearch-gate.mjs`·`autoresearch-log.mjs`)로 두고, spawn·파일IO는 얇은 CLI(`autoresearch-run.mjs`)에만 둔다. 게이트는 `backtest-swing.mjs --dump` 한 번의 결정론 실행에서 배선검증과 교차오염을 동시에 판정한다.

**Tech Stack:** Node.js ESM (`type: module`), `node --test` (기존 `tests/*.test.js` 규약), 외부 의존성 추가 없음.

**설계 원본:** `docs/superpowers/specs/2026-08-21-autoresearch-loop-design.md`

---

## 이 계획의 범위

**포함**: 안전장치와 루프 규약. 게이트 2종, 기각축 기계 대조, 세션 검증, base 지문 캐시, 루프 규약 문서.

**미포함(의도적)**: MC 판정 자동화. 설계서 §3-C의 6→30시드·IS/OOS·노이즈바닥 판정은 **기존 `mc-*.mjs` 수동 절차를 그대로 쓴다.** 이유는 두 가지다. ① 노이즈 바닥이 아직 이 구간에 대해 pin되지 않아 어차피 `keep`을 낼 수 없다. ② 게이트 없이 MC를 자동화하면 오탐 생성 속도만 오른다. 게이트가 먼저다.

`autoresearch-log.tsv`의 `delta_calmar`·`noise_floor_pass`·`is_oos_agree`·`seeds_n`은 사람이 수동 MC 결과를 기입하는 열이고, `autoresearch-verify.mjs`가 그 값을 기계 검사한다. 즉 판정은 사람이 하고 규율 준수는 기계가 강제한다.

## 사전 확인된 사실 (실측, 2026-08-21)

| 사실 | 값 |
|------|-----|
| 캔들 캐시 최대일 | `20260724` (= 방법론 §1-B 폭락 포함 구간) |
| combo-v2 단독 실행 | 3.0초 |
| 5전략 동시 실행 | 4.9초 (×1.6) |
| 결정론 | 동일 인자·seed에서 combo-v2 행 완전일치 |
| 덤프 구조 | `{books: {[strategy]: {cash, maxDD, trades[], daily[]}}}` (`research-backtest-output.mjs:6`) |
| `argOf` | `argv.indexOf` = **첫 출현만** (`backtest-swing.mjs:38`) → override는 prepend |
| combo-v2 분기 | `k === 'combo' \|\| k === 'combo-v2'` 공유 (1057·1067·1224·1848·1857행) |

## File Structure

| 파일 | 책임 |
|------|------|
| `validation-lib.mjs` (신규) | `median`·`mergeArgs`·`parseComboRow`·`calmar`·`mcMedian`. `validate-hypotheses.mjs`와 autoresearch가 공유. 순수 함수만 |
| `validate-hypotheses.mjs` (수정) | 위 함수들의 지역 정의를 삭제하고 lib import. **동작 불변** |
| `autoresearch-gate.mjs` (신규) | 지문 생성 + 배선검증/교차오염 판정. 순수 함수만 |
| `autoresearch-log.mjs` (신규) | 로그 행 포맷/파싱 + 기각축 매칭 + 세션 검증. 순수 함수만 |
| `rejected-axes.tsv` (신규) | 기각축 기계 대조 테이블. 메모리 문서 산문을 기계화 |
| `autoresearch-run.mjs` (신규) | 얇은 CLI — `--init`/`--gate`/`--probe`/`--verify`. spawn·파일IO 담당 |
| `autoresearch.md` (신규) | 루프 규약. `program.md` 대응. 사람이 편집 |
| `tests/validation-lib.test.js` (신규) | lib 순수 함수 테스트 |
| `tests/autoresearch-gate.test.js` (신규) | 게이트 판정 테스트 |
| `tests/autoresearch-log.test.js` (신규) | 로그·기각축·세션검증 테스트 |

---

## Task 1: `validation-lib.mjs` 추출

`validate-hypotheses.mjs`는 top-level IIFE라 import 불가하고, 휴장일에 `exit 0`으로 죽는다. 판정 유틸을 lib로 빼서 autoresearch가 쓸 수 있게 한다. 기존 VM 크론 동작은 바뀌면 안 된다.

**Files:**
- Create: `C:\claudeT\files\validation-lib.mjs`
- Create: `C:\claudeT\files\tests\validation-lib.test.js`
- Modify: `C:\claudeT\files\validate-hypotheses.mjs` (55·58-61·62-68·75-83행)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/validation-lib.test.js` 생성:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { median, mergeArgs, parseComboRow, calmar, mcMedian } from '../validation-lib.mjs';

// 실제 backtest-swing.mjs 출력 행(evolve-c0-full.log 에서 채취). 열 순서가 바뀌면 이 핀이 깨져야 한다.
const REAL_ROW = 'combo-v2     1431    57%   1.41    52.6%   21.2%    64%     3.9일  41,733,530원';

test('parseComboRow reads cagr/mdd/final from a real combo-v2 row', () => {
  const row = parseComboRow(`헤더\n${REAL_ROW}\n꼬리`);
  assert.equal(row.cagr, 52.6);
  assert.equal(row.mdd, 21.2);
  assert.equal(row.final, 41733530);
});

test('parseComboRow returns null when no combo-v2 row exists', () => {
  assert.equal(parseComboRow('아무것도 없음\nrsi2  100  50%'), null);
});

// ★ argOf 가 첫 출현만 읽으므로(backtest-swing.mjs:38) override 는 반드시 앞에 와야 한다.
test('mergeArgs puts override before base so argOf first-wins favors the override', () => {
  const merged = mergeArgs(['--slots', '5'], ['--strategies', 'combo-v2', '--slots', '3']);
  assert.deepEqual(merged, ['--slots', '5', '--strategies', 'combo-v2', '--slots', '3']);
  assert.ok(merged.indexOf('--slots') < merged.indexOf('--strategies'));
});

test('mergeArgs __DROP_LIVE_PARITY__ strips --live-parity from base', () => {
  const merged = mergeArgs(['__DROP_LIVE_PARITY__'], ['--live-parity', '--slots', '3']);
  assert.deepEqual(merged, ['--slots', '3']);
});

test('median handles even and odd lengths and empty input', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('calmar divides cagr by mdd and refuses non-positive mdd', () => {
  assert.equal(calmar(40, 20), 2);
  assert.equal(calmar(40, 0), null);
  assert.equal(calmar(null, 20), null);
});

// mcMedian 은 runBacktest 를 주입받으므로 실제 백테스트 없이 테스트한다.
test('mcMedian aggregates injected runs and reports how many seeds survived', () => {
  const rows = [
    { cagr: 40, mdd: 20, final: 100 },
    null,                               // 죽은 시드
    { cagr: 60, mdd: 20, final: 300 },
  ];
  let i = 0;
  const result = mcMedian([], { base: [], seeds: 3, runBacktest: () => rows[i++] });
  assert.equal(result.n, 2);
  assert.equal(result.seeds, 3);
  assert.equal(result.medianFinal, 200);
  assert.equal(result.medianCalmar, 2.5);
});

test('mcMedian passes seed and subsample through to the runner', () => {
  const seen = [];
  mcMedian(['--slots', '5'], {
    base: ['--live-parity'], seeds: 2,
    runBacktest: (args) => { seen.push(args); return { cagr: 1, mdd: 1, final: 1 }; },
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], ['--slots', '5', '--live-parity', '--seed', '1', '--subsample', '0.8']);
  assert.deepEqual(seen[1], ['--slots', '5', '--live-parity', '--seed', '2', '--subsample', '0.8']);
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `node --test tests/validation-lib.test.js`
Expected: FAIL — `Cannot find module '.../validation-lib.mjs'`

- [ ] **Step 3: `validation-lib.mjs`를 구현한다**

```js
// 공유 판정 유틸 — validate-hypotheses.mjs(VM 일일 크론)와 autoresearch 러너가 함께 쓴다.
// 순수 함수만 둔다. spawn·파일IO·전역상수는 호출자가 주입한다(테스트 가능성 확보).
// 2026-08-21 신설: validate-hypotheses.mjs 는 top-level IIFE + export 없음이라 재사용 불가였고,
//   휴장일에 exit 0 으로 즉시 종료해 직접 spawn 하면 조용히 아무것도 안 돈다.

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// ★ override(변형)를 앞에 둔다. backtest-swing.mjs 의 argOf 는 argv.indexOf = 첫 출현만 읽으므로
//   뒤에 붙이면 base 의 동일 플래그가 이겨 변형이 조용히 무효화된다(방법론 §3).
export function mergeArgs(override, base) {
  if (override.includes('__DROP_LIVE_PARITY__')) return base.filter(a => a !== '--live-parity');
  return [...override, ...base];
}

export function parseComboRow(out) {
  const line = out.split('\n').find(l => /^combo-v2\s/.test(l));
  if (!line) return null;
  const pcts = [...line.matchAll(/([0-9.]+)%/g)].map(m => Number(m[1]));  // [win, cagr, mdd, month]
  const fin = [...line.matchAll(/([0-9,]+)원/g)].map(m => Number(m[1].replace(/,/g, '')));
  return { cagr: pcts[1] ?? null, mdd: pcts[2] ?? null, final: fin[fin.length - 1] ?? null };
}

// Calmar = CAGR / MDD. 노이즈 바닥이 ΔCalmar 단위로 정의돼 있어(방법론 §1) 주지표로 쓴다.
export function calmar(cagr, mdd) {
  if (cagr == null || mdd == null || !(mdd > 0)) return null;
  return cagr / mdd;
}

// 한 변형의 MC 중앙값. runBacktest: (args) => {cagr,mdd,final}|null 을 주입받는다.
// n < seeds 면 죽은 시드가 있다는 뜻 — 호출자가 판정 전에 확인해야 한다(방법론 §1-F).
export function mcMedian(overrideArgs, { base, seeds, runBacktest, subsample = 0.8 }) {
  const merged = mergeArgs(overrideArgs, base);
  const finals = [], cagrs = [], mdds = [], calmars = [];
  for (let s = 1; s <= seeds; s++) {
    const row = runBacktest([...merged, '--seed', String(s), '--subsample', String(subsample)]);
    if (row?.final != null) {
      finals.push(row.final);
      cagrs.push(row.cagr);
      mdds.push(row.mdd);
      const c = calmar(row.cagr, row.mdd);
      if (c != null) calmars.push(c);
    }
  }
  return {
    medianFinal: median(finals),
    medianCagr: median(cagrs),
    medianMdd: median(mdds),
    medianCalmar: median(calmars),
    n: finals.length,
    seeds,
  };
}
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `node --test tests/validation-lib.test.js`
Expected: PASS — 8 tests

> `mcMedian` 은 기존 `mcMedianFinal` 반환값에 `medianCalmar`·`seeds` 두 필드를 더한 상위집합이다. 기존 호출부(89행 로그)는 그대로 동작하지만, `validation_ledger.detail` jsonb 에 이 두 필드가 새로 유입된다. 스키마 없는 jsonb 라 적재는 깨지지 않는다 — "동작 불변"은 이 한 가지 예외를 포함한 표현이다.

- [ ] **Step 5: 커밋한다**

```bash
git add validation-lib.mjs tests/validation-lib.test.js
git commit -m "feat: validation-lib 추출 - 공유 판정 유틸(mergeArgs prepend 규칙 고정)"
```

- [ ] **Step 6: `validate-hypotheses.mjs`가 lib를 쓰도록 교체한다**

`validate-hypotheses.mjs`의 import 블록에 추가(기존 `import { LIVE_PARITY_BASE, ... }` 줄 아래):

```js
import { median, mergeArgs, parseComboRow, mcMedian } from './validation-lib.mjs';
```

그리고 아래 4개 지역 정의를 **삭제**한다.
- 55행 `const median = (a) => {...};`
- 58-61행 `function mergeArgs(override) {...}`
- 62-68행 `function parseComboRow(out) {...}`
- 75-83행 `function mcMedianFinal(overrideArgs) {...}`

`mcMedianFinal` 호출부(88행)를 lib 시그니처로 바꾼다.

변경 전:
```js
    results[vName] = mcMedianFinal(vArgs);
```

변경 후:
```js
    results[vName] = mcMedian(vArgs, { base: LIVE_PARITY_BASE, seeds: SEEDS, runBacktest });
```

`mergeArgs` 호출부(125-126행 `runDump([...LIVE_PARITY_BASE, ...])`)는 `mergeArgs`를 쓰지 않으므로 수정 불필요.

- [ ] **Step 7: 기존 크론 동작이 안 깨졌는지 확인한다**

> ⚠️ **`node -e "import('./validate-hypotheses.mjs')"` 로 확인하지 말 것.** argv가 비어 기본값으로 돌기 때문에 거래일이면 **전체 일일 검증(백테스트 150여 회, 수 분~수십 분)이 실행되고 운영 `validation_ledger` 에 비정기 행이 적재된다.** 아래 절차를 쓴다.

먼저 문법과 고아 참조를 정적으로 본다.

```bash
node --check validate-hypotheses.mjs
grep -n "mergeArgs(\|mcMedianFinal" validate-hypotheses.mjs
```
Expected: `--check` 무출력(문법 통과). grep 결과 **0줄** — `mergeArgs`는 이제 인자 2개를 받으므로 1인자 호출이 남아 있으면 base가 `undefined`가 되어 터진다. `mcMedianFinal`도 완전히 사라져야 한다.

다음으로 추출된 경로를 실제로 한 번 태운다. 가설 1개·시드 1개로 제한하고 ledger·텔레그램을 끈다.

```bash
cp validation-latest.json validation-latest.json.bak
node validate-hypotheses.mjs --hyp slots --seeds 1 --no-ledger --no-telegram
mv validation-latest.json.bak validation-latest.json
```
Expected: `slots/s2`·`s3`·`s5` 각각의 중앙최종 로그가 나오고 `[HOLD] slots: 현재승자=s3` 로 끝난다(약 30초). **`ReferenceError` 가 나오면 안 된다.**

> `--no-ledger` 는 `validation_ledger` INSERT 와 CREATE TABLE 을 건너뛴다(203행 가드). 스냅샷 `validation-latest.json` 은 가드가 없어 덮어써지므로 위처럼 백업·복원한다. `--hyp slots` 를 주면 barbell(188행 `ONLY === 'barbell'` 불일치)과 데이터가설(197행 `!ONLY`)이 전부 건너뛰어진다.

마지막으로 전체 스위트를 돌린다.

```bash
npm test
```
Expected: PASS — 기존 199개 + 신규 8개 통과(회귀 없음)

> **`node --test tests/` 를 쓰지 말 것.** 이 환경(Node v22 / Windows)에서 디렉토리 인자는 `Cannot find module ...\tests` 로 즉사한다. `package.json` 의 `npm test`(`node --test tests/**/*.test.js`)나 개별 파일 지정을 쓴다.

- [ ] **Step 8: 커밋한다**

```bash
git add validate-hypotheses.mjs
git commit -m "refactor: validate-hypotheses 가 validation-lib 를 쓰게 교체 (동작 불변)"
```

---

## Task 2: `autoresearch-gate.mjs` — 배선검증 + 교차오염 게이트

한 번의 결정론 덤프 실행에서 두 가지를 판정한다. ① 대상(`combo-v2`)이 **실제로 바뀌었나**(안 바뀌면 `not-wired`) ② 건드리면 안 되는 전략이 **안 바뀌었나**(바뀌면 `contaminated`).

**Files:**
- Create: `C:\claudeT\files\autoresearch-gate.mjs`
- Create: `C:\claudeT\files\tests\autoresearch-gate.test.js`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/autoresearch-gate.test.js` 생성:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE_STRATEGIES, TARGET_STRATEGY,
  fingerprintBook, fingerprintDump, classifyGate, perturbFingerprint,
} from '../autoresearch-gate.mjs';

// backtest-swing.mjs --dump 구조: {books: {[strategy]: {cash, maxDD, trades[], daily[]}}}
// (research-backtest-output.mjs:6 serializeResearchBook)
const book = (trades, final, maxDD) => ({
  cash: 0,
  maxDD,
  trades: Array.from({ length: trades }, (_, i) => ({ pnl: i })),
  daily: [{ day: '20230102', equity: 6000000 }, { day: '20260724', equity: final }],
});

const dumpOf = (overrides = {}) => ({
  books: {
    'combo-v2': book(1231, 21603533, 33.3),
    combo: book(1100, 19000000, 30.1),
    rsi2: book(900, 15000000, 25.0),
    hi120: book(400, 12000000, 40.2),
    gapfollow: book(246, 11080930, 22.3),
    ...overrides,
  },
});

test('gate set excludes the target and excludes swing-rank', () => {
  assert.ok(!GATE_STRATEGIES.includes(TARGET_STRATEGY));
  // swing-rank 는 daily_rankings DB 쿼리를 추가로 유발하므로 게이트에서 제외한다.
  assert.ok(!GATE_STRATEGIES.includes('swing-rank'));
  // combo 는 반드시 포함 — combo-v2 와 코드 분기를 공유하므로 공유코드 오염의 카나리아다.
  assert.ok(GATE_STRATEGIES.includes('combo'));
});

test('fingerprintBook takes trade count, last equity, and maxDD', () => {
  assert.deepEqual(fingerprintBook(book(3, 999, 12.5)), { trades: 3, final: 999, maxDD: 12.5 });
});

test('fingerprintBook returns null for a missing book', () => {
  assert.equal(fingerprintBook(null), null);
});

test('fingerprintDump maps every strategy in the dump', () => {
  const fp = fingerprintDump(dumpOf());
  assert.equal(fp['combo-v2'].trades, 1231);
  assert.equal(fp.gapfollow.final, 11080930);
});

test('classifyGate returns ok when only the target changed', () => {
  const base = fingerprintDump(dumpOf());
  const cand = fingerprintDump(dumpOf({ 'combo-v2': book(1250, 22000000, 32.0) }));
  const v = classifyGate(base, cand);
  assert.equal(v.status, 'ok');
  assert.equal(v.targetChanged, true);
  assert.deepEqual(v.changedGate, []);
});

// ★ 배선 미적용 = 값이 완전히 동일. discard 로 기록하면 시도조차 안 한 축이
//   기각축 표에 영구 등재된다(전례: backtest-swing.mjs:1551 ROTATE 죽은 코드).
test('classifyGate returns not-wired when the target did not move at all', () => {
  const base = fingerprintDump(dumpOf());
  const v = classifyGate(base, fingerprintDump(dumpOf()));
  assert.equal(v.status, 'not-wired');
  assert.equal(v.targetChanged, false);
});

test('classifyGate returns contaminated when a gate strategy moved', () => {
  const base = fingerprintDump(dumpOf());
  const cand = fingerprintDump(dumpOf({
    'combo-v2': book(1250, 22000000, 32.0),
    combo: book(1101, 19000000, 30.1),   // 공유 분기 오염
  }));
  const v = classifyGate(base, cand);
  assert.equal(v.status, 'contaminated');
  assert.deepEqual(v.changedGate, ['combo']);
});

// 오염된 런에서는 target 변화값을 신뢰할 수 없으므로 오염이 배선검증을 이긴다.
test('contamination outranks not-wired when both conditions hold', () => {
  const base = fingerprintDump(dumpOf());
  const cand = fingerprintDump(dumpOf({ rsi2: book(901, 15000000, 25.0) }));
  const v = classifyGate(base, cand);
  assert.equal(v.status, 'contaminated');
  assert.equal(v.targetChanged, false);
});

test('classifyGate reports missing when a required strategy is absent', () => {
  const base = fingerprintDump(dumpOf());
  const partial = fingerprintDump({ books: { 'combo-v2': book(1, 2, 3) } });
  const v = classifyGate(base, partial);
  assert.equal(v.status, 'missing');
  assert.ok(v.missing.includes('combo'));
});

// 게이트 생존 증명용 프로브 — 한 번도 안 울리는 게이트는 죽은 게이트와 구분할 수 없다.
test('perturbFingerprint mutates exactly one gate strategy so the probe can fire', () => {
  const base = fingerprintDump(dumpOf());
  const probe = perturbFingerprint(base, 'rsi2');
  assert.notEqual(probe.rsi2.trades, base.rsi2.trades);
  assert.equal(probe['combo-v2'].trades, base['combo-v2'].trades);
  assert.equal(classifyGate(base, probe).status, 'contaminated');
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `node --test tests/autoresearch-gate.test.js`
Expected: FAIL — `Cannot find module '.../autoresearch-gate.mjs'`

- [ ] **Step 3: `autoresearch-gate.mjs`를 구현한다**

```js
// autoresearch 게이트 2종 — backtest-swing.mjs --dump 산출물만 입력으로 받는 순수 로직.
//
// ① 배선검증: 대상(combo-v2)이 실제로 바뀌었나. 안 바뀌면 not-wired.
//    근거 — non-live-parity 분기에 코드를 넣으면 --live-parity 실행에서 수치가 완전히 동일하게 나온다
//    (전례: backtest-swing.mjs:1551 ROTATE 죽은 코드, --caps A ≡ --caps G).
//    이를 discard 로 기록하면 시도조차 안 한 축이 기각축 표에 영구 등재돼 이후 탐색을 오염시킨다.
// ② 교차오염: combo-v2 는 레거시 combo 와 코드 분기를 공유하므로(k==='combo'||k==='combo-v2',
//    backtest-swing.mjs 1057·1067·1224·1848·1857행) 가드 없는 수정이 다른 전략 수치를 조용히 바꾼다.
//
// 지문은 stdout 을 파싱하지 않는다 — 에이전트가 출력 포맷을 건드리면 조용히 무너진다.

export const TARGET_STRATEGY = 'combo-v2';

// combo = 공유 분기 카나리아. swing-rank 는 daily_rankings DB 쿼리를 추가 유발하므로 제외.
export const GATE_STRATEGIES = Object.freeze(['combo', 'rsi2', 'hi120', 'gapfollow']);

export function fingerprintBook(book) {
  if (!book) return null;
  const daily = book.daily ?? [];
  return {
    trades: (book.trades ?? []).length,
    final: daily.length ? daily[daily.length - 1].equity : null,
    maxDD: book.maxDD ?? null,
  };
}

export function fingerprintDump(dump) {
  const books = dump?.books ?? {};
  const out = {};
  for (const key of Object.keys(books)) out[key] = fingerprintBook(books[key]);
  return out;
}

function sameFingerprint(a, b) {
  if (!a || !b) return false;
  return a.trades === b.trades && a.final === b.final && a.maxDD === b.maxDD;
}

/**
 * @returns {{status: 'ok'|'not-wired'|'contaminated'|'missing', missing: string[],
 *            changedGate: string[], targetChanged: boolean}}
 */
export function classifyGate(baseFp, candFp, { target = TARGET_STRATEGY, gate = GATE_STRATEGIES } = {}) {
  const missing = [];
  for (const key of [target, ...gate]) {
    if (!baseFp?.[key] || !candFp?.[key]) missing.push(key);
  }
  if (missing.length) return { status: 'missing', missing, changedGate: [], targetChanged: false };

  const changedGate = gate.filter(key => !sameFingerprint(baseFp[key], candFp[key]));
  const targetChanged = !sameFingerprint(baseFp[target], candFp[target]);

  // 오염된 런의 target 변화는 신뢰할 수 없으므로 오염이 배선검증을 이긴다.
  if (changedGate.length) return { status: 'contaminated', missing, changedGate, targetChanged };
  if (!targetChanged) return { status: 'not-wired', missing, changedGate, targetChanged };
  return { status: 'ok', missing, changedGate, targetChanged };
}

// 센서 생존 프로브 — 실제 base 지문의 게이트 전략 하나만 흔들어 게이트가 발화하는지 본다.
export function perturbFingerprint(baseFp, strategy) {
  const target = baseFp?.[strategy];
  if (!target) throw new Error(`perturbFingerprint: 지문에 ${strategy} 가 없다`);
  return { ...baseFp, [strategy]: { ...target, trades: target.trades + 1 } };
}
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `node --test tests/autoresearch-gate.test.js`
Expected: PASS — 10 tests

- [ ] **Step 5: 커밋한다**

```bash
git add autoresearch-gate.mjs tests/autoresearch-gate.test.js
git commit -m "feat: autoresearch 게이트 - 배선검증(not-wired) + 교차오염(combo 카나리아)"
```

---

## Task 3: `rejected-axes.tsv` — 기각축 기계화

현재 기각축은 `project_krxdata_validation_method.md`의 산문이라 기계 대조가 불가능하다. TSV로 옮겨 루프가 매 라운드 대조할 수 있게 한다.

**Files:**
- Create: `C:\claudeT\files\rejected-axes.tsv`

- [ ] **Step 1: 기각축 테이블을 만든다**

`rejected-axes.tsv` 생성 (탭 구분. 키워드는 `|` 구분이고 **전부 포함(AND)** 되어야 매칭):

```
# autoresearch 기각축 대조 테이블. 출처: project_krxdata_validation_method.md §5·§10 + 2026-08-04 측정.
# keywords 는 | 구분이고 AND 조건이다. 제안 설명에 키워드가 전부 들어가면 재제안으로 판정한다.
# 새 기각이 확정되면 사람이 여기 추가한다. not-wired 는 절대 추가하지 않는다.
axis_id	keywords	note
rotation	로테이션	Calmar 1.73→0.37 · 시드 0승 30패
sectorcap	섹터캡	cap2 Δ-0.01(효과0) · cap1 Δ-0.51(악화)
down_rsi_block	down|rsi2|차단	Δ-0.35 악화. 1승9패는 노이즈였다
maexitmin	ma익절|최소수익	maexitmin 1 Δ-0.54 악화
roe_pbr_residual	roe|pbr|잔차	십분위 스프레드 -0.121% < 귀무바닥 0.402%
cashflow_factors	현금흐름	cfy·fcfy·cfconv·accrual 연도부호 불일치
ma_distance_rank	ma거리|정렬	asc Δ-0.75(2승58패) · desc Δ-1.35
atr_exclude	atr|배제	p50 -0.06 / p90 -0.25 / p95 -0.39 꼬리악화
lowvol	저변동성	프리미엄이 전부 숏 쪽. 롱온리로 수확 불가
hi120_regime	hi120|레짐	IS/OOS 로 기각. 횡보장 MDD 2.05배
rsi_tp	rsi2|익절목표	승률·손익비 동반 악화. 중간(MA3)이 봉우리
pit_reweight	pit|재가중	value IC 0.049 = 세 겹 아티팩트
intraday_flow	장중|수급	하루 5회 고정 스냅샷. 선행 예측력 +0.033
halfyear_screen	반기|스크린	PM 단독보다 나빠진다. 2026-08-14 기각
sector_value	싼섹터|우량	무작위보다 나쁨. 방향 역전
volsize	변동성|사이징	승자 Calmar 1.80→1.13
relstop	상대손절	MC서 CAGR↓·MDD↑. mean-reversion 과 충돌
regimeexp	레짐|스로틀	풀투자>스로틀. 레짐 감지 지연
scalp_selftime	자기시계열|스캘핑	5분 엣지 +0.0014%p = 비용의 1/294
residmax	잔차|상한	단조 악화. 극단 잔차 92건이 평균적으로 이익
```

- [ ] **Step 2: 파싱 가능한지 확인한다**

Run:
```bash
node -e "
const t=require('fs').readFileSync('rejected-axes.tsv','utf8');
const rows=t.split(/\r?\n/).filter(l=>l.trim()&&!l.startsWith('#')).map(l=>l.split('\t'));
const bad=rows.filter(r=>r.length!==3);
console.log('rows',rows.length,'malformed',bad.length);
if(bad.length){console.error(bad);process.exit(1);}
"
```
Expected: `rows 21 malformed 0` (헤더 1 + 축 20)

- [ ] **Step 3: 커밋한다**

```bash
git add rejected-axes.tsv
git commit -m "feat: 기각축 기계 대조 테이블 - 메모리 산문을 TSV 로"
```

---

## Task 4: `autoresearch-log.mjs` — 로그·기각축 매칭·세션 검증

설계서 §10의 4개 성공기준을 기계 assert로 만든다. 검증 스크립트가 없으면 §10은 선언에 그치고, "발견 0건"과 "루프가 통째로 죽어 0건"을 구분할 수 없다.

**Files:**
- Create: `C:\claudeT\files\autoresearch-log.mjs`
- Create: `C:\claudeT\files\tests\autoresearch-log.test.js`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/autoresearch-log.test.js` 생성:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOG_COLUMNS, LOG_STATUSES,
  formatLogRow, parseLog, parseAxes, matchRejectedAxis, verifySession,
} from '../autoresearch-log.mjs';

const AXES = parseAxes([
  'axis_id\tkeywords\tnote',
  'rotation\t로테이션\t0승 30패',
  'down_rsi_block\tdown|rsi2|차단\tΔ-0.35',
].join('\n'));

const keepRow = (over = {}) => ({
  commit: 'abc1234', axis_id: 'new-axis', delta_calmar: '0.62', median_final: '22000000',
  noise_floor_pass: 'true', is_oos_agree: 'true', seeds_n: '30', status: 'keep',
  description: '손절 폭을 넓힌다', ...over,
});

test('log has the columns and statuses the spec defines', () => {
  assert.deepEqual([...LOG_COLUMNS], [
    'commit', 'axis_id', 'delta_calmar', 'median_final',
    'noise_floor_pass', 'is_oos_agree', 'seeds_n', 'status', 'description',
  ]);
  assert.deepEqual([...LOG_STATUSES], ['keep', 'discard', 'not-wired', 'contaminated', 'crash']);
});

// 설명에 탭이 들어가면 열이 밀린다 — 원본 program.md 도 TSV 를 쓰는 이유가 이것이다.
test('formatLogRow neutralizes tabs and newlines in free text', () => {
  const line = formatLogRow(keepRow({ description: 'a\tb\nc' }));
  assert.equal(line.split('\t').length, LOG_COLUMNS.length);
  assert.ok(line.endsWith('a b c'));
});

test('parseLog skips the header row', () => {
  const text = [LOG_COLUMNS.join('\t'), formatLogRow(keepRow())].join('\n');
  const rows = parseLog(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'keep');
  assert.equal(rows[0].seeds_n, '30');
});

test('parseAxes splits keywords and ignores comments', () => {
  const axes = parseAxes('# 주석\naxis_id\tkeywords\tnote\nrotation\t로테이션|이익전환\t메모');
  assert.equal(axes.length, 1);
  assert.deepEqual(axes[0].keywords, ['로테이션', '이익전환']);
});

test('matchRejectedAxis fires when every keyword of an axis is present', () => {
  assert.equal(matchRejectedAxis('로테이션을 다시 켜본다', AXES).axis_id, 'rotation');
  assert.equal(matchRejectedAxis('DOWN 레짐 rsi2 를 전면 차단', AXES).axis_id, 'down_rsi_block');
});

test('matchRejectedAxis does not fire on a partial keyword hit', () => {
  // 'down' 과 'rsi2' 는 있지만 '차단' 이 없다 → 다른 축이다.
  assert.equal(matchRejectedAxis('DOWN 레짐에서 rsi2 를 더 산다', AXES), null);
});

test('verifySession passes a clean session', () => {
  const v = verifySession([keepRow()], {
    axes: AXES, floorPinned: true, floorCalmar: 0.316, probeFired: true,
    mainCommitBefore: 'deadbee', mainCommitAfter: 'deadbee',
  });
  assert.equal(v.pass, true, JSON.stringify(v.failures));
  assert.equal(v.keeps, 1);
});

// 사람이 적은 noise_floor_pass 를 그대로 믿으면 오기입 keep 이 통과한다 → 바닥 수치와 직접 대조한다.
test('verifySession rejects a keep whose delta_calmar does not clear the pinned floor', () => {
  const v = verifySession([keepRow({ delta_calmar: '0.20', noise_floor_pass: 'true' })], {
    axes: AXES, floorPinned: true, floorCalmar: 0.316, probeFired: true,
    mainCommitBefore: 'a', mainCommitAfter: 'a',
  });
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('keep-below-floor')));
});

test('verifySession rejects a keep with an unparseable delta_calmar', () => {
  const v = verifySession([keepRow({ delta_calmar: '' })], {
    axes: AXES, floorPinned: true, floorCalmar: 0.316, probeFired: true,
    mainCommitBefore: 'a', mainCommitAfter: 'a',
  });
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('keep-below-floor')));
});

test('verifySession fails when a rejected axis was reproposed', () => {
  const v = verifySession([keepRow({ description: '로테이션 재시도' })], {
    axes: AXES, floorPinned: true, probeFired: true,
    mainCommitBefore: 'a', mainCommitAfter: 'a',
  });
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('rejected-axis-reproposed')));
});

// 한 번도 발화하지 않은 게이트는 죽은 게이트와 구분할 수 없다.
test('verifySession fails when the contamination probe never fired', () => {
  const v = verifySession([keepRow()], {
    axes: AXES, floorPinned: true, probeFired: false,
    mainCommitBefore: 'a', mainCommitAfter: 'a',
  });
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('contamination-probe-did-not-fire')));
});

test('verifySession rejects keep rows that skipped the noise floor or IS/OOS', () => {
  const v = verifySession(
    [keepRow({ noise_floor_pass: 'false' }), keepRow({ is_oos_agree: 'false' })],
    { axes: AXES, floorPinned: true, probeFired: true, mainCommitBefore: 'a', mainCommitAfter: 'a' },
  );
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('keep-without-floor-pass')));
  assert.ok(v.failures.some(f => f.includes('keep-without-is-oos-agreement')));
});

test('verifySession rejects keep confirmed on fewer than 30 seeds', () => {
  const v = verifySession([keepRow({ seeds_n: '6' })], {
    axes: AXES, floorPinned: true, probeFired: true, mainCommitBefore: 'a', mainCommitAfter: 'a',
  });
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('keep-with-insufficient-seeds')));
});

test('verifySession refuses any keep while the noise floor is unpinned', () => {
  const v = verifySession([keepRow()], {
    axes: AXES, floorPinned: false, probeFired: true, mainCommitBefore: 'a', mainCommitAfter: 'a',
  });
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('floor-unpinned-but-keep-exists')));
});

test('verifySession fails when main moved during the session', () => {
  const v = verifySession([keepRow()], {
    axes: AXES, floorPinned: true, probeFired: true,
    mainCommitBefore: 'aaaaaaa', mainCommitAfter: 'bbbbbbb',
  });
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('main-moved')));
});

// 발견 0건은 실패가 아니다 — 3승 46패 영역에서 6회 루프의 기대 발견 수는 1건 미만이다.
test('verifySession passes a session with zero findings', () => {
  const rows = [keepRow({ status: 'discard', description: '무해한 시도' })];
  const v = verifySession(rows, {
    axes: AXES, floorPinned: false, probeFired: true,
    mainCommitBefore: 'a', mainCommitAfter: 'a',
  });
  assert.equal(v.pass, true, JSON.stringify(v.failures));
  assert.equal(v.keeps, 0);
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `node --test tests/autoresearch-log.test.js`
Expected: FAIL — `Cannot find module '.../autoresearch-log.mjs'`

- [ ] **Step 3: `autoresearch-log.mjs`를 구현한다**

```js
// autoresearch 로그 포맷 + 기각축 대조 + 세션 검증. 순수 함수만 둔다.
// 설계서 §7·§10 대응. 검증 스크립트가 없으면 §10 은 선언에 그치고,
// "발견 0건"과 "루프가 통째로 죽어 0건"을 구분할 수 없다.

export const LOG_COLUMNS = Object.freeze([
  'commit', 'axis_id', 'delta_calmar', 'median_final',
  'noise_floor_pass', 'is_oos_agree', 'seeds_n', 'status', 'description',
]);

// not-wired = 배선 미적용(discard 아님. 기각축으로 병합 금지)
export const LOG_STATUSES = Object.freeze(['keep', 'discard', 'not-wired', 'contaminated', 'crash']);

export function formatLogRow(row) {
  return LOG_COLUMNS
    .map(col => String(row[col] ?? '').replace(/[\t\r\n]+/g, ' '))
    .join('\t');
}

export function parseLogRow(line) {
  const cells = line.split('\t');
  const row = {};
  LOG_COLUMNS.forEach((col, i) => { row[col] = cells[i] ?? ''; });
  return row;
}

export function parseLog(text) {
  const lines = String(text).split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const isHeader = lines[0].split('\t')[0] === LOG_COLUMNS[0];
  return (isHeader ? lines.slice(1) : lines).map(parseLogRow);
}

// rejected-axes.tsv: axis_id \t keywords(| 구분, AND) \t note
export function parseAxes(text) {
  return String(text).split(/\r?\n/)
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => line.split('\t'))
    .filter(cells => cells[0] && cells[0] !== 'axis_id')
    .map(([axis_id, keywords, note]) => ({
      axis_id,
      keywords: String(keywords ?? '').split('|').map(k => k.trim().toLowerCase()).filter(Boolean),
      note: note ?? '',
    }));
}

// 키워드 AND. 부분 일치로 발화하면 정당한 신규 축까지 막으므로 전부 포함을 요구한다.
export function matchRejectedAxis(description, axes) {
  const text = String(description ?? '').toLowerCase();
  for (const axis of axes) {
    if (axis.keywords.length && axis.keywords.every(k => text.includes(k))) return axis;
  }
  return null;
}

/**
 * 설계서 §10 의 4개 기준을 일괄 assert 한다.
 * @returns {{pass: boolean, failures: string[], rounds: number, keeps: number}}
 */
export function verifySession(logRows, {
  axes = [], floorPinned = false, floorCalmar = null, probeFired = false,
  mainCommitBefore = null, mainCommitAfter = null, requiredSeeds = 30,
} = {}) {
  const failures = [];
  const keeps = logRows.filter(r => r.status === 'keep');

  // ① 기각축을 다시 제안하지 않았다
  for (const row of logRows) {
    const hit = matchRejectedAxis(row.description, axes);
    if (hit) failures.push(`rejected-axis-reproposed: ${row.commit || '(no commit)'} → ${hit.axis_id}`);
  }

  // ② 교차오염 센서가 살아 있었다 — 한 번도 발화하지 않은 게이트는 죽은 게이트와 구분 불가
  if (!probeFired) failures.push('contamination-probe-did-not-fire: 게이트 생존 미증명');

  // ③ 바닥 미달·IS/OOS 불일치·시드 미충원 keep 이 없다
  if (keeps.length && !floorPinned) {
    failures.push('floor-unpinned-but-keep-exists: 노이즈 바닥이 이 구간에 pin 되지 않았다');
  }
  for (const row of keeps) {
    if (String(row.noise_floor_pass) !== 'true') failures.push(`keep-without-floor-pass: ${row.commit}`);
    if (String(row.is_oos_agree) !== 'true') failures.push(`keep-without-is-oos-agreement: ${row.commit}`);
    if (!(Number(row.seeds_n) >= requiredSeeds)) {
      failures.push(`keep-with-insufficient-seeds: ${row.commit} (n=${row.seeds_n} < ${requiredSeeds})`);
    }
    // 사람이 적은 boolean 을 그대로 믿지 않는다 — 바닥 수치와 직접 대조한다(설계서 §10).
    if (Number.isFinite(floorCalmar)) {
      const delta = Number(row.delta_calmar);
      if (!Number.isFinite(delta) || !(delta > floorCalmar)) {
        failures.push(`keep-below-floor: ${row.commit} (Δ=${row.delta_calmar || '(빈값)'} ≤ 바닥 ${floorCalmar})`);
      }
    }
  }

  // ④ main 이 변하지 않았다
  if (mainCommitBefore && mainCommitAfter && mainCommitBefore !== mainCommitAfter) {
    failures.push(`main-moved: ${mainCommitBefore} → ${mainCommitAfter}`);
  }

  return { pass: failures.length === 0, failures, rounds: logRows.length, keeps: keeps.length };
}
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `node --test tests/autoresearch-log.test.js`
Expected: PASS — 16 tests

- [ ] **Step 5: 커밋한다**

```bash
git add autoresearch-log.mjs tests/autoresearch-log.test.js
git commit -m "feat: autoresearch 로그·기각축 대조·세션 검증(§10 기계화)"
```

---

## Task 5: `autoresearch-run.mjs` — CLI

순수 로직을 실제 백테스트에 연결하는 얇은 껍데기. spawn·파일IO만 담당한다.

**Files:**
- Create: `C:\claudeT\files\autoresearch-run.mjs`

- [ ] **Step 1: CLI를 구현한다**

```js
#!/usr/bin/env node
/**
 * autoresearch 러너 — 게이트 실행과 세션 검증만 한다. MC 판정은 하지 않는다.
 *
 *   node autoresearch-run.mjs --init          # 현재 커밋의 base 지문을 캐시
 *   node autoresearch-run.mjs --gate          # 지금 코드로 게이트 판정 (exit 0=ok)
 *   node autoresearch-run.mjs --probe         # 오염 센서 생존 프로브
 *   node autoresearch-run.mjs --verify        # 세션 종료 검증 (§10)
 *
 * MC 판정(ΔCalmar·6→30시드·IS/OOS·노이즈바닥)은 기존 mc-*.mjs 수동 절차를 쓴다.
 * 사람이 그 결과를 autoresearch-log.tsv 에 기입하고 --verify 가 규율 준수를 검사한다.
 */
import { spawnSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { LIVE_PARITY_BASE } from './validation-registry.mjs';
import { mergeArgs } from './validation-lib.mjs';
import {
  TARGET_STRATEGY, GATE_STRATEGIES,
  fingerprintDump, classifyGate, perturbFingerprint,
} from './autoresearch-gate.mjs';
import { parseLog, parseAxes, verifySession } from './autoresearch-log.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const BASE_FILE = join(__dirname, 'autoresearch-base.json');
const LOG_FILE = join(__dirname, 'autoresearch-log.tsv');
const AXES_FILE = join(__dirname, 'rejected-axes.tsv');
const PROBE_FILE = join(__dirname, 'autoresearch-probe.json');

// 방법론 §1-B: 폭락을 반드시 포함한다. 20260724 = 캔들 캐시 최대일(2026-08-21 실측).
// 캔들이 연장되면 이 값을 올린다. base 의 --to 20260611 은 폭락 제외 구간이라 쓰지 않는다.
const TO = argOf('--to', '20260724');
const FROM = argOf('--from', '20230102');

const git = (...args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8' }).trim();

// 게이트 런: 결정론(subsample 1)·전 게이트 전략 동시. override 는 prepend 해야 argOf 첫값 규칙에서 이긴다.
function gateArgs() {
  return mergeArgs([
    '--strategies', [TARGET_STRATEGY, ...GATE_STRATEGIES].join(','),
    '--from', FROM, '--to', TO,
    '--seed', '1', '--subsample', '1',
  ], LIVE_PARITY_BASE);
}

function runFingerprint() {
  const dumpPath = join(__dirname, `._ar_gate_${process.pid}.json`);
  const r = spawnSync('node', ['backtest-swing.mjs', ...gateArgs(), '--dump', dumpPath],
    { cwd: __dirname, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  if (!existsSync(dumpPath)) {
    console.error('덤프가 생성되지 않았다. 백테스트 실패:');
    console.error(((r.stdout || '') + (r.stderr || '')).slice(-2000));
    return null;
  }
  try {
    // timeout 이 덤프를 반쯤 쓴 채 죽이면 JSON.parse 가 터진다 → null 로 돌려 status=crash 가 되게 한다.
    return fingerprintDump(JSON.parse(readFileSync(dumpPath, 'utf8')));
  } catch (e) {
    console.error(`덤프 파싱 실패(중단된 실행일 수 있다): ${e.message}`);
    return null;
  } finally {
    try { unlinkSync(dumpPath); } catch { /* */ }
  }
}

const loadBase = () => {
  if (!existsSync(BASE_FILE)) {
    console.error(`base 지문이 없다. 먼저 --init 을 돌린다: ${BASE_FILE}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(BASE_FILE, 'utf8'));
};

if (argv.includes('--init')) {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === 'main') {
    console.error('main 에서 --init 하지 않는다. autoresearch/<tag> 브랜치를 먼저 만든다.');
    process.exit(2);
  }
  const dirty = git('status', '--porcelain', '--', 'backtest-swing.mjs');
  if (dirty) {
    console.error('backtest-swing.mjs 에 미커밋 변경이 있다. base 지문은 깨끗한 상태에서 떠야 한다.');
    process.exit(2);
  }
  const fingerprint = runFingerprint();
  if (!fingerprint) process.exit(1);
  writeFileSync(BASE_FILE, JSON.stringify({
    commit: git('rev-parse', '--short', 'HEAD'),
    mainCommit: git('rev-parse', '--short', 'main'),
    branch,
    args: { from: FROM, to: TO, target: TARGET_STRATEGY, gate: [...GATE_STRATEGIES] },
    fingerprint,
  }, null, 2));
  console.log(`base 지문 저장 (commit ${git('rev-parse', '--short', 'HEAD')}, main ${git('rev-parse', '--short', 'main')})`);
  for (const [k, v] of Object.entries(fingerprint)) {
    console.log(`  ${k.padEnd(10)} trades=${v.trades} final=${v.final} maxDD=${v.maxDD}`);
  }
  process.exit(0);
}

if (argv.includes('--gate')) {
  const base = loadBase();
  const candidate = runFingerprint();
  if (!candidate) { console.log('status=crash'); process.exit(1); }
  const verdict = classifyGate(base.fingerprint, candidate);
  console.log(`status=${verdict.status}`);
  if (verdict.missing.length) console.log(`missing=${verdict.missing.join(',')}`);
  if (verdict.changedGate.length) console.log(`changedGate=${verdict.changedGate.join(',')}`);
  console.log(`targetChanged=${verdict.targetChanged}`);
  for (const key of [TARGET_STRATEGY, ...GATE_STRATEGIES]) {
    const b = base.fingerprint[key], c = candidate[key];
    if (b && c) console.log(`  ${key.padEnd(10)} ${b.trades}/${b.final} → ${c.trades}/${c.final}`);
  }
  if (verdict.status === 'not-wired') {
    console.log('\n★ 배선 미적용이다. discard 로 기록하지 말 것 — 기각축 표가 오염된다.');
    console.log('  override 를 prepend 했는지, non-live-parity 분기에 넣지 않았는지 확인한다.');
  }
  if (verdict.status === 'contaminated') {
    console.log('\n★ 교차오염이다. 공유 분기(k===\'combo\'||k===\'combo-v2\')를 cfg.v2 로 가드한다.');
  }
  process.exit(verdict.status === 'ok' ? 0 : 1);
}

if (argv.includes('--probe')) {
  const base = loadBase();
  const strategy = argOf('--probe-strategy', GATE_STRATEGIES[0]);
  const perturbed = perturbFingerprint(base.fingerprint, strategy);
  const verdict = classifyGate(base.fingerprint, perturbed);
  const fired = verdict.status === 'contaminated' && verdict.changedGate.includes(strategy);
  writeFileSync(PROBE_FILE, JSON.stringify({ strategy, fired, verdict }, null, 2));
  console.log(fired
    ? `프로브 발화 확인 — ${strategy} 교란이 contaminated 로 잡혔다.`
    : `프로브 미발화 — 게이트가 죽어 있다. status=${verdict.status}`);
  process.exit(fired ? 0 : 1);
}

if (argv.includes('--verify')) {
  const base = loadBase();
  const rows = existsSync(LOG_FILE) ? parseLog(readFileSync(LOG_FILE, 'utf8')) : [];
  const axes = parseAxes(readFileSync(AXES_FILE, 'utf8'));
  const probe = existsSync(PROBE_FILE) ? JSON.parse(readFileSync(PROBE_FILE, 'utf8')) : { fired: false };
  const floorFile = join(__dirname, 'autoresearch-floor.json');
  const floor = existsSync(floorFile) ? JSON.parse(readFileSync(floorFile, 'utf8')) : {};
  const floorCalmar = floor?.[`${FROM}_${TO}`]?.calmar30 ?? null;
  const floorPinned = Number.isFinite(floorCalmar);

  const result = verifySession(rows, {
    axes,
    floorPinned,
    floorCalmar,
    probeFired: probe.fired === true,
    mainCommitBefore: base.mainCommit,
    mainCommitAfter: git('rev-parse', '--short', 'main'),
  });

  console.log(`rounds=${result.rounds} keeps=${result.keeps} floorPinned=${floorPinned}${floorPinned ? ` (Δ바닥 ${floorCalmar})` : ''}`);
  if (result.pass) {
    console.log('PASS — 4개 기준 전부 통과. 발견 0건이어도 정상이다.');
    process.exit(0);
  }
  console.log('FAIL:');
  for (const f of result.failures) console.log(`  - ${f}`);
  process.exit(1);
}

console.error('사용법: --init | --gate | --probe | --verify  (선택: --to YYYYMMDD)');
process.exit(2);
```

- [ ] **Step 2: 사용법 안내가 나오는지 확인한다**

Run: `node autoresearch-run.mjs`
Expected: `사용법: --init | --gate | --probe | --verify ...`, exit code 2

- [ ] **Step 3: main에서 `--init`이 거부되는지 확인한다**

Run: `git branch --show-current` → `main`인 상태에서 `node autoresearch-run.mjs --init`
Expected: `main 에서 --init 하지 않는다...`, exit code 2

- [ ] **Step 4: base 없이 `--gate`가 안전하게 죽는지 확인한다**

Run: `node autoresearch-run.mjs --gate`
Expected: `base 지문이 없다. 먼저 --init 을 돌린다: ...`, exit code 2

- [ ] **Step 5: 로그 헤더와 바닥 설정 파일을 만든다**

`autoresearch-log.tsv` 생성 (헤더만):

```
commit	axis_id	delta_calmar	median_final	noise_floor_pass	is_oos_agree	seeds_n	status	description
```

`autoresearch-floor.json` 생성 — **바닥은 pin되지 않은 상태로 시작한다.** 이 상태에서는 `--verify`가 어떤 `keep`도 통과시키지 않는다. 사람이 `perturb-candles.mjs` + `mc-*.mjs`로 이 구간의 바닥을 재고 값을 채워야 `keep`이 가능해진다.

```json
{
  "_note": "노이즈 바닥. 키는 <from>_<to>. calmar30 = 30시드 ΔCalmar 판정 하한. null = 미측정.",
  "_how": "perturb-candles.mjs 로 교란본을 만들고 mc-*.mjs 의 grp:'noise' 대조군으로 잰다. 방법론 §1 참조.",
  "_warning": "구간·시드수마다 값이 다르다. 다른 구간의 값을 재사용하면 안 된다.",
  "20230102_20260724": { "calmar30": null }
}
```

`.gitignore`에 실행 산출물을 추가한다(로그·지문·프로브는 git 미추적):

```
autoresearch-base.json
autoresearch-probe.json
autoresearch-log.tsv
```

- [ ] **Step 6: 전체 스위트가 통과하는지 확인한다**

Run: `npm test`
Expected: PASS — 기존 199개 + 신규 34개 전부 통과

> 다시 강조: `node --test tests/`(디렉토리 인자)는 이 환경에서 `Cannot find module` 로 즉사한다. `npm test` 를 쓴다.

- [ ] **Step 7: 커밋한다**

```bash
git add autoresearch-run.mjs autoresearch-floor.json .gitignore
git commit -m "feat: autoresearch CLI - init/gate/probe/verify (MC 판정은 수동 mc-* 유지)"
```

---

## Task 6: `autoresearch.md` — 루프 규약

`program.md`에 대응하는 문서. 에이전트가 매 라운드 읽는다.

**Files:**
- Create: `C:\claudeT\files\autoresearch.md`

- [ ] **Step 1: 루프 규약을 작성한다**

```markdown
# autoresearch — combo-v2 자율 탐색 규약

이 파일은 사람이 편집한다. 에이전트는 읽고 따른다.
설계 근거: `docs/superpowers/specs/2026-08-21-autoresearch-loop-design.md`

## 세션 시작 (한 번)

1. `git status` 로 미커밋 작업물을 확인하고 stash 또는 commit 한다.
2. 실험 브랜치를 만든다: `git checkout -b autoresearch/<tag>` (tag = 날짜, 예 `aug21`).
   같은 이름 브랜치가 이미 있으면 새 tag 를 쓴다.
3. `.dbcache` 를 워밍한다. `backtest-swing.mjs` 는 Supabase 쿼리 3개(956·963·967행)를 쓰고
   그 값은 **현재 스냅샷**이라, 캐시가 없으면 라운드마다 다른 유니버스를 보게 된다(방법론 §9).
   `--init` 이 첫 실행이므로 자동으로 채워지지만, 실패하면 여기서 멈추고 보고한다.
4. base 지문을 뜬다: `node autoresearch-run.mjs --init`
5. 오염 센서 생존을 증명한다: `node autoresearch-run.mjs --probe`
   발화하지 않으면 **루프를 시작하지 않는다.** 게이트가 죽은 상태다.
6. `rejected-axes.tsv` 를 읽는다.

## 매 라운드 (기본 6회)

1. `git log --oneline -3` 으로 현재 위치를 확인한다.
2. `rejected-axes.tsv` 와 `autoresearch-log.tsv` 를 읽고 **아직 시도하지 않은** 변경 하나를 정한다.
   기각축과 겹치면 다른 것을 고른다. 겹침 판정은 `--verify` 가 나중에 기계로 다시 본다.
3. `backtest-swing.mjs` 를 수정한다.
   - **공유 분기 규칙**: `k === 'combo' || k === 'combo-v2'` 블록을 고칠 때는 반드시
     `cfg.v2` 또는 `k === 'combo-v2'` 로 가드한다. 가드가 없으면 `combo` 가 같이 바뀌어
     교차오염으로 판정된다.
   - **플래그 규칙**: 새 플래그를 넣으면 `--live-parity` 경로에 배선한다.
     non-live-parity 분기에만 넣으면 죽은 코드가 된다(전례: `backtest-swing.mjs:1551`).
4. `git add -A && git commit -m "exp: <설명>"`
5. 게이트를 돌린다: `node autoresearch-run.mjs --gate`
   출력은 짧다. 백테스트 stdout 을 직접 읽지 않는다(컨텍스트 범람).
6. 게이트 결과에 따라 분기한다.
   - `not-wired` → **discard 가 아니다.** 로그에 `not-wired` 로 적고 `git reset --hard HEAD~1`.
     **기각축 표에 절대 병합하지 않는다.** 시도조차 못 한 축이다.
   - `contaminated` → 로그에 `contaminated`, `git reset --hard HEAD~1`.
     `changedGate` 에 뜬 전략을 보고 가드 누락 지점을 고친 뒤 재시도할 수 있다.
   - `crash` → 로그에 `crash`. 오타·import 누락처럼 단순하면 고쳐 재시도, 아이디어 자체가
     깨진 것이면 넘어간다.
   - `missing` → 게이트 전략 중 일부가 덤프에 없다. 판정하지 않는다.
     `--strategies` 가 prepend 됐는지, 전략 이름을 오타 없이 썼는지 확인하고 고친 뒤 재실행한다.
     끝내 안 되면 **멈추고 보고한다** — 게이트 없이 라운드를 진행하지 않는다.
   - `ok` → 7번으로 간다.
7. MC 판정을 한다. **이 단계는 자동화되어 있지 않다** — 기존 `mc-*.mjs` 절차를 쓴다.
   - 6시드로 스크린한다. 개선 방향이 아니면 `discard`.
   - 스크린 통과 시 30시드로 확정한다. `n == 30` 인지 확인한다(죽은 시드가 있으면 판정 불가).
   - IS `20230102~20241231` / OOS `20250102~20260724` 양쪽을 본다. 한쪽만이면 `discard`.
   - ΔCalmar 가 `autoresearch-floor.json` 의 바닥을 넘는지 본다. 바닥이 `null` 이면
     **`keep` 을 낼 수 없다.** `discard` 하거나 바닥을 먼저 측정한다.
   - MC 실행 중 다른 무거운 작업을 겹치지 않는다(방법론 §1-F).
8. `autoresearch-log.tsv` 에 한 줄 추가한다. 열은 아래와 같다.
   `commit  axis_id  delta_calmar  median_final  noise_floor_pass  is_oos_agree  seeds_n  status  description`
9. `keep` 이면 브랜치를 그대로 두고 다음 라운드로. 그 외는 `git reset --hard HEAD~1`.

## 세션 종료

1. `node autoresearch-run.mjs --verify`
   `FAIL` 이면 무엇이 깨졌는지 보고한다. **통과하지 못한 세션의 결과는 보고하지 않는다.**
2. 사람에게 요약을 보고한다. 라운드별 status 와 `keep` 후보를 적는다.
3. **여기서 멈춘다.** 아래는 전부 사람의 일이다.
   - `rejected-axes.tsv` 에 새 기각축 추가
   - `validation-registry.mjs` 에 `keep` 후보 등록
   - `main` 병합·실계좌 반영

## 하지 않는 것

- `main` 을 건드리지 않는다. 자동 merge 하지 않는다.
- `prepare.py` 격의 고정 자산을 고치지 않는다: `research-metrics.mjs`,
  `research-backtest-output.mjs`, `strategy-contract.mjs`, `live-parity.mjs`.
  평가·계약 쪽을 고치면 지표 자체가 움직여 비교가 성립하지 않는다.
- `validation-registry.mjs` 를 자동 수정하지 않는다.
- 새 의존성을 추가하지 않는다.
- 발견을 만들려고 무리하지 않는다. 이 영역 튜닝 전적은 3승 46패이고
  6회 루프의 기대 발견 수는 1건 미만이다. **0건은 실패가 아니다.**
- 사람이 멈추기 전에 스스로 라운드 수를 늘리지 않는다(원본의 NEVER STOP 은 채택하지 않았다).
```

- [ ] **Step 2: 커밋한다**

```bash
git add autoresearch.md
git commit -m "docs: autoresearch 루프 규약 (program.md 대응)"
```

---

## Task 7: 실행 스모크 테스트

순수 로직은 단위 테스트로 덮였다. 실제 백테스트 연결이 되는지는 한 번 돌려봐야 안다. **`node --test`로는 잡히지 않는 부분이다.**

**Files:** 없음 (검증만)

> ### ⚠️ 착수 전 필독 — 작업물 소실 위험
>
> **2026-08-21 확인: `main` 의 `backtest-swing.mjs` 에 미커밋 변경 149줄이 있다**(2026-07-30~08-08 작업 — 캔들 소스 기본값 정제본 전환, 신선도 경고, 랭킹 계측). 이 태스크는 그 파일을 고치고 되돌리므로 **`git checkout -- backtest-swing.mjs` 를 그냥 실행하면 그 149줄이 소실된다.**
>
> 또한 `--init` 은 `backtest-swing.mjs` 가 dirty 면 거부한다(의도된 가드). 따라서 스모크 전에 워킹트리를 정리해야 한다.
>
> **착수 전 사람의 결정이 필요하다.** 아래 둘 중 하나를 사용자에게 확인하고 진행한다.
> - **(A) 커밋한다** — 변경이 문서화·완결돼 있으면 `main` 에 커밋한 뒤 스모크. 가장 안전하다.
> - **(B) stash 한다** — `git stash push -u -- backtest-swing.mjs` 로 치우고, **Step 9 에서 반드시 `git stash pop`** 한다.
>
> 확인 없이 이 태스크를 시작하지 않는다.

- [ ] **Step 1: 워킹트리를 정리하고 실험 브랜치를 만든다**

```bash
git status --porcelain -- backtest-swing.mjs
# 위 결과가 비어 있지 않으면 위 박스의 (A) 또는 (B) 를 먼저 수행한다.
git checkout -b autoresearch/smoke
git status --porcelain -- backtest-swing.mjs
```
Expected: 두 번째 `git status` 가 **무출력**(clean). 브랜치 `autoresearch/smoke` 생성.

- [ ] **Step 2: base 지문을 뜬다**

Run: `node autoresearch-run.mjs --init`
Expected: 5개 전략(`combo-v2`·`combo`·`rsi2`·`hi120`·`gapfollow`)의 `trades/final/maxDD` 가 출력되고 `autoresearch-base.json` 생성.

소요시간은 **수십 초~수 분**이다(`--to 20260724` 로 구간이 늘고 5전략을 동시에 돌린다). `--gate` 의 timeout 300초 안에 들어온다.

> 실패하면 `.dbcache` 가 비어 Supabase 쿼리 3개가 막힌 것일 수 있다. 방법론 §9 참조.
> `main 에서 --init 하지 않는다` 가 나오면 Step 1 의 브랜치 생성이 안 된 것이다.

- [ ] **Step 3: 프로브가 발화하는지 확인한다**

Run: `node autoresearch-run.mjs --probe`
Expected: `프로브 발화 확인 — combo 교란이 contaminated 로 잡혔다.`, exit 0

- [ ] **Step 4: 아무것도 안 바꾼 상태에서 `not-wired`가 나오는지 확인한다**

Run: `node autoresearch-run.mjs --gate`
Expected: `status=not-wired`, `targetChanged=false`, exit 1

이것이 정상이다. 코드를 안 바꿨으니 배선 미적용과 구분되지 않는다. **게이트가 살아 있다는 증거다.**

- [ ] **Step 5: 의도적 교차오염이 잡히는지 확인한다**

`backtest-swing.mjs` **92행**의 `'combo':` 항목(combo-v2 아님)에서 `stopPct: 7` 을 `stopPct: 6` 으로 바꾼다.

Run: `node autoresearch-run.mjs --gate`
Expected: `status=contaminated`, `changedGate=combo`, exit 1. `combo` 의 trades 가 움직이고 나머지 4전략은 그대로여야 한다.

- [ ] **Step 6: 변경을 되돌린다**

> ⚠️ 아래 `git checkout --` 는 이 파일의 **모든** 미커밋 변경을 버린다. Step 1 에서 워킹트리를 clean 하게 만들었을 때만 안전하다. Step 1 을 건너뛴 채 실행하면 149줄이 소실된다.

```bash
git status --porcelain -- backtest-swing.mjs   # M 이 이번 실험 수정 하나인지 확인
git checkout -- backtest-swing.mjs
node autoresearch-run.mjs --gate
```
Expected: 다시 `status=not-wired` (원상복구 확인)

- [ ] **Step 7: 대상만 바꿨을 때 `ok`가 나오는지 확인한다**

`backtest-swing.mjs` **97행** `'combo-v2'` 의 `stopPct: 15` 를 **`stopPct: 7`** 로 바꾼다.

Run: `node autoresearch-run.mjs --gate`
Expected: `status=ok`, `targetChanged=true`, `changedGate` 없음, exit 0. combo-v2 의 trades·final 이 움직여야 한다.

> **`stopPct: 16` 을 쓰지 말 것.** 실측 결과 15→16 은 이 구간에서 **지문이 완전히 동일**하다 — -15%~-16% 밴드에 걸리는 체결이 0건이라 파라미터가 무감도다. 그러면 게이트가 `not-wired` 를 내고 스모크가 계획 결함으로 실패한다. 15→7 은 combo-v2 만 움직이는 것이 실측 확인됐다.
>
> 이것 자체가 §6-A 가 경고한 함정의 실례다 — **"수치가 안 바뀌었다"는 배선 결함일 수도, 파라미터 무감도일 수도 있다.** 둘 다 `not-wired` 로 나오고, 둘 다 `discard` 로 기록하면 안 된다.
>
> `contaminated` 가 나오면 `combo` 와 공유하는 자리를 건드린 것이다. 그 자체가 게이트가 제 일을 한 증거이므로, 어느 전략이 움직였는지 기록하고 보고한다.

- [ ] **Step 8: 변경을 되돌리고 검증을 돌린다**

```bash
git status --porcelain -- backtest-swing.mjs   # M 이 이번 실험 수정 하나인지 확인
git checkout -- backtest-swing.mjs
node autoresearch-run.mjs --verify
```
Expected: `rounds=0 keeps=0 floorPinned=false` + `PASS — 4개 기준 전부 통과. 발견 0건이어도 정상이다.`

- [ ] **Step 9: 스모크 브랜치를 정리하고 stash 를 복원한다**

```bash
git checkout main
git branch -D autoresearch/smoke
rm -f autoresearch-base.json autoresearch-probe.json
```

**Step 1 에서 (B) stash 를 선택했다면 여기서 반드시 복원한다:**

```bash
git stash list
git stash pop
git status --porcelain -- backtest-swing.mjs   # M 으로 돌아왔는지 확인
git diff --stat -- backtest-swing.mjs          # 149줄이 돌아왔는지 확인
```
Expected: `149 insertions` 규모의 diff 가 복원됨. **복원을 확인하지 않고 태스크를 닫지 않는다.**

- [ ] **Step 10: 결과를 보고한다**

Step 2~8의 실제 출력을 그대로 보고한다. 통과 항목과 실패 항목을 구분해 적는다.
**돌려보지 않은 단계를 "통과"라고 쓰지 않는다.**

---

## Self-Review

**Spec coverage**

| 설계서 절 | 대응 |
|---|---|
| §3-A lib 추출·공유 | Task 1 |
| §3-B base 지문 캐시 | Task 5 `--init` |
| §3-C 판정 규율 | Task 6 규약 7번 + Task 4 `verifySession` 기계 강제(바닥 수치 대조 포함). **MC 실행 자동화는 의도적 미포함** |
| §4 교차오염 게이트 | Task 2 + Task 5 `--gate` + Task 7 Step 5 |
| §4 오염 프로브 self-test | Task 2 `perturbFingerprint` + Task 5 `--probe` |
| §5 격리 | Task 5 `--init`의 main/dirty 거부 + Task 6 세션 시작 |
| §6 루프 규약 | Task 6 |
| §6-A `not-wired` | Task 2 + Task 4 status + Task 6 6번 |
| §7 로그 | Task 4 + Task 5 Step 5 |
| §8 keep 의미 | Task 6 세션 종료·하지 않는 것 |
| §9 세션 내 실행 | Task 6 (라운드 수 고정, NEVER STOP 미채택) |
| §10 4기준 기계화 | Task 4 `verifySession` + Task 5 `--verify` |
| §10 `rejected-axes.tsv` | Task 3 |
| §11 리팩토링 안 함 | 계획에 리팩토링 태스크 없음 |

**Placeholder scan**: 통과. 모든 코드 단계에 실제 코드가 있고, TBD·"적절히 처리" 류 문구 없음. Task 6의 MC 단계는 자동화 미포함임을 명시하고 수동 절차를 지정했다(플레이스홀더가 아니라 범위 결정).

**Type consistency**
- `mcMedian(overrideArgs, {base, seeds, runBacktest, subsample})` — Task 1 정의, Task 1 Step 6에서 동일 시그니처로 호출. `mergeArgs(override, base)` 2인자 일관.
- `classifyGate(baseFp, candFp, {target, gate})` → `{status, missing, changedGate, targetChanged}` — Task 2 정의, Task 5에서 네 필드 모두 동일 이름으로 사용.
- `verifySession(logRows, {axes, floorPinned, probeFired, mainCommitBefore, mainCommitAfter, requiredSeeds})` → `{pass, failures, rounds, keeps}` — Task 4 정의, Task 5에서 동일.
- `fingerprintDump`/`perturbFingerprint`/`parseLog`/`parseAxes` — Task 2·4 정의와 Task 5 import 이름 일치.
- 로그 열 이름이 Task 4 `LOG_COLUMNS`, Task 5 Step 5 헤더, Task 6 규약 8번에서 동일.
- 상태값 `keep`/`discard`/`not-wired`/`contaminated`/`crash` 가 Task 2 게이트 출력, Task 4 `LOG_STATUSES`, Task 6 분기에서 일치. (게이트는 `ok`/`missing` 도 내지만 이는 게이트 내부 상태이고 로그 status 로는 Task 6 6번이 매핑한다.)

**검수 반영 (fable, 2026-08-21)**

계획 초안에 실행하면 문제가 되는 결함 3건이 있었고 전부 고쳤다.
1. Task 1 Step 7 이 `node -e "import('./validate-hypotheses.mjs')"` 로 배선을 확인하려 했다 — argv 가 비어 **전체 일일 검증이 돌고 운영 `validation_ledger` 를 오염**시킨다. `--hyp slots --seeds 1 --no-ledger --no-telegram` + 스냅샷 백업·복원으로 교체.
2. Task 7 Step 7 의 `stopPct 15→16` 은 실측 **지문 무변화**(파라미터 무감도) → 스모크가 계획 결함으로 `not-wired` 로 끝난다. `15→7` 로 교체.
3. `node --test tests/`(디렉토리 인자)는 이 환경에서 `Cannot find module` 로 즉사 → `npm test` 로 교체.

추가 보강 3건: `verifySession` 이 사람이 적은 `noise_floor_pass` boolean 을 믿는 대신 **바닥 수치와 직접 대조**(설계서 §10 원문 요구), Task 7 의 미커밋 149줄 소실 위험 명문화 + stash 복원 절차, `missing` 분기와 `.dbcache` 워밍을 규약에 추가.

**알려진 갭 (의도적, 문서화됨)**
1. MC 판정 자동화 미포함 — 노이즈 바닥이 미측정이라 자동화해도 `keep`이 불가능하고, 게이트 없는 MC 자동화는 오탐 생성만 빠르게 한다.
2. 오염 프로브는 지문 수준 합성 교란이다. 실제 코드 변형 프로브는 더 무겁고, 지문 프로브로도 비교 경로의 생존은 증명된다.
3. `git worktree` 기반 base 재확인 경로는 미구현. 캔들 캐시가 git 미추적이라 worktree 에 데이터가 없다. 결정론 캐시가 1차 경로이고, 의심 시 `--init` 재실행으로 대체한다.
