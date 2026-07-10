import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKTEST_COMBO_CAPS, LIVE_COMBO_CAPS, LIVE_MAX_ORDER_VALUE, LIVE_MAX_ORDERS_PER_DAY, LIVE_SLOTS, LIVE_RSI2_UNIVERSE_LIMIT } from '../strategy-contract.mjs';

test('live combo caps stay on the validated conservative preset', () => {
  assert.deepEqual(LIVE_COMBO_CAPS, {
    UP: { hi120: 6, rsi2: 4 },
    NEUTRAL: { hi120: 0, rsi2: 8 },
    DOWN: { hi120: 0, rsi2: 4 },
  });
});

test('backtest combo caps match the live contract', () => {
  assert.deepEqual(BACKTEST_COMBO_CAPS, LIVE_COMBO_CAPS);
});

test('live execution constants stay small-account safe', () => {
  assert.equal(LIVE_MAX_ORDER_VALUE, 100_000);
  assert.equal(LIVE_MAX_ORDERS_PER_DAY, 3);
  assert.equal(LIVE_SLOTS, 2);
  assert.equal(LIVE_RSI2_UNIVERSE_LIMIT, 30);
});
