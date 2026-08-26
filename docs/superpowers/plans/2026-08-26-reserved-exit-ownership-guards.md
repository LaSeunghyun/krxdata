# 예약청산 소유권 가드 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 봇이 직접 사지 않은 포지션을 봇이 자동으로 팔 수 없게 하고, 예약청산이 예약 시점 수량을 넘지 못하게 하며, AI 청산권고를 사람 승인 아래 둔다.

**Architecture:** 판정 로직을 순수 모듈 4개(`position-ownership` / `exit-qty` / `tg-requests` / `bot-exclude` 확장)로 뽑아 진짜 단위테스트를 붙이고, `stock-live.mjs` 는 호출만 한다. `stock-live.mjs` 는 top-level await + 무한루프라 import 가 불가능하므로(두 번째 트레이더가 뜬다) 배선 자체는 소스 대조 테스트 + `--plan` 드라이런으로 검증한다. 프로세스 간 통신은 **파일마다 writer 1개** 원칙으로 락 없이 처리한다.

**Tech Stack:** Node 22 ESM, `node:test` + `node:assert/strict`, systemd(Oracle VM), 토스 오픈API

**Spec:** `docs/superpowers/specs/2026-08-26-reserved-exit-ownership-guards-design.md`

**Branch:** `fix/reserved-exit-ownership-guards` (repo `C:\claudeT\files`)

---

## 사전 조건

- `stock-live.service` 는 **inactive** 다(2026-08-26 09:54 정지). 이 계획이 전부 끝나고 Task 12 의 검증을 통과할 때까지 재기동하지 않는다.
- `.bot-exclude.json` 은 VM 에서 `["000270","009150","486990","052690"]` 이다. 로컬에는 이 파일이 없다(정상 - `.gitignore` 대상).

## 파일 구조

| 파일 | 상태 | 책임 |
|---|---|---|
| `position-ownership.mjs` | 신규 | 저널 대조로 포지션 소유권 판정. 순수함수만 |
| `exit-qty.mjs` | 신규 | 예약청산 매도수량 산정(상한·해제 판정). 순수함수만 |
| `tg-requests.mjs` | 신규 | telegram-agent → stock-live 단방향 요청 채널(append/read + 커서) |
| `bot-exclude.mjs` | 수정 | 수동/자동 격리 파일 분리. writer 를 파일별로 고정 |
| `strategy-contract.mjs` | 수정 | `AI_TRADER.sellRequiresApproval` 추가 |
| `ai-trader.mjs` | 수정 | `sellOk` 를 `rotOk` 와 대칭으로 |
| `stock-live.mjs` | 수정 | 위 모듈 배선 + 제안 등록 + 요청 소비 |
| `telegram-agent.mjs` | 수정 | `청산승인` 파서 · `격리해제` 를 요청 채널로 |
| `diag-ownership.mjs` | 신규 | 읽기전용 분류 미리보기(배포 전 검증용). 아무것도 쓰지 않는다 |
| `tests/position-ownership.test.mjs` | 신규 | Task 1 |
| `tests/bot-exclude.test.mjs` | 신규 | Task 2 |
| `tests/tg-requests.test.mjs` | 신규 | Task 3 |
| `tests/exit-qty.test.mjs` | 신규 | Task 4 |
| `tests/live-guards-source.test.js` | 신규 | Task 11 (배선 소스 대조 = not-wired 검출) |
| `ai-trader-bounds.test.mjs` | 수정 | Task 5 |
| `tests/strategy-contract.test.js` | 수정 | Task 6 |

---

## Task 1: `position-ownership.mjs` - 소유권 판정 순수모듈

**Files:**
- Create: `position-ownership.mjs`
- Test: `tests/position-ownership.test.mjs`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/position-ownership.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { botHeldQty, classifyPosition } from '../position-ownership.mjs';

// 2026-08-26 사고 당시 실제 저널에서 뽑은 픽스처.
// 봇은 한화오션만 샀고 295310·052690 은 사용자가 토스 앱에서 직접 샀다(저널 BUY 0건, 실측).
const TRADES = [
  { ts: '2026-08-07 08:12:25', code: '042660', name: '한화오션', side: 'BUY',  qty: 34, px: 91100, sub: 'rsi2' },
  { ts: '2026-08-03 09:14:33', code: '029780', name: '삼성카드', side: 'BUY',  qty: 64, px: 46634, sub: 'rsi2' },
  { ts: '2026-08-07 08:02:43', code: '029780', name: '삼성카드', side: 'SELL', qty: 64, px: 47000 },
];

test('botHeldQty 는 BUY 합에서 SELL 합을 뺀다', () => {
  assert.equal(botHeldQty(TRADES, '042660'), 34);
  assert.equal(botHeldQty(TRADES, '029780'), 0);   // 전량 매도됨
  assert.equal(botHeldQty(TRADES, '295310'), 0);   // 봇이 산 적 없음
});

test('사용자가 직접 산 종목은 user 로 판정한다 (295310 실측)', () => {
  const r = classifyPosition({ code: '295310', brokerQty: 326, currentPx: 48300, meta: {}, trades: TRADES });
  assert.equal(r.kind, 'user');
});

test('사용자가 직접 산 종목은 user 로 판정한다 (052690 실측)', () => {
  const r = classifyPosition({ code: '052690', brokerQty: 25, currentPx: 130900, meta: {}, trades: TRADES });
  assert.equal(r.kind, 'user');
});

test('봇이 산 종목은 bot 으로 판정하고 meta 를 복원한다 (한화오션 실측)', () => {
  const r = classifyPosition({ code: '042660', brokerQty: 34, currentPx: 95000, meta: {}, trades: TRADES });
  assert.equal(r.kind, 'bot');
  assert.equal(r.restoreMeta.sub, 'rsi2');
  assert.equal(r.restoreMeta.entry, 91100);
  assert.equal(r.restoreMeta.boughtAt, '2026-08-07 08:12:25');
});

test('복원 meta 의 hi 는 진입가와 현재가 중 큰 값이다 (트레일이 늦게 걸리는 안전측)', () => {
  const up = classifyPosition({ code: '042660', brokerQty: 34, currentPx: 95000, meta: {}, trades: TRADES });
  assert.equal(up.restoreMeta.hi, 95000);
  const down = classifyPosition({ code: '042660', brokerQty: 34, currentPx: 80000, meta: {}, trades: TRADES });
  assert.equal(down.restoreMeta.hi, 91100);
  assert.ok(down.restoreMeta.hi >= down.restoreMeta.entry);
});

test('meta.sub 가 있으면 저널을 보지 않고 bot 으로 통과시킨다', () => {
  const r = classifyPosition({ code: '295310', brokerQty: 326, currentPx: 48300, meta: { sub: 'rsi2' }, trades: TRADES });
  assert.equal(r.kind, 'bot');
  assert.equal(r.restoreMeta, undefined);
});

test('사용자가 봇 보유분에 추가매수하면 user 로 떨어진다', () => {
  const r = classifyPosition({ code: '042660', brokerQty: 50, currentPx: 95000, meta: {}, trades: TRADES });
  assert.equal(r.kind, 'user');   // botQty 34 < brokerQty 50
});

test('저널을 읽을 수 없으면 unknown 이다 (판정 보류 — 격리로 실패하지 않는다)', () => {
  assert.equal(classifyPosition({ code: '042660', brokerQty: 34, currentPx: 1, meta: {}, trades: null }).kind, 'unknown');
  assert.equal(classifyPosition({ code: '042660', brokerQty: 34, currentPx: 1, meta: {}, trades: undefined }).kind, 'unknown');
});

test('저널이 비어 있는 것과 읽을 수 없는 것은 다르다', () => {
  assert.equal(classifyPosition({ code: '042660', brokerQty: 34, currentPx: 1, meta: {}, trades: [] }).kind, 'user');
});

test('SELL 이 BUY 보다 많은 이상 데이터는 user 로 떨어진다 (안전측)', () => {
  const bad = [{ code: 'X', side: 'SELL', qty: 10, px: 1, ts: 't' }];
  assert.equal(botHeldQty(bad, 'X'), -10);
  assert.equal(classifyPosition({ code: 'X', brokerQty: 5, currentPx: 1, meta: {}, trades: bad }).kind, 'user');
});

test('저널 BUY 에 sub 가 없으면 복원 불가라 user 로 떨어진다', () => {
  const noSub = [{ code: 'Y', side: 'BUY', qty: 10, px: 1000, ts: 't' }];
  assert.equal(classifyPosition({ code: 'Y', brokerQty: 10, currentPx: 1100, meta: {}, trades: noSub }).kind, 'user');
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd C:/claudeT/files && node --test tests/position-ownership.test.mjs`
Expected: FAIL - `Cannot find module '.../position-ownership.mjs'`

- [ ] **Step 3: 최소 구현**

`position-ownership.mjs`:

```js
/**
 * position-ownership.mjs — 보유 포지션의 소유권 판정 (봇이 산 것인가, 사용자가 산 것인가).
 *
 * 배경(2026-08-26): 사용자가 토스 앱에서 직접 산 에이치브이엠(295310)이 AI 청산예약으로
 *   3회 강제청산됐다. `sub 미상` 은 두 가지를 동시에 뜻한다 —
 *     ① 사용자가 산 것  ② 봇이 샀는데 meta 를 잃은 것(크래시·부분체결·meta purge)
 *   ②를 격리하면 검증된 -15% 손절이 조용히 사라진다. 그래서 저널(BUY 레코드에 `sub` 포함,
 *   원자쓰기+.bak 이라 state 보다 견고)을 독립 오라클로 써서 둘을 가른다.
 *
 * 이 모듈에 순수함수만 두는 이유: stock-live.mjs 는 top-level await·무한루프가 있어 import 가
 *   불가능하다(두 번째 트레이더가 뜬다). 인라인이면 소스 정규식 대조밖에 못 하는데, 이번 결함이
 *   정확히 "소스에는 있는데 실행 경로가 아니었다" 유형이다.
 */

/**
 * 저널 기준 봇 보유수량 = BUY qty 합 − SELL qty 합.
 * 음수(SELL > BUY)는 클램프하지 않는다 — 데이터 이상이므로 호출부가 user 로 떨어뜨리게 둔다.
 */
export function botHeldQty(trades, code) {
  let q = 0;
  for (const t of trades) {
    if (String(t?.code) !== String(code)) continue;
    const n = Number(t?.qty);
    if (!Number.isFinite(n)) continue;
    if (t.side === 'BUY') q += n;
    else if (t.side === 'SELL') q -= n;
  }
  return q;
}

/** 저널에서 이 종목의 마지막 BUY 레코드 (복원 meta 의 원천). */
function lastBuy(trades, code) {
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (String(t?.code) === String(code) && t.side === 'BUY') return t;
  }
  return null;
}

/**
 * @returns {{kind:'bot'|'user'|'unknown', why:string, restoreMeta?:object}}
 *   'unknown' = 저널을 읽을 수 없어 판정 보류. 호출부는 아무 조치도 하지 않는다.
 */
export function classifyPosition({ code, brokerQty, currentPx, meta, trades }) {
  if (meta?.sub) return { kind: 'bot', why: `meta.sub=${meta.sub} — 이미 봇이 관리 중` };
  if (!Array.isArray(trades)) return { kind: 'unknown', why: '저널을 읽을 수 없다 — 판정 보류' };

  const bq = botHeldQty(trades, code);
  const bk = Number(brokerQty);
  if (bq > 0 && Number.isFinite(bk) && bq >= bk) {
    const lb = lastBuy(trades, code);
    if (lb?.sub) {
      const px = Number(currentPx) > 0 ? Number(currentPx) : 0;
      const entry = Number(lb.px) > 0 ? Number(lb.px) : px;
      return {
        kind: 'bot',
        why: `저널 봇잔량 ${bq} >= 보유 ${bk} — meta 복원`,
        // hi 를 진입가 이상으로만 잡는다: 진입 후 실제 고점을 모른다. 낮게 잡으면 트레일이
        //   늦게 걸린다 = 덜 파는 쪽 = 안전측.
        restoreMeta: { sub: lb.sub, boughtAt: lb.ts, entry, hi: Math.max(entry, px) },
      };
    }
    return { kind: 'user', why: '저널 BUY 에 sub 가 없어 복원할 전략이 없다' };
  }
  return {
    kind: 'user',
    why: bq <= 0 ? '저널에 봇 매수 기록이 없다' : `저널 봇잔량 ${bq} < 보유 ${bk} — 사용자 추가매수`,
  };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd C:/claudeT/files && node --test tests/position-ownership.test.mjs`
Expected: PASS - `# pass 11` / `# fail 0`

- [ ] **Step 5: 커밋**

```bash
cd C:/claudeT/files
git add position-ownership.mjs tests/position-ownership.test.mjs
git commit -m "feat: 포지션 소유권 판정 모듈 - 저널 대조로 봇 매수분과 사용자 매수분을 가른다"
```

---

## Task 2: `bot-exclude.mjs` - 수동/자동 격리 파일 분리

**Files:**
- Modify: `bot-exclude.mjs` (전면 교체)
- Test: `tests/bot-exclude.test.mjs`

**왜:** Task 7 에서 stock-live 가 격리 파일을 쓰기 시작한다. 지금 writer 는 tg-order 하나뿐이고 `addBotExclude` 는 **락 없는 read-modify-write** 라 두 프로세스가 동시에 쓰면 갱신이 유실된다. 파일을 나눠 writer 를 하나씩 고정하면 락이 아예 필요 없다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/bot-exclude.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readBotExclude, readBotExcludeManual, readBotExcludeAuto,
  addBotExclude, removeBotExclude, addBotExcludeAuto, removeBotExcludeAuto,
} from '../bot-exclude.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'botexcl-'));

test('두 파일의 합집합을 읽는다', () => {
  const d = tmp();
  writeFileSync(join(d, '.bot-exclude.json'), JSON.stringify(['000270']));
  writeFileSync(join(d, '.bot-exclude-auto.json'), JSON.stringify(['052690']));
  assert.deepEqual([...readBotExclude(d)].sort(), ['000270', '052690']);
});

test('파일이 없어도 빈 집합을 준다', () => {
  assert.equal(readBotExclude(tmp()).size, 0);
});

test('addBotExclude 는 수동 파일에만 쓴다', () => {
  const d = tmp();
  addBotExclude('000270', d);
  assert.deepEqual([...readBotExcludeManual(d)], ['000270']);
  assert.equal(readBotExcludeAuto(d).size, 0);
  assert.equal(existsSync(join(d, '.bot-exclude-auto.json')), false);
});

test('addBotExcludeAuto 는 자동 파일에만 쓴다', () => {
  const d = tmp();
  addBotExcludeAuto('052690', d);
  assert.deepEqual([...readBotExcludeAuto(d)], ['052690']);
  assert.equal(readBotExcludeManual(d).size, 0);
});

test('removeBotExclude 는 자동 파일을 건드리지 않는다 (D6 — writer 1개 원칙)', () => {
  const d = tmp();
  addBotExclude('999999', d);
  addBotExcludeAuto('999999', d);
  removeBotExclude('999999', d);
  assert.equal(readBotExcludeManual(d).size, 0);
  assert.deepEqual([...readBotExcludeAuto(d)], ['999999'], '자동 파일이 남아 있어야 한다');
});

test('removeBotExcludeAuto 는 수동 파일을 건드리지 않는다', () => {
  const d = tmp();
  addBotExclude('999999', d);
  addBotExcludeAuto('999999', d);
  removeBotExcludeAuto('999999', d);
  assert.deepEqual([...readBotExcludeManual(d)], ['999999'], '수동 파일이 남아 있어야 한다');
  assert.equal(readBotExcludeAuto(d).size, 0);
});

test('손상된 JSON 은 빈 집합으로 읽되 다른 파일은 살린다', () => {
  const d = tmp();
  writeFileSync(join(d, '.bot-exclude.json'), '{{{ broken');
  writeFileSync(join(d, '.bot-exclude-auto.json'), JSON.stringify(['052690']));
  assert.deepEqual([...readBotExclude(d)], ['052690']);
});

test('addBotExcludeAuto 는 쓰기 실패를 삼키지 않는다', () => {
  // 존재하지 않는 디렉터리 = 쓰기 실패. 호출부가 경보를 낼 수 있어야 한다.
  assert.throws(() => addBotExcludeAuto('000270', join(tmpdir(), 'no-such-dir-xyz-9999')));
});

test('중복 추가는 멱등이다', () => {
  const d = tmp();
  addBotExcludeAuto('052690', d);
  addBotExcludeAuto('052690', d);
  assert.deepEqual(JSON.parse(readFileSync(join(d, '.bot-exclude-auto.json'), 'utf8')), ['052690']);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd C:/claudeT/files && node --test tests/bot-exclude.test.mjs`
Expected: FAIL - `readBotExcludeManual is not a function` 등

- [ ] **Step 3: 구현 (파일 전면 교체)**

`bot-exclude.mjs`:

```js
/**
 * bot-exclude.mjs — 격리 목록 (봇이 건드리지 않는 종목).
 *
 * 격리는 "봇이 무시" 가 아니라 **"사용자 소유" 관리 모드**다. stock-live 의 emitSellSignals 가
 *   격리된 종목만 대상으로 목표·손절 도달 알림을 보낸다(자동매도는 없다).
 *
 * ★ 2026-08-26: 파일을 둘로 나눴다. writer 를 파일별로 하나씩 고정해 락 없이 경합을 없앤다.
 *     .bot-exclude.json       ← writer: tg-order / telegram-agent (사용자가 텔레그램으로 산 것)
 *     .bot-exclude-auto.json  ← writer: stock-live (소유 판정으로 자동 격리한 것)
 *   `removeBotExclude` 를 "두 파일 모두 제거" 로 만들면 tg-order 가 자동 파일의 두 번째 writer 가
 *   되어 이 원칙이 깨진다. 그래서 제거도 파일별로 분리했다.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_DIR = dirname(fileURLToPath(import.meta.url));
const MANUAL = '.bot-exclude.json';
const AUTO = '.bot-exclude-auto.json';

const readSet = (dir, name) => {
  const p = join(dir, name);
  try { return existsSync(p) ? new Set(JSON.parse(readFileSync(p, 'utf8')).map(String)) : new Set(); }
  catch { return new Set(); }
};
const writeSet = (dir, name, s) => writeFileSync(join(dir, name), JSON.stringify([...s]));

export function readBotExclude(dir = DEFAULT_DIR) {
  return new Set([...readSet(dir, MANUAL), ...readSet(dir, AUTO)]);
}
export function readBotExcludeManual(dir = DEFAULT_DIR) { return readSet(dir, MANUAL); }
export function readBotExcludeAuto(dir = DEFAULT_DIR) { return readSet(dir, AUTO); }

// 수동 파일 (writer: tg-order / telegram-agent). 기존 동작 유지 — 쓰기 실패는 best-effort.
export function addBotExclude(code, dir = DEFAULT_DIR) {
  const s = readSet(dir, MANUAL); s.add(String(code));
  try { writeSet(dir, MANUAL, s); } catch { /* best-effort */ }
  return s;
}
export function removeBotExclude(code, dir = DEFAULT_DIR) {
  const s = readSet(dir, MANUAL); s.delete(String(code));
  try { writeSet(dir, MANUAL, s); } catch { /* best-effort */ }
  return s;
}

// 자동 파일 (writer: stock-live). **쓰기 실패를 삼키지 않는다** — 격리 실패는 호출부가 경보해야 한다.
export function addBotExcludeAuto(code, dir = DEFAULT_DIR) {
  const s = readSet(dir, AUTO); s.add(String(code));
  writeSet(dir, AUTO, s);
  return s;
}
export function removeBotExcludeAuto(code, dir = DEFAULT_DIR) {
  const s = readSet(dir, AUTO); s.delete(String(code));
  writeSet(dir, AUTO, s);
  return s;
}
```

- [ ] **Step 4: 통과 확인 + 기존 호출부가 안 깨지는지 확인**

Run: `cd C:/claudeT/files && node --test tests/bot-exclude.test.mjs`
Expected: PASS - `# pass 9` / `# fail 0`

Run: `cd C:/claudeT/files && grep -rn "from './bot-exclude.mjs'" *.mjs`
Expected: `stock-live.mjs` 와 `tg-order.mjs` 가 나온다. 둘 다 `readBotExclude()` / `addBotExclude(code)` / `removeBotExclude(code)` 를 **인자 1개로** 호출하므로 시그니처 변경(선택적 `dir`)에 영향받지 않는다. 직접 눈으로 확인한다.

- [ ] **Step 5: 커밋**

```bash
cd C:/claudeT/files
git add bot-exclude.mjs tests/bot-exclude.test.mjs
git commit -m "feat: 격리 목록을 수동/자동 파일로 분리 - 파일당 writer 1개로 락 제거"
```

---

## Task 3: `tg-requests.mjs` - 단방향 요청 채널

**Files:**
- Create: `tg-requests.mjs`
- Test: `tests/tg-requests.test.mjs`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/tg-requests.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRequest, readRequestsAfter } from '../tg-requests.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'tgreq-'));

test('파일이 없으면 요청 0건이고 커서는 그대로다', () => {
  const r = readRequestsAfter(0, tmp());
  assert.deepEqual(r.items, []);
  assert.equal(r.lines, 0);
});

test('append 한 요청을 읽고 커서가 전진한다', () => {
  const d = tmp();
  appendRequest({ type: 'ai_exit_approve', code: '042660', name: '한화오션' }, d);
  const r = readRequestsAfter(0, d);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].type, 'ai_exit_approve');
  assert.equal(r.items[0].code, '042660');
  assert.equal(r.lines, 1);
});

test('커서 이후만 읽는다 — 이미 소비한 요청을 다시 주지 않는다', () => {
  const d = tmp();
  appendRequest({ type: 'a', code: '1' }, d);
  appendRequest({ type: 'b', code: '2' }, d);
  const first = readRequestsAfter(0, d);
  assert.equal(first.items.length, 2);
  const second = readRequestsAfter(first.lines, d);
  assert.deepEqual(second.items, []);
  assert.equal(second.lines, 2);
});

test('같은 초에 들어온 두 요청이 각각 1회씩 처리된다 (ts 커서였다면 하나가 유실된다)', () => {
  const d = tmp();
  const ts = '2026-08-26 09:00:00';
  appendRequest({ type: 'ai_exit_approve', code: '1', ts }, d);
  appendRequest({ type: 'ai_exit_approve', code: '2', ts }, d);
  const r = readRequestsAfter(0, d);
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map(x => x.code), ['1', '2']);
});

test('깨진 라인 하나가 뒤 라인 처리를 막지 않는다', () => {
  const d = tmp();
  appendRequest({ type: 'a', code: '1' }, d);
  appendFileSync(join(d, '.tg-requests.jsonl'), '{{{ broken\n');
  appendRequest({ type: 'c', code: '3' }, d);
  const r = readRequestsAfter(0, d);
  assert.deepEqual(r.items.map(x => x.code), ['1', '3']);
  assert.equal(r.skipped, 1);
  assert.equal(r.lines, 3, '깨진 줄도 커서를 전진시켜야 무한 재시도가 안 생긴다');
});

test('빈 줄은 무시한다', () => {
  const d = tmp();
  writeFileSync(join(d, '.tg-requests.jsonl'), '\n\n' + JSON.stringify({ type: 'a', code: '1' }) + '\n\n');
  const r = readRequestsAfter(0, d);
  assert.equal(r.items.length, 1);
  assert.equal(r.lines, 1);
});

test('파일이 줄어들면 커서를 재동기화한다 (회전·재생성 대비)', () => {
  const d = tmp();
  writeFileSync(join(d, '.tg-requests.jsonl'), JSON.stringify({ type: 'a', code: '1' }) + '\n');
  const r = readRequestsAfter(99, d);
  assert.deepEqual(r.items, [], '과거 요청을 소급 재실행하지 않는다');
  assert.equal(r.lines, 1);
});

test('append 는 ts 를 자동으로 채운다', () => {
  const d = tmp();
  appendRequest({ type: 'a', code: '1' }, d);
  assert.ok(readRequestsAfter(0, d).items[0].ts, 'ts 가 있어야 사후 추적이 된다');
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd C:/claudeT/files && node --test tests/tg-requests.test.mjs`
Expected: FAIL - `Cannot find module '.../tg-requests.mjs'`

- [ ] **Step 3: 구현**

`tg-requests.mjs`:

```js
/**
 * tg-requests.mjs — telegram-agent → stock-live 단방향 요청 채널.
 *
 * writer 는 telegram-agent 단독(append-only), reader 는 stock-live 단독이다.
 *   파일마다 writer 가 하나이므로 락이 필요 없다.
 *
 * 커서를 타임스탬프가 아니라 **소비한 줄 수**로 두는 이유: append-only 파일에서는 줄 수가
 *   안정적인 위치 지시자이고, 같은 초에 두 요청이 들어와도 중복 처리·유실이 없다.
 *
 * 쓰는 쪽(telegram-agent)은 사용자 명령을 그대로 담고, 판정은 전부 읽는 쪽(stock-live)이 한다.
 *   승인·격리해제는 봇 상태를 바꾸는 일이라 상태 소유자가 결정해야 한다.
 */
import { existsSync, appendFileSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_DIR = dirname(fileURLToPath(import.meta.url));
const FILE = '.tg-requests.jsonl';

/** 요청 1건 append. 실패는 던진다 — 조용히 사라지면 사용자가 승인했는데 아무 일도 안 난다. */
export function appendRequest(req, dir = DEFAULT_DIR) {
  const row = { ts: new Date().toISOString(), ...req };
  appendFileSync(join(dir, FILE), JSON.stringify(row) + '\n');
  return row;
}

/**
 * @param {number} consumed  이미 소비한 줄 수
 * @returns {{items:object[], lines:number, skipped:number}}
 *   lines = 새 커서(파일의 현재 줄 수). 깨진 줄도 커서를 전진시킨다 — 안 그러면 무한 재시도가 된다.
 */
export function readRequestsAfter(consumed = 0, dir = DEFAULT_DIR) {
  const p = join(dir, FILE);
  if (!existsSync(p)) return { items: [], lines: Number(consumed) || 0, skipped: 0 };
  let all;
  try { all = readFileSync(p, 'utf8').split('\n').filter(l => l.trim() !== ''); }
  catch { return { items: [], lines: Number(consumed) || 0, skipped: 0 }; }

  const cur = Math.max(0, Number(consumed) || 0);
  // 파일이 줄어들었다(회전·재생성) → 과거 요청을 소급 실행하지 않고 커서만 맞춘다.
  if (all.length < cur) return { items: [], lines: all.length, skipped: 0 };

  const items = []; let skipped = 0;
  for (const line of all.slice(cur)) {
    try { items.push(JSON.parse(line)); } catch { skipped++; }
  }
  return { items, lines: all.length, skipped };
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd C:/claudeT/files && node --test tests/tg-requests.test.mjs`
Expected: PASS - `# pass 8` / `# fail 0`

- [ ] **Step 5: 커밋**

```bash
cd C:/claudeT/files
git add tg-requests.mjs tests/tg-requests.test.mjs
git commit -m "feat: telegram-agent 에서 stock-live 로 가는 단방향 요청 채널 (줄 수 커서)"
```

---

## Task 4: `exit-qty.mjs` - 예약청산 수량 상한

**Files:**
- Create: `exit-qty.mjs`
- Test: `tests/exit-qty.test.mjs`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/exit-qty.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { plannedSellQty } from '../exit-qty.mjs';

test('2026-08-26 사고 재현 — 재매수분이 청산되지 않는다', () => {
  // 08:00 예약 생성 시점 보유 326주 → 147주만 체결 → 예약 잔량 179
  const first = plannedSellQty({ brokerQty: 326, exitQty: 326, frac: 1 });
  assert.equal(first.sellQty, 326);

  const capAfter = 326 - 147;               // 부분체결 후 예약 잔량
  assert.equal(capAfter, 179);

  // 08:06 사용자가 143주 재매수 → 브로커 보유 322주. 예약분 179 만 팔아야 한다.
  const second = plannedSellQty({ brokerQty: 322, exitQty: capAfter, frac: 1 });
  assert.equal(second.sellQty, 179, '사고 당시엔 322주를 전부 팔았다');
  assert.equal(second.base, 179);
  assert.equal(second.release, false);
});

test('exitQty 가 없으면 현행 동작으로 폴백한다 (구 예약 호환)', () => {
  const r = plannedSellQty({ brokerQty: 100, exitQty: undefined, frac: 1 });
  assert.equal(r.sellQty, 100);
  assert.equal(r.base, 100);
});

test('브로커 보유가 예약보다 적으면 보유수량이 상한이다', () => {
  const r = plannedSellQty({ brokerQty: 40, exitQty: 100, frac: 1 });
  assert.equal(r.sellQty, 40);
});

test('부분익절(frac 0.5)은 상한 기준으로 절반을 판다', () => {
  const r = plannedSellQty({ brokerQty: 322, exitQty: 179, frac: 0.5 });
  assert.equal(r.sellQty, 89, 'floor(179*0.5) — 브로커 322 기준이 아니다');
});

test('예약이 소진된 뒤 사용자가 재매수해도 1주를 팔지 않고 예약을 해제한다', () => {
  const r = plannedSellQty({ brokerQty: 143, exitQty: 0, frac: 1 });
  assert.equal(r.sellQty, 0);
  assert.equal(r.release, true, 'Math.max(1,...) 가 1주를 파는 것을 막아야 한다');
});

test('부분익절에서도 상한 소진이면 해제한다', () => {
  const r = plannedSellQty({ brokerQty: 143, exitQty: 0, frac: 0.5 });
  assert.equal(r.release, true);
  assert.equal(r.sellQty, 0);
});

test('브로커 보유가 0이면 해제한다', () => {
  assert.equal(plannedSellQty({ brokerQty: 0, exitQty: 100, frac: 1 }).release, true);
});

test('음수·NaN 입력은 해제로 떨어진다 (안전측)', () => {
  assert.equal(plannedSellQty({ brokerQty: -5, exitQty: 10, frac: 1 }).release, true);
  assert.equal(plannedSellQty({ brokerQty: NaN, exitQty: 10, frac: 1 }).release, true);
});

test('부분익절 최소 1주는 상한이 남아 있을 때만 보장된다', () => {
  const r = plannedSellQty({ brokerQty: 100, exitQty: 1, frac: 0.5 });
  assert.equal(r.sellQty, 1, 'floor(1*0.5)=0 이지만 상한이 1 남았으므로 1주');
  assert.equal(r.release, false);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd C:/claudeT/files && node --test tests/exit-qty.test.mjs`
Expected: FAIL - `Cannot find module '.../exit-qty.mjs'`

- [ ] **Step 3: 구현**

`exit-qty.mjs`:

```js
/**
 * exit-qty.mjs — 예약청산 매도수량 산정.
 *
 * 배경(2026-08-26): 예약청산이 브로커 보유수량을 실시간으로 읽어(`qty = Number(it.quantity)`)
 *   예약 생성 후 사용자가 산 물량까지 팔았다. 08:00 에 326주 예약 중 147주가 체결됐고,
 *   사용자가 08:02~08:06 에 143주를 재매수했는데 08:06 집행이 **322주 전량**을 던졌다.
 *   예약은 만들어진 시점의 수량에 묶여야 한다.
 */

/**
 * @returns {{sellQty:number, base:number, release:boolean}}
 *   base    = 이번 집행의 상한(= min(브로커 보유, 예약 잔량)). 부분익절 판정도 이 값 기준이다.
 *   release = 팔 수 있는 예약분이 없다 → 호출부가 예약 자체를 해제해야 한다.
 */
export function plannedSellQty({ brokerQty, exitQty, frac }) {
  const bk = Number(brokerQty);
  const cap = Number.isFinite(Number(exitQty)) ? Number(exitQty) : bk;
  const base = Math.min(Number.isFinite(bk) ? bk : 0, Number.isFinite(cap) ? cap : 0);
  // ★ base<=0 분기가 없으면 아래 Math.max(1, ...) 가 **1주를 판다.** 예약이 소진됐는데
  //   사용자가 새로 사서 보유가 다시 0보다 커진 경우가 정확히 그렇다(사고의 축소판).
  if (!(base > 0)) return { sellQty: 0, base: 0, release: true };
  const f = Number(frac ?? 1);
  const sellQty = f >= 1 ? base : Math.max(1, Math.floor(base * f));
  return { sellQty, base, release: false };
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd C:/claudeT/files && node --test tests/exit-qty.test.mjs`
Expected: PASS - `# pass 9` / `# fail 0`

- [ ] **Step 5: 커밋**

```bash
cd C:/claudeT/files
git add exit-qty.mjs tests/exit-qty.test.mjs
git commit -m "feat: 예약청산 수량 상한 - 예약 시점 수량을 넘어 팔지 않는다"
```

---

## Task 5: `ai-trader.mjs` - `sellOk` 를 `rotOk` 와 대칭으로

**Files:**
- Modify: `ai-trader.mjs:303-306`
- Test: `ai-trader-bounds.test.mjs` (수정 - 이 파일은 `node:test` 가 아니라 자체 `eq()` 하네스를 쓰는 독립 스크립트다)

**⚠️ TDZ 함정:** `const R = AI_TRADER.rotate;` 는 **327행**에 있고 `sellOk` 는 **303행**이며 `sellOk` 는 308행에서 호출된다. `sellOk` 안에서 `R` 을 참조하면 호출 시점에 TDZ 라 `ReferenceError: Cannot access 'R' before initialization` 이 난다. 반드시 `AI_TRADER.rotate.minHoldDays` 를 직접 쓴다.

- [ ] **Step 1: 실패하는 테스트를 추가한다**

`ai-trader-bounds.test.mjs` 의 `ctxOf` 아래, 기존 sell 관련 테스트 근처에 추가:

```js
// ── 2026-08-26: sellOk 를 rotOk 와 대칭으로. 수동/전략미상 포지션과 당일 매수분은 AI 가 못 판다.
{
  const ctx = ctxOf({
    holdings: [
      // 사용자가 토스 앱에서 직접 산 포지션 (sub 미상) — 2026-08-26 사고의 종목 유형
      { code: 'M1', name: '수동픽', sub: null, ret_pct: -10.4, near_stop: false, exit_reserved: null, defer_used: 0, judged_today: false, ca_hold: false, hold_days: null },
      // 봇이 오늘 산 포지션 — 진입 당일 청산 금지
      { code: 'T0', name: '당일매수', sub: 'rsi2', ret_pct: -1, near_stop: false, exit_reserved: null, defer_used: 0, judged_today: false, ca_hold: false, hold_days: 0 },
      // 보유일수를 알 수 없는 봇 포지션 — 모르면 거부
      { code: 'TN', name: '보유일미상', sub: 'rsi2', ret_pct: -1, near_stop: false, exit_reserved: null, defer_used: 0, judged_today: false, ca_hold: false, hold_days: null },
      // 정상 — 통과해야 한다(검출력 유지)
      { code: 'OK', name: '정상보유', sub: 'rsi2', ret_pct: -2, near_stop: false, exit_reserved: null, defer_used: 0, judged_today: false, ca_hold: false, hold_days: 4 },
    ],
  });
  const j = JSON.stringify({
    skipAll: false, buy: [], rotate: [], defer_stop: [],
    sell: [{ code: 'M1', reason: 'x' }, { code: 'T0', reason: 'x' }, { code: 'TN', reason: 'x' }, { code: 'OK', reason: 'x' }],
  });
  const d = parseDecision(j, ctx);
  eq('sellOk: sub 미상 포지션은 AI 가 팔 수 없다', d.sell.some(x => x.code === 'M1'), false);
  eq('sellOk: 진입 당일(hold_days 0) 포지션은 팔 수 없다', d.sell.some(x => x.code === 'T0'), false);
  eq('sellOk: 보유일수 미상은 거부한다', d.sell.some(x => x.code === 'TN'), false);
  eq('sellOk: 정상 보유는 여전히 통과한다(검출력 유지)', d.sell.some(x => x.code === 'OK'), true);
  eq('sellOk: 거부분은 dropped.sell 에 남는다', d.dropped.sell.includes('M1'), true);
}
```

- [ ] **Step 2: 실패 확인**

Run: `cd C:/claudeT/files && node ai-trader-bounds.test.mjs`
Expected: FAIL - `sellOk: sub 미상 포지션은 AI 가 팔 수 없다 got true want false` (현재는 통과시킨다)

- [ ] **Step 3: 구현**

`ai-trader.mjs:303-306` 을 다음으로 교체:

```js
    /**
     * ★ 2026-08-26: rotOk 와 대칭으로 맞춘다. 지금까지 sellOk 는 held/exit_reserved/ca_hold
     *   3개만 봤고, 그래서 **사용자가 토스 앱에서 직접 산 포지션(sub 미상)을 AI 가 팔 수 있었다.**
     *   295310 이 3회 강제청산됐다(08-19 -13.8%, 08-26 2건). 바로 아래 deferOk 는 이미
     *   `sub === 'rsi2'` 를 요구하는데 sellOk 만 빠져 있던 비대칭이다.
     *   보유일수 조건도 같이 맞춘다 — rotOk 의 minHoldDays 는 "진입 당일 교체 금지"(휩소 방어,
     *   07-28~29 두산퓨얼셀 4회 재진입 전례)인데 sell 에는 그 방어가 없었다.
     *   ⚠️ `const R = AI_TRADER.rotate` 는 327행이라 여기서 R 을 쓰면 TDZ ReferenceError 다.
     *     반드시 AI_TRADER.rotate 를 직접 참조한다.
     */
    const sellOk = (x) => {
      const h = heldMap.get(x.code);
      if (!h || h.exit_reserved || h.ca_hold) return false;
      if (h.sub == null) return false;                      // 봇이 산 포지션만 판다
      if (typeof h.hold_days !== 'number' || h.hold_days < AI_TRADER.rotate.minHoldDays) return false;
      return true;
    };
```

- [ ] **Step 4: 통과 확인 + 전체 회귀**

Run: `cd C:/claudeT/files && node ai-trader-bounds.test.mjs`
Expected: PASS - 기존 테스트 포함 `fail 0`

Run: `cd C:/claudeT/files && node --test "tests/**/*.test.{js,mjs}"`
Expected: `# fail 0`

- [ ] **Step 5: 커밋**

```bash
cd C:/claudeT/files
git add ai-trader.mjs ai-trader-bounds.test.mjs
git commit -m "fix(ai-trader): sellOk 를 rotOk 와 대칭으로 - 수동 포지션과 당일 매수분은 AI 가 못 판다"
```

---

## Task 6: `strategy-contract.mjs` - `sellRequiresApproval` 계약

**Files:**
- Modify: `strategy-contract.mjs:353` 근처 (`sellMaxPerDay: 2` 바로 뒤)
- Test: `tests/strategy-contract.test.js` (추가)

- [ ] **Step 1: 실패하는 테스트를 추가한다**

`tests/strategy-contract.test.js` 끝에 추가 (import 줄에 `AI_TRADER` 를 더한다):

```js
// 2026-08-26: AI 청산권고는 사람 승인을 거친다. 실적 0/3 이고, 패치 후 유효 표본은 0건이다.
//   매수는 이미 텔레그램 승인인데 매도만 자동집행이던 비대칭을 없앤다.
test('AI 청산은 기본값이 사람 승인이다', () => {
  assert.equal(AI_TRADER.sellRequiresApproval, true,
    'false 로 두면 미검증 기능이 실계좌에 자동집행된다 — 되돌릴 때만 명시적으로 바꾼다');
});
```

`tests/strategy-contract.test.js` 상단 import 를 다음으로 교체:

```js
import { BACKTEST_COMBO_CAPS, LIVE_COMBO_CAPS, LIVE_MAX_ORDER_VALUE, LIVE_MAX_ORDERS_PER_DAY, LIVE_SLOTS, LIVE_RSI2_UNIVERSE_LIMIT, HARD_STOP_PCT, TRAIL_PCT, AI_TRADER } from '../strategy-contract.mjs';
```

- [ ] **Step 2: 실패 확인**

Run: `cd C:/claudeT/files && node --test tests/strategy-contract.test.js`
Expected: FAIL - `Expected values to be strictly equal: undefined !== true`

- [ ] **Step 3: 구현**

`strategy-contract.mjs` 의 `sellMaxPerDay: 2,` 바로 뒤에 삽입:

```js
  /**
   * ★ 2026-08-26 신설. AI 청산권고를 사람 승인 아래 둔다.
   *
   *   true  = AI 는 텔레그램으로 권고만 하고, 사용자가 `청산승인 <종목명>` 을 보내야 예약이 심긴다.
   *   false = 종전 동작(권고 즉시 예약 → 익일 개장 자동집행). 롤백용.
   *
   *   근거: 실적 3건 · 평균 -4.93% · 승 0/3 이고, 그 3건은 전부 사용자가 직접 산 295310 이라
   *     소유권 가드 적용 후 **유효 표본이 0건**이 된다. 매수는 이미 텔레그램 승인(A+C 모델)인데
   *     매도만 자동이던 비대칭도 없앤다.
   *   부수 효과: 사유가 22.5시간 얼어붙은 채 집행되던 문제가 구조적으로 사라진다 —
   *     권고문에 근거 브리핑 날짜를 실어 사람이 신선도를 직접 판단한다.
   */
  sellRequiresApproval: true,
```

- [ ] **Step 4: 통과 확인**

Run: `cd C:/claudeT/files && node --test tests/strategy-contract.test.js`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
cd C:/claudeT/files
git add strategy-contract.mjs tests/strategy-contract.test.js
git commit -m "feat(contract): AI_TRADER.sellRequiresApproval - AI 청산은 사람 승인 기본값"
```

---

## Task 7: `stock-live.mjs` 배선 (1) - 소유 판정 · 자동 격리 · meta 복원

**Files:**
- Modify: `stock-live.mjs` (import 3곳, 신규 함수 1개, items 구성부 `:951-953`)

**⚠️ `loadJournal()` 을 쓰면 안 된다.** `loadJournal`(`:406`)은 저널이 손상되면 `.corrupt` 로 **rename 하고** `{trades: []}` 를 돌려준다. 그 값을 소유 판정에 쓰면 "봇 매수기록 0건" 으로 읽혀 **봇 포지션이 전량 자동격리**되고 검증된 -15% 손절이 사라진다. 판정용은 읽기 전용 사본을 따로 둔다.

- [ ] **Step 1: import 를 추가한다**

`stock-live.mjs:19` 을 다음으로 교체 (`statSync` 추가):

```js
import { existsSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, statSync } from 'fs';
```

`bot-exclude.mjs` import 줄을 찾는다:

Run: `cd C:/claudeT/files && grep -n "bot-exclude.mjs" stock-live.mjs`

찾은 줄을 다음으로 교체:

```js
import { readBotExclude, addBotExcludeAuto, removeBotExcludeAuto } from './bot-exclude.mjs';
```

그 아래에 추가:

```js
import { classifyPosition } from './position-ownership.mjs';
```

- [ ] **Step 2: 읽기 전용 저널 리더를 추가한다**

`loadJournal` 정의(`:406`) **바로 위**에 삽입:

```js
/**
 * 판정 전용 저널 리더 — **읽기만 한다**(손상 시 rename·경보·리셋 없음).
 *
 * ★ loadJournal() 을 소유 판정에 쓰면 안 되는 이유: 그 함수는 저널이 손상되면 `.corrupt` 로
 *   rename 하고 `{trades: []}` 를 돌려준다. 판정 입장에서 그 값은 "봇 매수기록 0건" 과 구분되지
 *   않아 **봇 포지션이 전량 자동격리**되고 검증된 -15% 손절이 조용히 사라진다.
 *   그래서 판정용은 실패를 null 로 구분해 '판정 보류'(classifyPosition → unknown)로 떨어뜨린다.
 *   30초 루프이므로 mtime 캐시를 둔다.
 */
let ownJournalCache = { mtime: -1, trades: null };
function readJournalTradesSafe() {
  for (const p of [JOURNAL, JOURNAL + '.bak']) {
    if (!existsSync(p)) continue;
    try {
      const mt = statSync(p).mtimeMs;
      if (ownJournalCache.trades && ownJournalCache.mtime === mt) return ownJournalCache.trades;
      const j = JSON.parse(readFileSync(p, 'utf8'));
      if (j && Array.isArray(j.trades)) { ownJournalCache = { mtime: mt, trades: j.trades }; return j.trades; }
    } catch { /* 다음 후보로 */ }
  }
  return null;   // 판정 보류
}
```

- [ ] **Step 3: items 구성부를 교체한다**

`stock-live.mjs:951-953` 의 세 줄

```js
  // LIVE_EXCLUDE(정적) + 동적 봇제외(텔레그램 수동매수, .bot-exclude.json)는 봇이 전혀 안 건드림 — items에서 제외(청산·슬롯계산 모두 스킵)
  const EXCLUDED = new Set([...LIVE_EXCLUDE, ...readBotExclude()]);
  const items = (holdings?.items ?? []).filter(i => i.marketCountry === 'KR' && Number(i.quantity) > 0 && !EXCLUDED.has(i.symbol));
```

를 다음으로 교체:

```js
  // LIVE_EXCLUDE(정적) + 격리 목록(수동 .bot-exclude.json ∪ 자동 .bot-exclude-auto.json)은
  //   봇이 전혀 안 건드림 — items 에서 제외(청산·슬롯계산 모두 스킵)
  const EXCLUDED_BEFORE = new Set([...LIVE_EXCLUDE, ...readBotExclude()]);
  /**
   * ★ 2026-08-26 신설: 소유권 판정.
   *   봇이 산 적 없는 포지션을 봇이 자동으로 파는 것을 원천 차단한다.
   *   `sub 미상` 은 ① 사용자가 산 것 ② 봇이 샀는데 meta 를 잃은 것 둘 다를 뜻하므로 저널로 가른다.
   *   ②를 격리하면 검증된 손절이 사라지므로 반드시 구분해야 한다.
   *   설계: docs/superpowers/specs/2026-08-26-reserved-exit-ownership-guards-design.md
   */
  const ownTrades = readJournalTradesSafe();
  for (const i of (holdings?.items ?? [])) {
    if (i.marketCountry !== 'KR' || !(Number(i.quantity) > 0)) continue;
    const code = i.symbol;
    if (EXCLUDED_BEFORE.has(code)) continue;                       // 이미 격리됨
    const cls = classifyPosition({
      code, brokerQty: Number(i.quantity), currentPx: Number(i.lastPrice),
      meta: state.meta[code], trades: ownTrades,
    });
    if (cls.kind === 'bot' && cls.restoreMeta) {
      state.meta[code] = { ...cls.restoreMeta };
      saveState();
      log(`🔧 meta 복원 ${i.name}(${code}) — ${cls.why} → sub=${cls.restoreMeta.sub}, 진입 ${cls.restoreMeta.entry.toLocaleString()}`);
      tgNotify(`🔧 ${i.name}(${code}) 의 meta 를 저널에서 복원했습니다 (${cls.restoreMeta.sub}).\n봇의 검증된 청산 규칙이 다시 적용됩니다.`);
    } else if (cls.kind === 'user') {
      try {
        addBotExcludeAuto(code);
        log(`🔒 자동 격리 ${i.name}(${code}) — ${cls.why}`);
        tgNotify(`⚠️ ${i.name}(${code}) 을 자동 격리했습니다.\n봇이 산 것이 아니라 건들지 않습니다.\n목표·손절 도달 시 알림만 보냅니다.\n봇에게 돌려주려면: 격리해제 ${i.name}`);
      } catch (e) {
        log(`🚨 자동 격리 실패 ${code}: ${String(e.message).slice(0, 100)} — 다음 사이클 재시도`);
      }
    } else if (cls.kind === 'unknown') {
      logGate(`소유 판정 보류 ${i.name}(${code}) — ${cls.why}`, `own|${code}`);
    }
  }
  const EXCLUDED = new Set([...LIVE_EXCLUDE, ...readBotExclude()]);   // 방금 격리한 것 반영
  const items = (holdings?.items ?? []).filter(i => i.marketCountry === 'KR' && Number(i.quantity) > 0 && !EXCLUDED.has(i.symbol));
```

- [ ] **Step 4: 문법·기동 검증**

Run: `cd C:/claudeT/files && node --check stock-live.mjs && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

Run: `cd C:/claudeT/files && node scripts/check-syntax.js`
Expected: 오류 없음

**예상되는 중복 알림(버그 아님):** 자동 격리 직후, 바로 아래 기존 블록(`for (const code of EXCLUDED)`)이 같은 종목을 보고 `⚠️ ... 수동 관리(격리) 상태라 봇이 건드리지 않습니다` 를 한 번 더 보낸다. 하루 1회 제한(`exclAlertDay`)이 걸려 있고 내용도 맞으므로 그대로 둔다 — 오늘 052690 을 수동 격리했을 때도 같은 로그가 나왔다.

- [ ] **Step 5: 커밋**

```bash
cd C:/claudeT/files
git add stock-live.mjs
git commit -m "feat(live): 소유권 판정 배선 - 봇이 안 산 포지션은 자동 격리, meta 유실분은 저널에서 복원"
```

---

## Task 8: `stock-live.mjs` 배선 (2) - exitQty 상한

**Files:**
- Modify: `stock-live.mjs` (import, `:734` aiExitPark, `:745` unpark, `:824` unpark, `:826` 기계예약, `:1214-1215` 집행부, `:1231-1241` 체결 후처리)

- [ ] **Step 1: import 추가**

`position-ownership.mjs` import 아래에 추가:

```js
import { plannedSellQty } from './exit-qty.mjs';
```

- [ ] **Step 2: 예약을 심는 3곳에 `exitQty` 를 같이 세운다**

`:734` (aiExitPark 캡처) 를 교체:

```js
      aiExitPark = { exitAt: m.exitAt, exitFrac: m.exitFrac, exitQty: m.exitQty };
```

`:745` (unpark) 를 교체:

```js
    const unpark = () => { if (aiExitPark) { m.exitAt = aiExitPark.exitAt; m.exitDay = today; m.exitFrac = aiExitPark.exitFrac ?? 1; m.exitQty = aiExitPark.exitQty; } };
```

`:824` (기계 판정이 없을 때 AI 예약 복원) 를 교체:

```js
      else { m.exitAt = aiExitPark.exitAt; m.exitDay = today; m.exitFrac = aiExitPark.exitFrac ?? 1; m.exitQty = aiExitPark.exitQty; }
```

`:826` (기계 예약) 을 교체:

```js
    // ★ 2026-08-26: 예약에 그 시점 보유수량을 함께 박는다. 예약청산은 브로커 보유수량을 실시간으로
    //   읽으므로, 상한이 없으면 예약 이후 사용자가 산 물량까지 판다(08-26 재매수 143주 사고).
    if (why) { m.exitAt = why; m.exitDay = today; m.exitFrac = frac; m.exitQty = Number(it.quantity); }
```

- [ ] **Step 3: 집행부를 교체한다**

`:1212-1216` 의

```js
        // ★ 2026-07-29: 예약청산이 부분익절이면 절반만 팔고 포지션을 유지한다(백테 tp_half/tp_quarter 재현).
        //   m.exitFrac: 1=전량 / 0.5=절반. 전량이 아니면 meta를 지우지 않고 tp1/tp2 플래그만 세운다.
        const frac = Number(m.exitFrac ?? 1);
        const sellQty = frac >= 1 ? qty : Math.max(1, Math.floor(qty * frac));
        const partial = sellQty < qty;
```

를 다음으로 교체:

```js
        // ★ 2026-07-29: 예약청산이 부분익절이면 절반만 팔고 포지션을 유지한다(백테 tp_half/tp_quarter 재현).
        //   m.exitFrac: 1=전량 / 0.5=절반. 전량이 아니면 meta를 지우지 않고 tp1/tp2 플래그만 세운다.
        // ★ 2026-08-26: 여기에 **예약 시점 수량 상한**을 건다. base = min(브로커 보유, 예약 잔량).
        //   partial 판정도 qty 가 아니라 base 기준이다 — 봇 몫 179주를 전량 청산하는 것을
        //   "브로커 322주 중 179주"로 보면 부분익절로 오판해 tp 플래그가 서고 meta 가 남는다.
        const frac = Number(m.exitFrac ?? 1);
        const { sellQty, base, release } = plannedSellQty({ brokerQty: qty, exitQty: m.exitQty, frac });
        if (release) {
          log(`예약청산 해제 ${it.name}(${it.symbol}) — 예약 잔량 소진(exitQty=${m.exitQty ?? '없음'}, 보유 ${qty}). 나머지는 사용자 매수분이다`);
          delete m.exitAt; delete m.exitDay; delete m.exitFrac; delete m.exitQty; delete m.aiExit;
          saveState();
          continue;
        }
        const partial = sellQty < base;
```

- [ ] **Step 4: 체결 후처리에서 예약 잔량을 감액한다**

`:1231-1241` 의 `if (under) { ... } else if (partial) { ... } else { ... }` 블록을 다음으로 교체:

```js
          if (under) {
            // 수량 미달 → 상태 전이 없음. 남은 수량은 기존(검증된) 규칙이 다음 판정에서 계속 관리한다.
            // ★ 2026-08-26: 단 **예약 잔량은 체결분만큼 줄인다.** 이게 없으면 다음 시도가 다시
            //   전량 상한으로 돌아가 사용자 재매수분을 삼킨다(08-26 08:06 이 정확히 그 경로였다).
            m.exitQty = Math.max(0, base - fq);
            log(`  ⚠️ 체결수량 미달 — meta·예약 유지(예약 잔량 ${m.exitQty}주), 다음 판정에서 재시도`);
            tgNotify(`⚠️ 청산 수량 미달: ${it.name} ${fq}/${sellQty}주만 체결됐습니다.\n잔량 ${m.exitQty}주는 기존 청산 규칙이 계속 관리합니다.`);
          } else if (partial) {
            // 부분익절: 포지션 유지. tp 플래그를 세워 다음 판정에서 같은 단계가 재발동하지 않게 한다.
            if (/tp1/.test(reason)) m.tp1 = true; else if (/tp2/.test(reason)) m.tp2 = true;
            delete m.exitAt; delete m.exitFrac; delete m.exitDay; delete m.exitQty;
          } else {
            // 예약분 전량 청산. 브로커에 남은 수량이 있다면 그건 사용자가 산 물량이고,
            //   다음 사이클 소유 판정이 sub 미상 → 저널 봇잔량 0 → 자동 격리로 처리한다.
            delete state.meta[it.symbol];
            (state.soldToday ??= {})[it.symbol] = today;   // 당일 재진입 금지(아래 진입 루프에서 스킵)
          }
```

- [ ] **Step 5: 문법 검증 + 커밋**

Run: `cd C:/claudeT/files && node --check stock-live.mjs && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

```bash
cd C:/claudeT/files
git add stock-live.mjs
git commit -m "fix(live): 예약청산 수량 상한 배선 - 예약 이후 매수분을 팔지 않는다"
```

---

## Task 9: `stock-live.mjs` 배선 (4) - AI 청산 제안 · 승인 소비

**Files:**
- Modify: `stock-live.mjs` (import, `morningBrief` 근처 헬퍼, `:1465-1478` AI sell 블록, 요청 소비 블록 신설)

- [ ] **Step 1: import 와 briefDay 헬퍼를 추가한다**

`exit-qty.mjs` import 아래에 추가:

```js
import { readRequestsAfter } from './tg-requests.mjs';
```

`morningBrief` 함수(`:582-604`) **바로 아래**에 추가:

```js
/**
 * 이번 사이클 AI 판단이 실제로 읽은 브리핑의 날짜. 청산 권고문에 실어 **사람이 사유의 신선도를
 *   직접 판단**하게 한다. 08-25 09:33 에 만들어진 사유("간밤 미 반도체 SOXX -4%", 실제로는 08-24
 *   미국장)가 22.5시간 뒤 08-26 08:00 에 그대로 집행됐고, 그 사이 08-25 미국장은 SOXX +1.56% 로
 *   반등했다. 사람에게 날짜를 보여주는 것만으로 이 유형이 잡힌다.
 */
const briefDayOf = () => (briefCache.text ? briefCache.day : null);
```

- [ ] **Step 2: AI sell 블록을 제안 등록으로 바꾼다**

`stock-live.mjs:1465-1478` 의 `if (ai.mode === 'live' && ai.sell?.size) { ... }` 블록 전체를 다음으로 교체:

```js
  // ★ 2026-08-26: AI 청산권고는 **사람 승인**을 거친다(매수와 동일한 A+C 모델).
  //   기존엔 권고가 곧바로 m.exitAt 이 되어 익일 개장에 자동집행됐고, 실적은 3건 · 평균 -4.93% ·
  //   승 0/3 이며 그 3건은 전부 사용자가 직접 산 295310 이었다. 소유권 가드 적용 후 이 기능의
  //   유효 표본은 0건이다. 미검증 기능을 실계좌에 자동집행하지 않는다.
  //   AI_TRADER.sellRequiresApproval = false 로 두면 종전 자동집행으로 롤백된다.
  if (ai.mode === 'live' && ai.sell?.size) {
    const pend = (state.aiExitPending ??= {});
    for (const [code, why] of ai.sell) {
      const m = state.meta[code];
      if (!m || m.exitAt) continue;                      // 미보유·기존예약은 스킵
      if (m.judgedDay === today) { log(`AI청산 무효 ${code}: 오늘 종가판정 완료(${m.exitAt ?? '보유 유지'}) — 다음 거래일 판단에서 재검토`); continue; }

      if (!AI_TRADER.sellRequiresApproval) {             // 롤백 경로 (종전 동작)
        if ((state.aiSellCount ?? 0) >= AI_TRADER.sellMaxPerDay) { logGate(`AI청산예약 상한 도달(${AI_TRADER.sellMaxPerDay}/일) — ${code} 스킵`, 'aisell|cap'); break; }
        m.exitAt = `AI판단(${String(why).slice(0, 60)})`; m.exitDay = today; m.exitFrac = 1;
        m.exitQty = Number(items.find(i => i.symbol === code)?.quantity ?? 0); m.aiExit = true;
        state.aiSellCount = (state.aiSellCount ?? 0) + 1;
        saveState();
        log(`AI청산예약 ${code} (${state.aiSellCount}/${AI_TRADER.sellMaxPerDay}) — ${why}`);
        tgNotify(`📌 AI 청산예약 ${code} — 익일 개장 집행 예정`);
        continue;
      }

      if (pend[code]?.day === today) continue;           // 같은 날 중복 제안 금지
      const nm = items.find(i => i.symbol === code)?.name ?? code;
      const ret = (() => { const it2 = items.find(i => i.symbol === code); const e = Number(it2?.averagePurchasePrice), p = Number(it2?.lastPrice); return e > 0 && p > 0 ? ((p / e - 1) * 100).toFixed(1) : '?'; })();
      pend[code] = { name: nm, why: String(why).slice(0, 200), briefDay: briefDayOf(), day: today, at: now(), expiresAt: `${today} 20:00 KST` };
      saveState();
      log(`AI청산제안 ${code}(${nm}) — 승인 대기. 근거 브리핑 ${pend[code].briefDay ?? '없음'} · ${why}`);
      tgNotify(`📌 청산 권고: ${nm}(${code}) ${ret}%\n사유: ${String(why).slice(0, 300)}\n근거 브리핑: ${pend[code].briefDay ?? '없음'}\n승인: 청산승인 ${nm}\n(미승인 시 오늘 20:00 만료)`);
    }
  }
  // 만료된 제안 정리 — 승인 없이 날이 바뀌면 폐기한다(다음 판단에서 다시 제안된다).
  if (state.aiExitPending) {
    for (const [code, p] of Object.entries(state.aiExitPending)) {
      if (p?.day === today) continue;
      delete state.aiExitPending[code];
      log(`AI청산제안 만료 ${code}(${p?.name ?? ''}) — 미승인`);
      tgNotify(`⌛ 청산 권고 만료: ${p?.name ?? code} — 승인이 없어 폐기했습니다.`);
      saveState();
    }
  }
```

- [ ] **Step 3: 요청 소비 블록을 추가한다**

위 블록 **바로 아래**에 삽입:

```js
  /**
   * ★ 텔레그램 요청 소비 (청산승인 · 격리해제).
   *   writer 는 telegram-agent 단독이고 여기는 읽기 전용 + 커서다(파일당 writer 1개 = 락 불필요).
   *   판정을 여기서 하는 이유: 승인·격리해제는 봇 상태를 바꾸는 일이라 상태 소유자가 결정해야 한다.
   */
  try {
    const cur = Number(state.tgReqCursor?.lines ?? 0);
    const { items: reqs, lines, skipped } = readRequestsAfter(cur);
    if (skipped) log(`⚠️ 텔레그램 요청 ${skipped}줄 파싱 실패 — 해당 줄만 건너뛴다`);
    for (const r of reqs) {
      if (r?.type === 'ai_exit_approve') applyExitApproval(r, today, items);
      // ★ ownTrades 변수를 재사용하지 않고 다시 부른다 — 이 블록과 소유 판정 루프 사이에 수백 줄이
      //   있어 스코프 의존이 깨지기 쉽고, 깨지면 ReferenceError 가 런타임에만 드러난다.
      //   readJournalTradesSafe 는 mtime 캐시라 재호출 비용이 사실상 0이다.
      else if (r?.type === 'unquarantine') applyUnquarantine(r, readJournalTradesSafe(), holdings);
    }
    if (lines !== cur) { state.tgReqCursor = { lines }; saveState(); }
  } catch (e) { log(`텔레그램 요청 소비 오류: ${String(e.message).slice(0, 120)}`); }
```

- [ ] **Step 4: 두 핸들러 함수를 추가한다**

`briefDayOf` 정의 아래(모듈 최상위)에 삽입:

```js
/**
 * `청산승인 <종목명>` 처리 — 제안을 실제 예약으로 승격시킨다.
 *   기존 가드(중복예약·당일판정완료·일일상한)를 전부 그대로 적용한다. 상한 카운터는 **승인 시점**에
 *   소비한다 — 제안은 무료이고 실제 예약이 생길 때만 비용이 든다.
 */
function applyExitApproval(r, today, items) {
  const code = String(r.code ?? ''), nm = r.name ?? code;
  const p = state.aiExitPending?.[code];
  if (!p) { tgNotify(`⚠️ ${nm} 의 청산 제안이 없습니다(만료됐거나 제안된 적이 없습니다).`); return; }
  const m = state.meta[code];
  if (!m) { delete state.aiExitPending[code]; saveState(); tgNotify(`⚠️ ${nm} 은 봇 관리 포지션이 아닙니다 — 승인 무효.`); return; }
  if (m.exitAt) { delete state.aiExitPending[code]; saveState(); tgNotify(`⚠️ ${nm} 은 이미 청산 예약(${m.exitAt})이 있습니다 — 승인 무효.`); return; }
  if (m.judgedDay === today) { tgNotify(`⚠️ ${nm} 은 오늘 종가판정이 끝났습니다 — 다음 거래일에 재판단합니다.`); return; }
  if ((state.aiSellCount ?? 0) >= AI_TRADER.sellMaxPerDay) { tgNotify(`⚠️ AI 청산 일일 상한(${AI_TRADER.sellMaxPerDay}건) 도달 — ${nm} 승인을 보류합니다.`); return; }
  const qty = Number(items.find(i => i.symbol === code)?.quantity ?? 0);
  if (!(qty > 0)) { tgNotify(`⚠️ ${nm} 보유수량을 확인할 수 없어 승인을 보류합니다.`); return; }

  m.exitAt = `AI판단(${p.why.slice(0, 60)})`; m.exitDay = today; m.exitFrac = 1; m.exitQty = qty; m.aiExit = true;
  state.aiSellCount = (state.aiSellCount ?? 0) + 1;
  delete state.aiExitPending[code];
  saveState();
  log(`AI청산예약(사용자 승인) ${code}(${nm}) ${qty}주 (${state.aiSellCount}/${AI_TRADER.sellMaxPerDay})`);
  tgNotify(`✅ 청산 승인: ${nm} ${qty}주 — 익일 개장 집행 예정입니다.`);
}

/**
 * `격리해제 <종목명>` 처리.
 *   ★ 봇이 산 적 없는 종목은 **거부한다.** 적용할 검증된 청산 규칙이 없기 때문이다.
 *     검증된 사다리는 rsi2/hi120 진입 신호에 묶여 있고(judgeExitsAtClose 가 그 둘만 판정한다),
 *     임의의 sub 를 붙이면 그 포지션은 폐지된 장중 손절·트레일 경로로 떨어진다(청산건당 -0.69%p).
 *     같은 위험을 이 파일의 1162~1168행 주석이 이미 경고하고 있다.
 */
function applyUnquarantine(r, trades, holdings) {
  const code = String(r.code ?? ''), nm = r.name ?? code;
  const it = (holdings?.items ?? []).find(x => x.symbol === code);
  if (!it) { tgNotify(`⚠️ ${nm} 은 현재 보유 중이 아닙니다 — 격리해제할 것이 없습니다.`); return; }
  const cls = classifyPosition({
    code, brokerQty: Number(it.quantity), currentPx: Number(it.lastPrice),
    meta: null, trades,                       // meta 를 비워 저널 판정을 강제한다
  });
  if (cls.kind === 'unknown') { tgNotify(`⚠️ 지금은 저널을 읽을 수 없어 ${nm} 의 소유를 판정할 수 없습니다. 잠시 후 다시 시도해주세요.`); return; }
  if (cls.kind === 'bot' && cls.restoreMeta) {
    try { removeBotExcludeAuto(code); } catch (e) { log(`격리해제 파일 쓰기 실패 ${code}: ${String(e.message).slice(0, 80)}`); tgNotify(`⚠️ ${nm} 격리해제 중 파일 오류 — 다시 시도해주세요.`); return; }
    state.meta[code] = { ...cls.restoreMeta };
    saveState();
    log(`격리해제 ${code}(${nm}) — ${cls.why} → sub=${cls.restoreMeta.sub}`);
    tgNotify(`✅ 격리해제: ${nm} — 봇 규칙 재적용(${cls.restoreMeta.sub}).`);
    return;
  }
  log(`격리해제 거부 ${code}(${nm}) — ${cls.why}`);
  tgNotify(`⚠️ ${nm} 은 봇이 산 적이 없어 격리를 해제할 수 없습니다.\n적용할 검증된 청산 규칙이 없습니다(진입 신호를 봇이 만들지 않았습니다).\n이 종목은 매도사인 알림으로 직접 관리하시거나, 매도 후 봇이 스스로 편입하게 두시면 됩니다.`);
}
```

- [ ] **Step 5: 문법 검증 + 커밋**

Run: `cd C:/claudeT/files && node --check stock-live.mjs && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

Run: `cd C:/claudeT/files && grep -n "AI_TRADER" stock-live.mjs | head -3`
Expected: `AI_TRADER` 가 이미 import 돼 있다(없으면 `strategy-contract.mjs` import 목록에 추가한다).

```bash
cd C:/claudeT/files
git add stock-live.mjs
git commit -m "feat(live): AI 청산은 사람 승인 - 제안 등록 + 텔레그램 요청 소비"
```

---

## Task 10: `telegram-agent.mjs` - `청산승인` 파서 · `격리해제` 를 요청 채널로

**Files:**
- Modify: `telegram-agent.mjs:187-190`

- [ ] **Step 1: import 를 추가한다**

Run: `cd C:/claudeT/files && grep -n "bot-exclude.mjs" telegram-agent.mjs`

그 import 줄 아래에 추가:

```js
import { appendRequest } from './tg-requests.mjs';
```

- [ ] **Step 2: `격리해제` 핸들러를 교체한다**

`telegram-agent.mjs:187-190` 을 다음으로 교체:

```js
      if (text.startsWith('격리해제')) {
        // ★ 2026-08-26: 판정은 stock-live 가 한다. 여기서는 **자기 소유 파일**(.bot-exclude.json)만
        //   지우고, 자동 격리분(.bot-exclude-auto.json)은 요청 채널로 넘긴다.
        //   파일마다 writer 를 하나로 유지하기 위한 것이고(락 불필요), 봇이 산 적 없는 종목은
        //   stock-live 가 거부 사유와 함께 답한다.
        const nm = text.replace(/^격리해제\s*/, '').trim();
        if (!nm) { await send('사용법: 격리해제 <종목명>'); continue; }
        try {
          const rr = await resolveStock(nm, { dbQuery });
          if (rr.status === 'ok') {
            removeBotExclude(rr.code);
            appendRequest({ type: 'unquarantine', code: rr.code, name: rr.name });
            await send(`📨 격리해제 요청 접수: ${rr.name}(${rr.code}) — 봇이 저널을 확인한 뒤 결과를 알려드립니다.`);
          } else await send(`'${nm}' 못 찾음/모호 — 격리해제 실패.`);
        } catch (e) { await send('격리해제 오류: ' + String(e.message).slice(0, 120)); }
        continue;
      }
      if (text.startsWith('청산승인')) {
        // AI 청산 권고 승인. 결정론적 파서만 쓴다(LLM 미사용) — 주문에 준하는 행위다.
        const nm = text.replace(/^청산승인\s*/, '').trim();
        if (!nm) { await send('사용법: 청산승인 <종목명>'); continue; }
        try {
          const rr = await resolveStock(nm, { dbQuery });
          if (rr.status === 'ok') {
            appendRequest({ type: 'ai_exit_approve', code: rr.code, name: rr.name });
            await send(`📨 청산 승인 접수: ${rr.name}(${rr.code}) — 봇이 예약을 등록하면 알려드립니다.`);
          } else await send(`'${nm}' 못 찾음/모호 — 청산승인 실패.`);
        } catch (e) { await send('청산승인 오류: ' + String(e.message).slice(0, 120)); }
        continue;
      }
```

- [ ] **Step 3: 기존 핸들러 체인에 `continue` 가 중복되지 않는지 확인한다**

Run: `cd C:/claudeT/files && sed -n '180,215p' telegram-agent.mjs`
Expected: 각 `if (text.startsWith(...))` 블록이 `continue` 로 끝나고, `청산승인` 블록이 다른 핸들러보다 **먼저** 오거나 겹치지 않는다. `매도` 핸들러가 `청산승인` 을 삼키지 않는지 확인한다(`청산승인` 은 `매도` 로 시작하지 않으므로 충돌 없음).

- [ ] **Step 4: 문법 검증**

Run: `cd C:/claudeT/files && node --check telegram-agent.mjs && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 5: 커밋**

```bash
cd C:/claudeT/files
git add telegram-agent.mjs
git commit -m "feat(telegram): 청산승인 파서 추가 + 격리해제를 요청 채널로 (판정은 stock-live)"
```

---

## Task 11: 배선 회귀 테스트 (not-wired 검출)

**Files:**
- Create: `tests/live-guards-source.test.js`

**왜:** `stock-live.mjs` 는 import 가 불가능해 단위테스트를 붙일 수 없다. 이번 사고의 본질은 "가드가 소스에는 있는데 실행 경로가 아니었다" 이므로, **모듈이 실제로 호출되는지**와 **예약 대입마다 상한이 붙는지**를 소스로 못 박는다.

- [ ] **Step 1: 테스트를 쓴다**

`tests/live-guards-source.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const live = readFileSync(join(ROOT, 'stock-live.mjs'), 'utf8');
const trader = readFileSync(join(ROOT, 'ai-trader.mjs'), 'utf8');
const tg = readFileSync(join(ROOT, 'telegram-agent.mjs'), 'utf8');

// 2026-08-26: 결함 4개 중 3개가 "소스에는 있는데 실행 경로가 아니었다" 유형이었다.
//   가드가 존재하는 것과 배선된 것은 다르다 — 배선을 여기서 못 박는다.
test('stock-live 가 소유권 판정을 실제로 호출한다', () => {
  assert.ok(/import\s*\{[^}]*classifyPosition[^}]*\}\s*from\s*'\.\/position-ownership\.mjs'/.test(live), 'classifyPosition import 가 없다');
  assert.ok(/classifyPosition\s*\(/.test(live), 'classifyPosition 호출이 없다 — 모듈만 있고 배선이 없다');
});

test('stock-live 가 예약청산 수량 상한을 실제로 호출한다', () => {
  assert.ok(/import\s*\{[^}]*plannedSellQty[^}]*\}\s*from\s*'\.\/exit-qty\.mjs'/.test(live), 'plannedSellQty import 가 없다');
  assert.ok(/plannedSellQty\s*\(/.test(live), 'plannedSellQty 호출이 없다');
});

test('상한 없는 옛 매도수량 산식이 되살아나지 않았다', () => {
  assert.ok(!/const\s+sellQty\s*=\s*frac\s*>=\s*1\s*\?\s*qty\s*:/.test(live),
    '브로커 보유수량을 그대로 파는 옛 산식이 남아 있다 — 08-26 재매수 143주 사고의 직접 원인');
});

test('예약을 심는 모든 지점이 exitQty 를 같이 세운다', () => {
  const lines = live.split('\n');
  const hits = lines.map((l, i) => [l, i]).filter(([l]) => /\bm\.exitAt\s*=\s*[^=]/.test(l));
  // ★ 0건이면 "위반 없음"이 아니라 "판정 없음"이다. 정규식이 조용히 죽는 것을 막는다.
  assert.ok(hits.length >= 3, `예약 대입 지점을 ${hits.length}개만 찾았다 — 정규식이 죽었거나 코드 형태가 바뀌었다`);
  for (const [, i] of hits) {
    const win = lines.slice(i, i + 3).join('\n');
    assert.ok(/exitQty/.test(win), `stock-live.mjs:${i + 1} 예약 대입에 exitQty 가 없다 — 상한 없는 새 예약 경로가 추가됐다`);
  }
});

test('sellOk 가 sub 와 hold_days 를 검사한다', () => {
  const m = trader.match(/const sellOk = \(x\) => \{[\s\S]*?\n    \};/);
  assert.ok(m, 'sellOk 정의를 찾지 못했다 — 선언 형태가 바뀌면 이 대조가 조용히 죽는다');
  assert.ok(/h\.sub == null/.test(m[0]), 'sellOk 에 sub 검사가 없다 — 수동 포지션을 AI 가 팔 수 있다');
  assert.ok(/hold_days/.test(m[0]) && /minHoldDays/.test(m[0]), 'sellOk 에 보유일수 검사가 없다');
});

test('sellOk 는 TDZ 를 피해 AI_TRADER.rotate 를 직접 참조한다', () => {
  const m = trader.match(/const sellOk = \(x\) => \{[\s\S]*?\n    \};/);
  assert.ok(/AI_TRADER\.rotate\.minHoldDays/.test(m[0]),
    'const R 은 sellOk 보다 아래(327행)라 R.minHoldDays 를 쓰면 호출 시 ReferenceError 다');
});

test('stock-live 가 텔레그램 요청을 소비한다', () => {
  assert.ok(/readRequestsAfter\s*\(/.test(live), 'readRequestsAfter 호출이 없다 — 승인해도 아무 일도 안 난다');
  assert.ok(/applyExitApproval\s*\(/.test(live) && /applyUnquarantine\s*\(/.test(live), '요청 핸들러 호출이 없다');
});

test('telegram-agent 가 청산승인을 요청 채널로 보낸다', () => {
  assert.ok(/청산승인/.test(tg), '청산승인 파서가 없다');
  assert.ok(/appendRequest\s*\(\s*\{\s*type:\s*'ai_exit_approve'/.test(tg), '청산승인이 요청 채널에 적재되지 않는다');
  assert.ok(/appendRequest\s*\(\s*\{\s*type:\s*'unquarantine'/.test(tg), '격리해제가 요청 채널에 적재되지 않는다');
});

test('telegram-agent 는 자동 격리 파일을 직접 쓰지 않는다 (D6 — writer 1개 원칙)', () => {
  assert.ok(!/removeBotExcludeAuto|addBotExcludeAuto/.test(tg),
    'telegram-agent 가 자동 격리 파일의 두 번째 writer 가 됐다');
});

test('판정용 저널 리더가 파괴적인 loadJournal 을 쓰지 않는다', () => {
  const m = live.match(/function readJournalTradesSafe\(\)[\s\S]*?\n\}/);
  assert.ok(m, 'readJournalTradesSafe 정의를 찾지 못했다');
  assert.ok(!/loadJournal/.test(m[0]),
    'loadJournal 은 손상 시 .corrupt 로 rename 하고 {trades:[]} 를 준다 — 봇 포지션이 전량 격리된다');
  assert.ok(/return null/.test(m[0]), '실패를 null 로 구분하지 않으면 판정 보류가 불가능하다');
});
```

- [ ] **Step 2: 실행해서 전부 통과하는지 본다**

Run: `cd C:/claudeT/files && node --test tests/live-guards-source.test.js`
Expected: PASS - `# pass 10` / `# fail 0`
실패하면 Task 7~10 의 배선이 빠진 것이다. 테스트를 고치지 말고 **배선을 고친다.**

- [ ] **Step 3: 커밋**

```bash
cd C:/claudeT/files
git add tests/live-guards-source.test.js
git commit -m "test: 배선 회귀 대조 - 가드가 존재하는 것과 호출되는 것을 구분한다"
```

---

## Task 12: `diag-ownership.mjs` - 읽기전용 분류 미리보기

**Files:**
- Create: `diag-ownership.mjs`

**왜:** 처음엔 `node stock-live.mjs --plan` 으로 분류를 확인하려 했으나 **`--plan` 은 보유 루프를 아예 타지 않는다.** `stock-live.mjs:326-357` 은 매수 후보만 출력하고 `process.exit(0)` 한다 — 소유 판정 코드는 실행되지 않는다. 검증할 수 없는 검증 단계였다. 또 토스 API 는 **VM IP 만 화이트리스트**라 로컬 실행은 `no_authorization_ip` 로 실패한다. 그래서 VM 에서 도는 **읽기전용 진단 스크립트**를 따로 만든다.

- [ ] **Step 1: 스크립트를 만든다**

`diag-ownership.mjs`:

```js
#!/usr/bin/env node
/**
 * diag-ownership.mjs — 소유권 판정 읽기전용 미리보기. **아무것도 쓰지 않는다.**
 *
 * `stock-live.mjs --plan` 은 매수 후보만 출력하고 종료하므로 보유 판정 경로를 타지 않는다.
 *   배포 전에 "어느 종목이 격리되고 어느 종목이 복원되는가"를 미리 보려면 이게 필요하다.
 *
 * ⚠️ 토스 API 는 VM IP 만 화이트리스트다. **VM 에서 실행한다:**
 *      ssh ... "cd ~/krxdata && node diag-ownership.mjs"
 * ⚠️ state·저널도 VM 에만 있다. 로컬 실행은 전부 sub 미상으로 보여 무의미하다.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { getAccounts, getHoldings } from './toss-api.js';
import { classifyPosition } from './position-ownership.mjs';
import { readBotExclude, readBotExcludeManual, readBotExcludeAuto } from './bot-exclude.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const readJson = (p) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } };

const st = readJson(join(__dirname, 'stock-live-state.json'));
if (!st) console.log('⚠️ stock-live-state.json 이 없다 — 전부 sub 미상으로 보인다. VM 에서 실행하고 있는지 확인할 것.\n');

// 판정용 저널: 손상 시 null (stock-live 의 readJournalTradesSafe 와 같은 규칙)
let trades = null;
for (const p of [join(__dirname, 'stock-live-journal.json'), join(__dirname, 'stock-live-journal.json.bak')]) {
  const j = readJson(p);
  if (j && Array.isArray(j.trades)) { trades = j.trades; break; }
}
console.log(trades ? `저널 ${trades.length}건 로드` : '⚠️ 저널을 읽을 수 없다 → 전부 판정 보류(unknown)로 나올 것');

const excl = readBotExclude(__dirname);
console.log(`격리 목록: 수동 ${[...readBotExcludeManual(__dirname)].join(',') || '없음'} / 자동 ${[...readBotExcludeAuto(__dirname)].join(',') || '없음'}\n`);

const seq = (await getAccounts())[0].accountSeq;
const h = await getHoldings(seq);
const items = (h?.items ?? []).filter(i => i.marketCountry === 'KR' && Number(i.quantity) > 0);
if (!items.length) console.log('보유 0종목.');

let nUser = 0, nBot = 0, nUnknown = 0, nExcl = 0;
for (const i of items) {
  if (excl.has(i.symbol)) { console.log(`[격리됨] ${i.name}(${i.symbol}) ${i.quantity}주 — 봇이 건드리지 않는다`); nExcl++; continue; }
  const cls = classifyPosition({
    code: i.symbol, brokerQty: Number(i.quantity), currentPx: Number(i.lastPrice),
    meta: st?.meta?.[i.symbol], trades,
  });
  const tag = cls.kind === 'user' ? '[→자동격리]' : cls.kind === 'bot' ? '[봇관리]' : '[판정보류]';
  const extra = cls.restoreMeta ? ` → meta 복원 sub=${cls.restoreMeta.sub} 진입 ${cls.restoreMeta.entry.toLocaleString()} hi ${cls.restoreMeta.hi.toLocaleString()}` : '';
  console.log(`${tag} ${i.name}(${i.symbol}) ${i.quantity}주 — ${cls.why}${extra}`);
  if (cls.kind === 'user') nUser++; else if (cls.kind === 'bot') nBot++; else nUnknown++;
}
console.log(`\n요약: 격리대상 ${nUser} · 봇관리 ${nBot} · 판정보류 ${nUnknown} · 이미격리 ${nExcl}`);
if (nUnknown) console.log('⚠️ 판정보류가 있다 — 저널을 못 읽은 것이다. 배포 전에 원인을 찾을 것.');
console.log('※ 이 스크립트는 아무 파일도 쓰지 않는다.');
```

- [ ] **Step 2: 쓰기가 없는지 기계로 확인한다**

Run: `cd C:/claudeT/files && grep -nE "writeFileSync|appendFileSync|addBotExclude|removeBotExclude|createOrder" diag-ownership.mjs`
Expected: `readBotExclude`/`readBotExcludeManual`/`readBotExcludeAuto` **읽기 함수만** 나오고 `writeFileSync`·`appendFileSync`·`addBotExclude(`·`removeBotExclude(`·`createOrder` 는 **한 건도 없다**. 하나라도 나오면 진단이 상태를 오염시킨다.

Run: `cd C:/claudeT/files && node --check diag-ownership.mjs && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 3: 커밋**

```bash
cd C:/claudeT/files
git add diag-ownership.mjs
git commit -m "feat(diag): 소유권 판정 읽기전용 미리보기 (--plan 은 보유 루프를 타지 않는다)"
```

---

## Task 13: 통합 검증 · 배포 · 재개

**Files:** 없음 (검증·배포만)

- [ ] **Step 1: 전체 테스트**

Run: `cd C:/claudeT/files && node --test "tests/**/*.test.{js,mjs}"`
Expected: `# fail 0`

Run: `cd C:/claudeT/files && node ai-trader-bounds.test.mjs`
Expected: `fail 0`

Run: `cd C:/claudeT/files && node scripts/check-syntax.js`
Expected: 오류 없음

- [ ] **Step 2: VM 배포**

```bash
cd C:/claudeT/files
scp -i ~/.ssh/oracle-vm position-ownership.mjs exit-qty.mjs tg-requests.mjs bot-exclude.mjs strategy-contract.mjs ai-trader.mjs stock-live.mjs telegram-agent.mjs diag-ownership.mjs ubuntu@134.185.111.69:~/krxdata/
```

배포 후 내용 대조 (로컬은 CRLF 라 md5 는 다를 수 있으므로 내용으로 본다):

```bash
cd C:/claudeT/files
for f in position-ownership.mjs exit-qty.mjs tg-requests.mjs bot-exclude.mjs strategy-contract.mjs ai-trader.mjs stock-live.mjs telegram-agent.mjs diag-ownership.mjs; do
  if diff <(ssh -i ~/.ssh/oracle-vm ubuntu@134.185.111.69 "cat ~/krxdata/$f" | tr -d '\r') <(tr -d '\r' < "$f") >/dev/null; then echo "OK   $f"; else echo "DIFF $f"; fi
done
```
Expected: 9줄 전부 `OK`

- [ ] **Step 3: VM 에서 분류 미리보기 — 서비스는 아직 정지 상태다**

```bash
ssh -i ~/.ssh/oracle-vm ubuntu@134.185.111.69 "cd ~/krxdata && node diag-ownership.mjs"
```

Expected: 다음을 **문자열로** 확인한다(눈대중 금지).
- `저널 NN건 로드` 가 나온다. `저널을 읽을 수 없다` 면 배포를 멈추고 원인을 찾는다
- `052690` 은 이미 격리돼 있으므로 `[격리됨] 한전기술(052690)` 로 나온다
- `판정보류 0` 이다. 0 이 아니면 배포를 멈춘다
- `※ 이 스크립트는 아무 파일도 쓰지 않는다.` 로 끝난다

쓰기가 없었는지 사후 확인:

```bash
ssh -i ~/.ssh/oracle-vm ubuntu@134.185.111.69 "cd ~/krxdata && ls -la .bot-exclude-auto.json 2>&1; cat .bot-exclude.json"
```
Expected: `.bot-exclude-auto.json` 은 **아직 없다**(진단은 쓰지 않는다). `.bot-exclude.json` 은 `["000270","009150","486990","052690"]` 그대로다.

- [ ] **Step 4: telegram-agent 먼저 재시작하고 요청 채널을 실측한다**

```bash
cd C:/claudeT/files && bash vm.sh bot-restart
```

텔레그램에서 `격리해제 한전기술` 을 보낸다.
Expected: `📨 격리해제 요청 접수` 응답이 오고, 다음이 파일에 남는다:

```bash
ssh -i ~/.ssh/oracle-vm ubuntu@134.185.111.69 "cat ~/krxdata/.tg-requests.jsonl"
```
Expected: `{"ts":"...","type":"unquarantine","code":"052690","name":"한전기술"}` 한 줄.
**stock-live 가 정지 상태라 아직 처리되지 않는다 — 이게 정상이다**(다음 스텝에서 기동하면 소비된다).

- [ ] **Step 5: stock-live 기동 + 종단 확인**

```bash
ssh -i ~/.ssh/oracle-vm ubuntu@134.185.111.69 "sudo systemctl start stock-live && sleep 60 && systemctl is-active stock-live"
```
Expected: `active`

```bash
ssh -i ~/.ssh/oracle-vm ubuntu@134.185.111.69 "sudo journalctl -u stock-live --since '-3 minutes' --no-pager | grep -E '자동 격리|meta 복원|격리해제|소유 판정 보류|보유판정'"
```
Expected:
- `격리해제 거부 052690(한전기술)` 이 나온다 (봇이 산 적 없으므로 D8 대로 거부). 텔레그램으로도 거부 사유가 도착한다.
- `보유판정 0종목` 또는 격리된 종목이 items 에서 빠진 상태가 유지된다.
- `소유 판정 보류` 는 나오지 않는다.

커서가 전진했는지 확인:

```bash
ssh -i ~/.ssh/oracle-vm ubuntu@134.185.111.69 "node -e \"console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/krxdata/stock-live-state.json','utf8')).tgReqCursor)\""
```
Expected: `{ lines: 1 }`

- [ ] **Step 6: 커밋 + PR**

```bash
cd C:/claudeT/files
git add -A
git commit -m "chore: 예약청산 소유권 가드 배포 검증"
git push -u origin fix/reserved-exit-ownership-guards
```

---

## 실행 후 확인이 남는 것 (미검증으로 남긴다)

- **AI 청산 제안 → 승인 → 예약 → 집행** 전 구간은 AI 가 실제로 sell 을 낼 때까지 라이브 관측이 없다. `.no-buy: ALL` 이라 보유가 늘지 않아 제안 자체가 드물다. 첫 제안이 뜨면 그때가 첫 실측이다.
- **`meta 복원` 경로**는 현재 저널에 미청산 BUY 가 없어 라이브에서 발화하지 않는다(전부 청산됨). 단위테스트로만 검증된 상태다.
- **`exitQty` 상한**은 예약이 걸린 포지션이 생겨야 라이브 발화한다. 단위테스트로 08-26 시나리오를 정확히 재현했으나 라이브 관측은 0건이다.
