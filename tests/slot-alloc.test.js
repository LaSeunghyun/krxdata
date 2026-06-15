import test from 'node:test';
import assert from 'node:assert/strict';
import { pickBuyCandidates } from '../slot-alloc.js';

const sig = (code, breakoutPct) => ({ code, name: code, close: 10000, atrMult: 1, breakoutPct });

test('pickBuyCandidates: badCodes 제외 + maxN 제한', () => {
  const ranked = [sig('A', 5), sig('B', 4), sig('C', 3), sig('D', 2)];
  const out = pickBuyCandidates(ranked, new Set(['B']), 2);
  assert.deepEqual(out.map(c => c.code), ['A', 'C']);
});

test('pickBuyCandidates: 우선순위(입력 순서) 보존', () => {
  const ranked = [sig('A', 1), sig('B', 9)];
  const out = pickBuyCandidates(ranked, new Set(), 5);
  assert.deepEqual(out.map(c => c.code), ['A', 'B']);
});

test('pickBuyCandidates: badCodes 배열도 허용, 빈 입력 안전', () => {
  assert.deepEqual(pickBuyCandidates([], ['X'], 3), []);
  assert.equal(pickBuyCandidates([sig('A', 1)], ['A'], 3).length, 0);
});
