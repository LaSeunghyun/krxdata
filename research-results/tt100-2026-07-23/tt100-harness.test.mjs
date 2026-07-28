import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFractionalExposure,
  combineBarbellCurves,
  quantileWithCensoring,
  summarizeTt100Path,
} from './tt100-harness.mjs';

test('summarizeTt100Path reports reached day and drawdown thresholds', () => {
  const curve = [
    { day: '20230102', equity: 6_000_000 },
    { day: '20230103', equity: 4_900_000 },
    { day: '20230104', equity: 1_700_000 },
    { day: '20230105', equity: 101_000_000 },
  ];

  const summary = summarizeTt100Path(curve, { initialCapital: 6_000_000, targetCapital: 100_000_000 });

  assert.equal(summary.reached, true);
  assert.equal(summary.tt100TradingDays, 4);
  assert.equal(summary.tt100Day, '20230105');
  assert.equal(summary.hitHalfCapital, true);
  assert.equal(summary.hitSeventyLoss, true);
  assert.equal(Math.round(summary.maxDrawdownPct * 10) / 10, 71.7);
});

test('summarizeTt100Path treats non-reach as right-censored', () => {
  const summary = summarizeTt100Path([
    { day: '20230102', equity: 6_000_000 },
    { day: '20230103', equity: 6_300_000 },
  ], { initialCapital: 6_000_000, targetCapital: 100_000_000 });

  assert.equal(summary.reached, false);
  assert.equal(summary.censored, true);
  assert.equal(summary.tt100TradingDays, null);
  assert.equal(summary.censorTradingDays, 2);
});

test('quantileWithCensoring returns null when events cannot identify the percentile', () => {
  const observations = [
    { reached: true, tt100TradingDays: 10, censorTradingDays: 10 },
    { reached: false, tt100TradingDays: null, censorTradingDays: 20 },
    { reached: false, tt100TradingDays: null, censorTradingDays: 20 },
    { reached: false, tt100TradingDays: null, censorTradingDays: 20 },
  ];

  assert.equal(quantileWithCensoring(observations, 0.25), 10);
  assert.equal(quantileWithCensoring(observations, 0.50), null);
});

test('applyFractionalExposure scales daily returns while keeping initial capital fixed', () => {
  const curve = [
    { day: '20230102', equity: 100 },
    { day: '20230103', equity: 110 },
    { day: '20230104', equity: 99 },
  ];

  assert.deepEqual(applyFractionalExposure(curve, 0.5, 1_000), [
    { day: '20230102', equity: 1_000 },
    { day: '20230103', equity: 1_050 },
    { day: '20230104', equity: 997.5 },
  ]);
});

test('combineBarbellCurves freezes satellite sleeve after kill-switch drawdown', () => {
  const core = [
    { day: '20230102', equity: 100 },
    { day: '20230103', equity: 110 },
    { day: '20230104', equity: 121 },
  ];
  const satellite = [
    { day: '20230102', equity: 100 },
    { day: '20230103', equity: 50 },
    { day: '20230104', equity: 200 },
  ];

  const result = combineBarbellCurves(core, satellite, {
    initialCapital: 1_000,
    coreWeight: 0.6,
    satelliteStopMddPct: 35,
  });

  assert.equal(result.satelliteStopped, true);
  assert.deepEqual(result.curve.map(row => Math.round(row.equity)), [1_000, 860, 926]);
});
