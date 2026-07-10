import test from 'node:test';
import assert from 'node:assert/strict';
import { realizedVolatility, volatilityThrottleMultiplier, volatilityThrottleSeries } from '../volatility-throttle.mjs';

const makeCloses = () => {
  const closes = [];
  let px = 100;
  for (let i = 0; i < 260; i++) {
    px *= 1 + (i % 2 === 0 ? 0.001 : -0.0008);
    closes.push(px);
  }
  for (let i = 0; i < 40; i++) {
    px *= 1 + (i % 2 === 0 ? 0.03 : -0.025);
    closes.push(px);
  }
  return closes;
};

test('realizedVolatility uses only the trailing window', () => {
  const closes = makeCloses();
  const a = realizedVolatility(closes, 280, 20);
  const b = realizedVolatility([...closes.slice(0, 281), ...Array(20).fill(9999)], 280, 20);
  assert.equal(a, b);
});

test('volatilityThrottleMultiplier stays within [0, 1] and drops in high-volatility regimes', () => {
  const closes = makeCloses();
  const low = volatilityThrottleMultiplier(closes, 100, { volWindow: 20, refLookback: 120 });
  const high = volatilityThrottleMultiplier(closes, 290, { volWindow: 20, refLookback: 252 });
  assert.equal(low <= 1 && low >= 0, true);
  assert.equal(high <= 1 && high >= 0, true);
  assert.ok(high < low);
});

test('volatilityThrottleSeries returns a full-length series', () => {
  const closes = makeCloses();
  const series = volatilityThrottleSeries(closes, { volWindow: 20, refLookback: 252 });
  assert.equal(series.length, closes.length);
  assert.equal(series.every(v => v <= 1 && v >= 0), true);
});
