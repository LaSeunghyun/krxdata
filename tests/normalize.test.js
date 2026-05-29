import test from 'node:test';
import assert from 'node:assert/strict';
import { mean, std, winsorize, sectorZScores } from '../normalize.js';

const close = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

test('mean: 기본/빈배열', () => {
  assert.equal(mean([2, 4, 6]), 4);
  assert.equal(mean([]), 0);
});

test('std: 모집단 표준편차', () => {
  assert.equal(std([2, 4, 4, 4, 5, 5, 7, 9]), 2); // mean5, var4
});

test('std: n<2 또는 분산0 → 0 (NaN 금지)', () => {
  assert.equal(std([5]), 0);
  assert.equal(std([7, 7, 7]), 0);
  assert.equal(std([]), 0);
});

test('winsorize: R-7 분위수로 양끝 clamp, 길이·순서 보존', () => {
  const input = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const out = winsorize(input, 0.1, 0.9);
  assert.deepEqual(out, [10, 10, 20, 30, 40, 50, 60, 70, 80, 90, 90]);
  assert.equal(out.length, input.length);
  // 입력 불변
  assert.equal(input[0], 0);
});

test('sectorZScores: 섹터별 z, 결측·단일섹터·무분산 처리', () => {
  const rows = [
    { sec: 'A', v: 10 },
    { sec: 'A', v: 20 },
    { sec: 'A', v: 30 },
    { sec: 'B', v: 5 },
    { sec: 'B', v: 5 },   // 분산0 → 0
    { sec: 'A', v: null }, // 결측 → 0
  ];
  const z = sectorZScores(rows, 'v', 'sec', { winsor: null });
  assert.ok(close(z[0], -1.2247));
  assert.ok(close(z[1], 0));
  assert.ok(close(z[2], 1.2247));
  assert.equal(z[3], 0);
  assert.equal(z[4], 0);
  assert.equal(z[5], 0);
  // 입력 불변
  assert.equal(rows[5].v, null);
});

test('sectorZScores: NaN/Infinity 절대 미반환', () => {
  const rows = [{ sec: 'X', v: Infinity }, { sec: 'X', v: NaN }, { sec: 'X', v: 1 }];
  const z = sectorZScores(rows, 'v', 'sec', { winsor: null });
  for (const val of z) assert.ok(Number.isFinite(val), `유한값이어야 함: ${val}`);
});
