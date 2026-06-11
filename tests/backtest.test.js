import test from 'node:test';
import assert from 'node:assert/strict';
import {
  spearmanIC, excessReturn, pointInTimeFinancials, alignForward, quantileSpread,
  latestFinancialAsOf, hasExtremeGap, estimateRceptDt,
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

test('latestFinancialAsOf: asOf 이전 최신 공시분 선택 (look-ahead 차단)', () => {
  const rows = [
    { analysis_year: 2024, rcept_dt: '20250331', v: 'fy24' },
    { analysis_year: 2025, rcept_dt: '20260331', v: 'fy25' },
  ];
  assert.equal(latestFinancialAsOf(rows, '20250801').v, 'fy24'); // FY2025는 미래
  assert.equal(latestFinancialAsOf(rows, '20260401').v, 'fy25');
  assert.equal(latestFinancialAsOf(rows, '20260331').v, 'fy25'); // 경계 포함
  assert.equal(latestFinancialAsOf(rows, '20250101'), null);     // 둘 다 미래
});

test('latestFinancialAsOf: rcept_dt 없는 행 무시, 빈 입력 null', () => {
  assert.equal(latestFinancialAsOf([{ analysis_year: 2025, rcept_dt: null }], '20260601'), null);
  assert.equal(latestFinancialAsOf([], '20260601'), null);
  assert.equal(latestFinancialAsOf(null, '20260601'), null);
});

test('hasExtremeGap: |일간변동| > 35% → corporate action 의심', () => {
  assert.equal(hasExtremeGap([100, 130, 130], 0, 2), false);      // 상한가 30%는 정상
  assert.equal(hasExtremeGap([100, 50, 50], 0, 2), true);         // -50% 액면분할 의심
  assert.equal(hasExtremeGap([100, 100, 100, 200], 0, 2), false); // 구간 밖 갭 무시
  assert.equal(hasExtremeGap([100, 0, 100], 0, 2), true);         // 비정상가 0
});

test('estimateRceptDt: 보고서별 보수적 공시 추정일', () => {
  assert.equal(estimateRceptDt(2024, '11011'), '20250401'); // 사업보고서 → 익년 4/1
  assert.equal(estimateRceptDt(2025, '11013'), '20250516'); // 1분기 → 5/16
  assert.equal(estimateRceptDt(2025, '11012'), '20250815'); // 반기 → 8/15
  assert.equal(estimateRceptDt(2025, '11014'), '20251115'); // 3분기 → 11/15
});
