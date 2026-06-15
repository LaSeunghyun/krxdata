# 잔여 예산 차순위 분산 (slots2 하이브리드) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 매수 시 목표 수량/예산을 다 못 채우면 살 수 있는 만큼 사고, 잔여 예산으로 차순위 hi120 종목을 슬롯 단위로 분산 매수한다.

**Architecture:** 종목 선정·예산 배분 로직을 순수 함수(`slot-alloc.js`)로 분리해 단위 테스트한다. `evaluateLiveHoldings`(전일 close)가 우선순위 후보 리스트를 큐에 적재하고, `executeLiveQueue`(당일 morning)가 `allocateSlots`로 매수가능금액에 맞춰 슬롯(최대 SLOTS=2)을 채운다. backtest `closePhase` 신규진입(슬롯별 `floor(equity/slots)` 예산)과 동일 원리.

**Tech Stack:** Node.js ESM, `node:test`/`node:assert`, 토스 Open API(지정가), Supabase paper_state.

---

## File Structure
- **Create** `slot-alloc.js` — 순수 함수 `pickBuyCandidates`, `allocateSlots` (factors.js 패턴: export function, 부작용 없음)
- **Create** `tests/slot-alloc.test.js` — 두 순수 함수 단위 테스트
- **Modify** `paper-swing.js`
  - `evaluateLiveHoldings` (신규진입 블록): `pickBuyCandidates`로 후보 리스트를 우선순위로 큐 적재
  - `executeLiveQueue` (BUY 집행): `allocateSlots`로 매수가능금액 기반 슬롯 배분
  - `LIVE_DRY_RUN` 플래그: 실주문 없이 집행 결정만 로그

## 타입 정의 (전 태스크 공통)
- `RankedSignal = { code: string, name: string, close: number, atrMult: number, breakoutPct: number }` — momUniverse 우선순위 순, hi120 통과
- `Allocation = { code, name, qty: number, price: number }`

---

### Task 1: `pickBuyCandidates` 순수 함수

**Files:**
- Create: `slot-alloc.js`
- Test: `tests/slot-alloc.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickBuyCandidates } from '../slot-alloc.js';

const sig = (code, breakoutPct) => ({ code, name: code, close: 10000, atrMult: 1, breakoutPct });

test('pickBuyCandidates: badCodes 제외 + maxN 제한', () => {
  const ranked = [sig('A', 5), sig('B', 4), sig('C', 3), sig('D', 2)];
  const out = pickBuyCandidates(ranked, new Set(['B']), 2);
  assert.deepEqual(out.map(c => c.code), ['A', 'C']); // B 제외, 상위 2개
});

test('pickBuyCandidates: 우선순위(입력 순서) 보존', () => {
  const ranked = [sig('A', 1), sig('B', 9)];
  const out = pickBuyCandidates(ranked, new Set(), 5);
  assert.deepEqual(out.map(c => c.code), ['A', 'B']); // 입력 순서 = momUniverse 순
});

test('pickBuyCandidates: badCodes 배열도 허용, 빈 입력 안전', () => {
  assert.deepEqual(pickBuyCandidates([], ['X'], 3), []);
  assert.equal(pickBuyCandidates([sig('A', 1)], ['A'], 3).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/slot-alloc.test.js`
Expected: FAIL — `Cannot find module '../slot-alloc.js'` 또는 `pickBuyCandidates is not a function`

- [ ] **Step 3: Write minimal implementation**

```javascript
// slot-alloc.js — 순수 함수. 라이브 슬롯 배분/후보 선정. 부작용 없음(테스트 가능).

/**
 * momUniverse 우선순위 순 hi120 시그널 배열에서 badCodes 제외, 상위 maxN개 반환.
 * @param {Array} rankedSignals - [{code,name,close,atrMult,breakoutPct}] (이미 hi120 통과, 우선순위 순)
 * @param {Set|Array} badCodes - 악재 공시 제외 종목
 * @param {number} maxN - 후보 리스트 최대 길이
 */
export function pickBuyCandidates(rankedSignals, badCodes, maxN) {
  const bad = badCodes instanceof Set ? badCodes : new Set(badCodes ?? []);
  const out = [];
  for (const s of rankedSignals ?? []) {
    if (bad.has(s.code)) continue;
    out.push(s);
    if (out.length >= maxN) break;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/slot-alloc.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add slot-alloc.js tests/slot-alloc.test.js
git commit -m "feat(slot-alloc): pickBuyCandidates 순수 함수 + 테스트"
```

---

### Task 2: `allocateSlots` 순수 함수

**Files:**
- Modify: `slot-alloc.js`
- Test: `tests/slot-alloc.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/slot-alloc.test.js 에 추가
import { allocateSlots } from '../slot-alloc.js';

const cand = (code, price, atrMult = 1) => ({ code, name: code, close: price, price, atrMult, breakoutPct: 5 });

test('allocateSlots: 빈 슬롯 2개를 후보 2종목으로 분산', () => {
  // equity 46000, SLOTS 2 → 슬롯예산 23000. 각 종목 price 19000.
  const out = allocateSlots([cand('A', 19000), cand('B', 19000)], 0, 2, 46000, 46000);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(a => a.code), ['A', 'B']);
  assert.equal(out[0].qty, 1); // floor(min(23000, 46000)/(19000*1.01))=1
});

test('allocateSlots: 보유 1슬롯이면 1종목만 추가 (SLOTS 상한)', () => {
  const out = allocateSlots([cand('A', 19000), cand('B', 19000)], 1, 2, 46000, 46000);
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'A');
});

test('allocateSlots: 매수가능금액 부족하면 살 수 있는 만큼, 다음 후보로', () => {
  // cash 25000만 → A 1주(19190) 사면 잔여 ~5800 → B 1주 못 삼 → A만
  const out = allocateSlots([cand('A', 19000), cand('B', 19000)], 0, 2, 46000, 25000);
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'A');
});

test('allocateSlots: 1주도 못 사면 스킵(현금 보유), 빈 배열', () => {
  const out = allocateSlots([cand('A', 30000)], 0, 2, 46000, 10000);
  assert.deepEqual(out, []);
});

test('allocateSlots: atrMult가 슬롯예산에 곱해짐 (backtest 정합)', () => {
  // 슬롯예산 23000 × atrMult 0.5 = 11500 → price 10000 → floor(11500/10100)=1
  const out = allocateSlots([cand('A', 10000, 0.5)], 0, 2, 46000, 46000);
  assert.equal(out[0].qty, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/slot-alloc.test.js`
Expected: FAIL — `allocateSlots is not a function`

- [ ] **Step 3: Write minimal implementation**

```javascript
// slot-alloc.js 에 추가

/**
 * 후보 리스트를 슬롯 예산(floor(equity/slots)) 단위로 배분. 총 보유 slots개 상한.
 * 각 종목 살 수 있는 만큼(슬롯예산×atrMult & cashAvailable 클램프). 못 사면 다음 후보.
 * backtest closePhase 신규진입(슬롯별 floor(equity/slots), atrMult 곱)과 동일 원리.
 * @returns {Array<{code,name,qty,price}>}
 */
export function allocateSlots(candidates, heldSlots, slots, equity, cashAvailable) {
  const slotBudget = Math.floor(equity / slots);
  const out = [];
  let cash = cashAvailable;
  let held = heldSlots;
  for (const c of candidates ?? []) {
    if (held >= slots) break;
    const budget = Math.min(slotBudget * (c.atrMult ?? 1), cash);
    const qty = Math.floor(budget / (c.price * 1.01));
    if (qty < 1) continue; // 이 종목 1주도 못 삼 → 다음 후보 (현금 보존)
    out.push({ code: c.code, name: c.name, qty, price: c.price });
    cash -= qty * c.price * 1.01;
    held++;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/slot-alloc.test.js`
Expected: PASS (8 tests 누적)

- [ ] **Step 5: Commit**

```bash
git add slot-alloc.js tests/slot-alloc.test.js
git commit -m "feat(slot-alloc): allocateSlots 슬롯 예산 배분 + 테스트"
```

---

### Task 3: `evaluateLiveHoldings` — 후보 리스트 우선순위 적재

**Files:**
- Modify: `paper-swing.js` (신규진입 블록, slots2 정합 부분 — 현재 `openSlots` 루프)

**배경:** 현재 신규진입 블록은 `uApplied` 순회하며 hi120 시그널 종목을 빈 슬롯 수만큼 큐에 적재한다. 이를 `pickBuyCandidates`로 교체해 **빈 슬롯 + 여유분(최대 5개)** 을 우선순위로 적재한다. 각 BUY 항목에 `close/atrMult/breakoutPct`를 포함해 집행 시 `allocateSlots`가 쓰게 한다.

- [ ] **Step 1: import 추가 (파일 상단 dotenv import 부근)**

```javascript
import { pickBuyCandidates, allocateSlots } from './slot-alloc.js';
```

- [ ] **Step 2: 신규진입 블록 교체**

현재 `evaluateLiveHoldings`의 `if (regime === 'UP') { for (const u of uApplied) {...} }` 블록을, 후보를 모아 `pickBuyCandidates`로 거른 뒤 큐에 우선순위 적재하도록 변경:

```javascript
  const SLOTS = 2;
  const heldKeep = [...heldCodes].filter(c => !willSell.has(c)).length;
  const slotsToFill = SLOTS - heldKeep - queue.filter(q => q.side === 'BUY').length;
  if (slotsToFill > 0 && (cash > MIN_PRICE || willSell.size > 0)) {
    if (regime === 'UP') {
      // momUniverse 우선순위 순으로 hi120 시그널 수집 (여유분 포함 최대 5)
      const HEADROOM = 3;
      const ranked = [];
      for (const u of uApplied) {
        if (heldCodes.has(u.stock_code) || queuedCodes.has(u.stock_code)) continue;
        const sig = await hi120SignalG(u.stock_code);
        if (sig && sig.breakoutPct >= cfg.minBreakout) {
          const am = liveAtrMult(await bars(u.stock_code));
          ranked.push({ code: u.stock_code, name: u.corp_name, close: sig.close, atrMult: am, breakoutPct: sig.breakoutPct });
        }
        if (ranked.length >= slotsToFill + HEADROOM) break;
      }
      const candidates = pickBuyCandidates(ranked, badCodes, slotsToFill + HEADROOM);
      for (const c of candidates) {
        queue.push({ side: 'BUY', code: c.code, name: c.name, close: c.close, atrMult: c.atrMult,
          reason: `combo hi120 돌파 +${c.breakoutPct.toFixed(1)}%`,
          ctx: { sub: 'hi120', regime, breakoutPct: c.breakoutPct.toFixed(1), atrMult: c.atrMult.toFixed(2) } });
        log(`LIVE 매수 후보 적재: ${c.name} (돌파 +${c.breakoutPct.toFixed(1)}%, ATR×${c.atrMult.toFixed(2)})`);
      }
    } else {
      log(`LIVE 신규 진입 보류 — 레짐 ${regime} (caps D: UP에서만 진입)`);
    }
  }
```

- [ ] **Step 3: 구문 검사**

Run: `node --check paper-swing.js`
Expected: 출력 없음 (통과)

- [ ] **Step 4: Commit**

```bash
git add paper-swing.js
git commit -m "feat(live): evaluateLiveHoldings 후보 리스트 우선순위 적재 (pickBuyCandidates)"
```

---

### Task 4: `executeLiveQueue` — `allocateSlots`로 슬롯 배분 집행

**Files:**
- Modify: `paper-swing.js` (`executeLiveQueue` BUY 집행 루프)

**배경:** 현재는 큐 BUY를 순서대로 1건씩 집행하며 `qty=min(o.qty, floor(cash/(px*1.01)))` 클램프만 한다. 이를 **집행 시작 시 보유 슬롯 수 파악 → BUY 후보 전체를 `allocateSlots`로 배분 → 배분된 (code, qty)만 집행**하도록 바꾼다. SELL은 기존대로 먼저 집행.

- [ ] **Step 1: SELL 먼저 집행 후, BUY는 allocateSlots 배분으로 교체**

`executeLiveQueue` 내 큐 순회 로직에서 BUY 처리를 다음으로 대체 (SELL은 기존 유지):

```javascript
  // SELL 먼저 집행 (기존 루프 유지) → 매도대금 반영
  // BUY는 매도 집행 후 매수가능금액·현재가로 allocateSlots 재배분
  const buyOrders = queue.filter(o => o.side === 'BUY');
  if (buyOrders.length && executed < LIVE_MAX_ORDERS_PER_DAY) {
    const SLOTS = 2;
    const heldNow = (await getHoldings(seq).catch(() => null))?.items?.filter(i => i.marketCountry === 'KR').length ?? 0;
    const eqNow = Number((await getHoldings(seq).catch(() => null))?.marketValue?.amount?.krw ?? 0)
      + Number((await getBuyingPower(seq, { currency: 'KRW' }).catch(() => null))?.cashBuyingPower ?? 0);
    const cashNow = Number((await getBuyingPower(seq, { currency: 'KRW' }).catch(() => null))?.cashBuyingPower ?? 0);
    // 현재가로 후보 갱신
    const priced = [];
    for (const o of buyOrders) {
      const px = (await getPricesMap([o.code])).get(o.code)?.price ?? o.close ?? 0;
      if (px > 0) priced.push({ code: o.code, name: o.name, price: px, atrMult: o.atrMult ?? 1, ctx: o.ctx });
    }
    const allocations = allocateSlots(priced, heldNow, SLOTS, eqNow, cashNow);
    for (const a of allocations) {
      if (executed >= LIVE_MAX_ORDERS_PER_DAY) break;
      if (a.price * a.qty > LIVE_MAX_ORDER_VALUE) { log(`LIVE 주문가치 상한 초과 — ${a.name} 스킵`); continue; }
      const ctx = priced.find(p => p.code === a.code)?.ctx;
      if (process.env.LIVE_DRY_RUN === '1') { log(`[DRY] BUY ${a.name} ${a.qty}주 @${a.price} 지정가`); executed++; continue; }
      const order = await createOrder(seq, { symbol: a.code, side: 'BUY', orderType: 'LIMIT', price: String(a.price), quantity: String(a.qty) });
      const fill = await waitLiveFill(seq, order.orderId);
      executed++;
      if (!fill) { log(`LIVE 매수 ${a.name} 미체결 — 보류`); remaining.push(buyOrders.find(o => o.code === a.code)); continue; }
      const fp = Number(fill.filledPrice ?? fill.price ?? a.price);
      recordTrade({ ts: kst().toISOString(), strat: 'live', type: 'buy', code: a.code, name: a.name, qty: a.qty, price: fp, reason: '차순위 분산 매수', ctx });
      meta[a.code] = { sub: ctx?.sub ?? 'hi120', name: a.name, entry: fp, entryDay: kstDate(), hi: fp, holdDays: 0, ctx };
      log(`💰 LIVE 매수 ${a.name} ${a.qty}주 @${fp.toLocaleString()} (지정가)`);
      await notifyTelegram(`💰 [실주문 체결] 매수 ${a.name} ${a.qty}주 @${fp.toLocaleString()}원 (차순위 분산)`);
    }
  }
```

(주의: 기존 BUY 처리 코드는 제거하고 위 블록으로 대체. SELL 처리 루프와 `saveStateKey('live_queue', remaining)`·`saveStateKey('live_meta', meta)`는 유지.)

- [ ] **Step 2: 구문 검사**

Run: `node --check paper-swing.js`
Expected: 통과

- [ ] **Step 3: Commit**

```bash
git add paper-swing.js
git commit -m "feat(live): executeLiveQueue allocateSlots 슬롯 배분 집행 + LIVE_DRY_RUN"
```

---

### Task 5: dry-run 통합 검증

**Files:**
- 실행만 (코드 변경 없음)

- [ ] **Step 1: 전체 단위 테스트 통과 확인**

Run: `node --test tests/slot-alloc.test.js`
Expected: PASS (8 tests)

- [ ] **Step 2: dry-run으로 집행 결정 검증 (실주문 없음)**

Run: `LIVE_DRY_RUN=1 LIVE_QUEUE_ONLY=1 node paper-swing.js`
Expected: `[DRY] BUY ...` 로그만 출력, 실제 주문/체결 없음. live_queue 미변경 확인.

- [ ] **Step 3: 회귀 — 단일 종목 큐 동작 확인**

큐에 BUY 1건만 있을 때 dry-run: 1종목만 배분되는지(`allocateSlots`가 heldNow/SLOTS 상한 준수) 로그 확인.

- [ ] **Step 4: 최종 commit + push**

```bash
git add -A docs/superpowers/
git commit -m "docs: 잔여예산 차순위 분산 plan"
git push origin main
```

---

## Self-Review
- **Spec 커버리지:** 하이브리드 발동(Task 3 큐 적재 + Task 4 집행 배분) ✅ / 후보리스트 동봉(Task 3 close/atrMult 큐 적재) ✅ / 슬롯예산·SLOTS 상한(Task 2 allocateSlots) ✅ / UP+badCodes 필터(Task 3 regime 체크 + pickBuyCandidates) ✅ / backtest 정합(Task 2 atrMult×슬롯예산) ✅ / 미체결·에러(Task 4 remaining 보류) ✅ / dry-run 테스트(Task 5) ✅
- **Placeholder:** 없음 — 모든 step에 실제 코드/명령/기대출력.
- **타입 일관성:** `RankedSignal`/`candidate`가 `{code,name,close,atrMult,breakoutPct}`로 Task 1·3 일치. `allocateSlots`는 `price` 필드 사용 — Task 4에서 `priced` 배열이 `price` 제공(현재가), Task 2 테스트도 `price`. `Allocation = {code,name,qty,price}` Task 2·4 일치.
