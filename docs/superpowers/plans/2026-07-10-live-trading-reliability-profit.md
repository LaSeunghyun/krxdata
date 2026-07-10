# live-trading reliability + profit validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 라이브 주문 중복, 시간 왜곡, 비용 반영 불일치, 수량 강제 보정 문제를 고치고, 변동성 축소 실험을 안전하게 분리한다.

**Architecture:** 주문 실행은 단일 주문 상태 저장소와 실행 락으로 멱등화하고, 시간/비용 계산은 백테스트·페이퍼·라이브가 공유하는 순수 함수로 묶는다. 기존 전략의 핵심 상수는 라이브/백테스트로 분리해 정합성을 맞추고, 새 기법은 볼라틸리티 스로틀 1개만 shadow 플래그로 둔다.

**Tech Stack:** Node.js, existing `.mjs`/`.js` trading scripts, local test runner (`npm.cmd test`, `npm.cmd run check`)

---

## File Structure

| 파일 | 책임 |
|------|------|
| `live-order-state.mjs` (신규) | `orderKey` 생성, 상태 전이, 중복 방지, 재시도 복구용 상태 저장 |
| `trading-time.mjs` (신규) | UTC 저장, KST 조회 범위, 일자 계산, 표시 포맷 유틸 |
| `execution-model.mjs` (신규) | 수수료/세금/슬리피지/체결가 계산 공통화 |
| `paper-swing.js` | 실행 락, LIVE_QUEUE_ONLY 경로, 라이브 캡, 저널/시간 처리, 주문 상태 연동 |
| `backtest-swing.mjs` | 공통 비용 모델 사용, 라이브와 같은 캡/유니버스 정렬 |
| `slot-alloc.js` | 강제 1주 보정 제거 |
| `config.js` | 라이브/백테스트 공통 상수 분리, 변동성 스로틀 기본 비활성 |
| `tests/*.test.js` | 락, 중복 주문, 시간, 비용, 수량, 전략 정합성 회귀 테스트 |

---

### Task 1: 주문 멱등성/실행 락 정리

**Files:**
- Create: `C:\claudeT\files\live-order-state.mjs`
- Modify: `C:\claudeT\files\paper-swing.js`
- Test: `C:\claudeT\files\tests\live-order-state.test.js`

- [ ] **Step 1: 실패하는 테스트 작성**

핵심 테스트:

```js
import assert from 'node:assert/strict';
import { createOrderKey, createOrderStateStore } from '../live-order-state.mjs';

test('same signal creates same orderKey', () => {
  assert.equal(
    createOrderKey({ date: '2026-07-10', side: 'BUY', code: '000660', reason: 'rsi2', slot: 0 }),
    createOrderKey({ date: '2026-07-10', side: 'BUY', code: '000660', reason: 'rsi2', slot: 0 }),
  );
});

test('store claims an order only once', async () => {
  const store = createOrderStateStore();
  assert.equal(await store.claim('k1'), true);
  assert.equal(await store.claim('k1'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/live-order-state.test.js`

Expected: fail because `live-order-state.mjs` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Implement:

```js
export function createOrderKey({ date, side, code, reason, slot }) {
  return `${date}:${side}:${code}:${reason}:${slot}`;
}

export function createOrderStateStore() {
  const claimed = new Set();
  return {
    async claim(key) {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    async markSubmitted() {},
    async markFilled() {},
    async markFailed() {},
  };
}
```

Then in `paper-swing.js`, route `LIVE_QUEUE_ONLY` and normal live execution through the same lock path before queue processing.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/live-order-state.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add live-order-state.mjs paper-swing.js tests/live-order-state.test.js
git commit -m "fix: make live order execution idempotent"
```

### Task 2: 시간 처리 UTC/KST 정리

**Files:**
- Create: `C:\claudeT\files\trading-time.mjs`
- Modify: `C:\claudeT\files\paper-swing.js`
- Test: `C:\claudeT\files\tests\trading-time.test.js`

- [ ] **Step 1: 실패하는 테스트 작성**

```js
import assert from 'node:assert/strict';
import { toKstDateKey, toUtcIso, kstDayRange } from '../trading-time.mjs';

test('toUtcIso does not shift by timezone twice', () => {
  assert.equal(toUtcIso(new Date('2026-07-10T00:00:00.000Z')), '2026-07-10T00:00:00.000Z');
});

test('kst day range uses explicit local boundaries', () => {
  const [start, end] = kstDayRange('2026-07-10');
  assert.equal(start.toISOString(), '2026-07-09T15:00:00.000Z');
  assert.equal(end.toISOString(), '2026-07-10T15:00:00.000Z');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/trading-time.test.js`

Expected: fail because the helper module does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Implement pure helpers:

```js
export function toUtcIso(date) { return new Date(date).toISOString(); }
export function kstDayRange(yyyyMmDd) {
  const start = new Date(`${yyyyMmDd}T00:00:00+09:00`);
  const end = new Date(`${yyyyMmDd}T00:00:00+09:00`);
  end.setDate(end.getDate() + 1);
  return [start, end];
}
```

Update `paper-swing.js` journal/date code to use the helper instead of manual `+9h` conversion.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/trading-time.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add trading-time.mjs paper-swing.js tests/trading-time.test.js
git commit -m "fix: normalize trading time handling"
```

### Task 3: 비용/체결 모델 공통화

**Files:**
- Create: `C:\claudeT\files\execution-model.mjs`
- Modify: `C:\claudeT\files\backtest-swing.mjs`
- Modify: `C:\claudeT\files\paper-swing.js`
- Test: `C:\claudeT\files\tests\execution-model.test.js`

- [ ] **Step 1: 실패하는 테스트 작성**

```js
import assert from 'node:assert/strict';
import { calcBuyCashImpact, calcSellCashImpact } from '../execution-model.mjs';

test('buy cash impact includes fee', () => {
  assert.equal(calcBuyCashImpact({ fill: 1000, qty: 10, feeBps: 1.5 }), 10002);
});

test('sell cash impact includes fee and tax', () => {
  assert.equal(calcSellCashImpact({ fill: 1000, qty: 10, feeBps: 1.5, taxBps: 15 }), 9984);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/execution-model.test.js`

Expected: fail because the helper module does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Implement shared math:

```js
export function calcBuyCashImpact({ fill, qty, feeBps }) {
  return Math.round(fill * qty * (1 + feeBps / 10_000));
}

export function calcSellCashImpact({ fill, qty, feeBps, taxBps }) {
  return Math.round(fill * qty * (1 - feeBps / 10_000 - taxBps / 10_000));
}
```

Then replace ad hoc cash mutations in `backtest-swing.mjs` and `paper-swing.js` with the shared functions.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/execution-model.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add execution-model.mjs backtest-swing.mjs paper-swing.js tests/execution-model.test.js
git commit -m "fix: share execution cost model"
```

### Task 4: 수량/전략 정합성

**Files:**
- Modify: `C:\claudeT\files\slot-alloc.js`
- Modify: `C:\claudeT\files\paper-swing.js`
- Modify: `C:\claudeT\files\backtest-swing.mjs`
- Modify: `C:\claudeT\files\config.js`
- Test: `C:\claudeT\files\tests\slot-alloc.test.js`
- Test: `C:\claudeT\files\tests\strategy-contract.test.js`

- [ ] **Step 1: 실패하는 테스트 작성**

Add regression checks for:

```js
test('no forced one-share buy when atr budget is zero', () => {
  // qty should stay 0 when the model cannot afford the trade safely
});

test('live combo caps stay on preset D', () => {
  // live preset must map to UP 6/4, NEUTRAL 0/8, DOWN 0/4
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/slot-alloc.test.js tests/strategy-contract.test.js`

Expected: fail on the current forced-1-share and preset mismatch behavior.

- [ ] **Step 3: Write minimal implementation**

Update `slot-alloc.js` to return `0` instead of forcing one share when the ATR/risk budget cannot support the trade.

In `config.js` and `paper-swing.js`, split live and paper caps explicitly:

```js
export const LIVE_COMBO_CAPS = { UP: { hi120: 6, rsi2: 4 }, NEUTRAL: { hi120: 0, rsi2: 8 }, DOWN: { hi120: 0, rsi2: 4 } };
export const PAPER_COMBO_CAPS = { ... };
```

In both backtest and live, keep the RSI2 universe on the validated liquidity/mcap path only.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/slot-alloc.test.js tests/strategy-contract.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add slot-alloc.js config.js backtest-swing.mjs paper-swing.js tests/slot-alloc.test.js tests/strategy-contract.test.js
git commit -m "fix: align live trading strategy contracts"
```

### Task 5: Shadow volatility throttle and final verification

**Files:**
- Modify: `C:\claudeT\files\paper-swing.js`
- Modify: `C:\claudeT\files\backtest-swing.mjs`
- Test: `C:\claudeT\files\tests\volatility-throttle.test.js`

- [ ] **Step 1: 실패하는 테스트 작성**

```js
test('volatility throttle stays off unless explicitly enabled', () => {
  // default runtime must not change current size allocation
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/volatility-throttle.test.js`

- [ ] **Step 3: Write minimal implementation**

Add an off-by-default throttle that only scales down exposure, never up, and only when the feature flag is enabled. Keep it shadow-only until verified.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/volatility-throttle.test.js`

- [ ] **Step 5: Full verification**

Run:

```bash
npm.cmd run check
npm.cmd test
```

Expected: no new failures in the existing suite, plus the new tests passing.

- [ ] **Step 6: Commit**

```bash
git add paper-swing.js backtest-swing.mjs tests/volatility-throttle.test.js
git commit -m "feat: add shadow volatility throttle"
```

## Self-Review

- Spec coverage: `paper-swing.js` 안전성, 시간, 전략 정합성, live queue path를 Task 1/2/4가 커버한다.
- Spec coverage: 비용/체결 모델 불일치는 Task 3이 커버한다.
- Spec coverage: RSI2/캡 정합성과 강제 1주 보정 제거는 Task 4가 커버한다.
- Spec coverage: 변동성 스로틀 실험은 Task 5가 커버한다.
- Placeholder scan: `TBD`/`TODO` 없음.
- Type consistency: 새 helper 이름은 `createOrderKey`, `createOrderStateStore`, `toUtcIso`, `kstDayRange`, `calcBuyCashImpact`, `calcSellCashImpact`로 통일했다.
- Scope check: live execution reliability와 profit validation에 직접 영향이 있는 부분만 남겼다.

