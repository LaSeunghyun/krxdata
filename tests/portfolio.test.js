import test from 'node:test';
import assert from 'node:assert/strict';
import { evalPosition } from '../portfolio.js';

test('evalPosition: -25% 이하 → stop_loss', () => {
  assert.deepEqual(evalPosition(10000, 7500, 'open'), { ret: -25, action: 'stop_loss' });
  assert.equal(evalPosition(10000, 7600, 'open').action, 'hold');
});

test('evalPosition: +100% 이상 & open → half_profit (이미 half_exited면 hold)', () => {
  assert.deepEqual(evalPosition(10000, 20000, 'open'), { ret: 100, action: 'half_profit' });
  assert.equal(evalPosition(10000, 20000, 'half_exited').action, 'hold');
  assert.equal(evalPosition(10000, 6000, 'half_exited').action, 'stop_loss'); // 스톱은 상태 무관
});

test('evalPosition: 비정상 입력 → null', () => {
  assert.equal(evalPosition(0, 100, 'open'), null);
  assert.equal(evalPosition(100, null, 'open'), null);
});
