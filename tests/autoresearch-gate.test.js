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
