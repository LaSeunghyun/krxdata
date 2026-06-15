import test from 'node:test';
import assert from 'node:assert/strict';
import { pickBuyCandidates, allocateSlots } from '../slot-alloc.js';

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

const cand = (code, price, atrMult = 1) => ({ code, name: code, close: price, price, atrMult, breakoutPct: 5 });

test('allocateSlots: 빈 슬롯 2개를 후보 2종목으로 분산', () => {
  const out = allocateSlots([cand('A', 19000), cand('B', 19000)], 0, 2, 46000, 46000);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(a => a.code), ['A', 'B']);
  assert.equal(out[0].qty, 1);
});

test('allocateSlots: 보유 1슬롯이면 1종목만 추가 (SLOTS 상한)', () => {
  const out = allocateSlots([cand('A', 19000), cand('B', 19000)], 1, 2, 46000, 46000);
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'A');
});

test('allocateSlots: 매수가능금액 부족하면 살 수 있는 만큼, 다음 후보로', () => {
  const out = allocateSlots([cand('A', 19000), cand('B', 19000)], 0, 2, 46000, 25000);
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'A');
});

test('allocateSlots: 1주도 못 사면 스킵(현금 보유), 빈 배열', () => {
  const out = allocateSlots([cand('A', 30000)], 0, 2, 46000, 10000);
  assert.deepEqual(out, []);
});

test('allocateSlots: atrMult가 슬롯예산에 곱해짐 (backtest 정합)', () => {
  const out = allocateSlots([cand('A', 10000, 0.5)], 0, 2, 46000, 46000);
  assert.equal(out[0].qty, 1);
});
