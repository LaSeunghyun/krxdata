import test from 'node:test';
import assert from 'node:assert/strict';
import {
  spearmanIC, excessReturn, pointInTimeFinancials, alignForward, quantileSpread,
} from '../backtest.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('spearmanIC: planted-signal (완전 단조 → ±1)', () => {
  assert.ok(close(spearmanIC([[1, 1], [2, 2], [3, 3], [4, 4]]), 1));
  assert.ok(close(spearmanIC([[1, 4], [2, 3], [3, 2], [4, 1]]), -1));
});

test('spearmanIC: 비선형 단조도 1 (순위 기반)', () => {
  assert.ok(close(spearmanIC([[1, 1], [2, 4], [3, 9]]), 1));
});

test('spearmanIC: 상수축/소표본 → 0 (NaN 금지)', () => {
  assert.equal(spearmanIC([[5, 1], [5, 2], [5, 3]]), 0);
  assert.equal(spearmanIC([[1, 1]]), 0);
  assert.equal(spearmanIC([]), 0);
});

test('excessReturn: 초과수익 = 종목수익 − 벤치수익', () => {
  assert.ok(close(excessReturn(100, 110, 200, 210), 0.05)); // 0.10 - 0.05
});

test('excessReturn: 기준가 0 → null', () => {
  assert.equal(excessReturn(0, 110, 200, 210), null);
  assert.equal(excessReturn(100, 110, 0, 210), null);
});

test('pointInTimeFinancials: rcept_dt <= asOf 만 (look-ahead 차단)', () => {
  const rows = [{ rcept_dt: '20260301', v: 1 }, { rcept_dt: '20260515', v: 2 }];
  const out = pointInTimeFinancials(rows, '20260401');
  assert.equal(out.length, 1);
  assert.equal(out[0].v, 1);
});

test('pointInTimeFinancials: 경계(===) 포함', () => {
  const rows = [{ rcept_dt: '20260401', v: 1 }];
  assert.equal(pointInTimeFinancials(rows, '20260401').length, 1);
});

test('alignForward: 미래 스냅샷만 pN으로 (과거·T자신 금지)', () => {
  const snaps = [
    { stock_code: 'X', date: '2026-01-01', price: 100 },
    { stock_code: 'X', date: '2026-01-26', price: 110 }, // T+25 → pN
    { stock_code: 'X', date: '2025-11-15', price: 90 },  // 과거: pN으로 선택 금지 + 자신의 forward(window)도 비어 출력 없음
  ];
  const out = alignForward(snaps, 25, 5);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { stock_code: 'X', t: '2026-01-01', p0: 100, pN: 110 });
});

test('alignForward: 구간 내 미래 스냅샷 없으면 제외', () => {
  const snaps = [
    { stock_code: 'Y', date: '2026-01-01', price: 100 },
    { stock_code: 'Y', date: '2026-03-01', price: 130 }, // 호라이즌 밖
  ];
  assert.equal(alignForward(snaps, 25, 5).length, 0);
});

test('quantileSpread: 상위q 평균 − 하위q 평균', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ score: i + 1, ret: i + 1 }));
  // 상위20% = score 10,9 (ret 9.5) / 하위20% = score 1,2 (ret 1.5) → 8
  assert.ok(close(quantileSpread(rows, 'score', 'ret', 0.2), 8));
});
