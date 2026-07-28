import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDrawdownStop,
  blockBootstrap,
  classifyResearchResult,
  combineBarbell,
  profitFactor,
  researchFailureReasons,
  summarizeCurve,
  summarizeMonteCarlo,
} from '../research-metrics.mjs';

const curve = (values, start = new Date('2024-01-02T00:00:00Z')) => values.map((equity, index) => {
  const day = new Date(start);
  day.setUTCDate(day.getUTCDate() + index);
  return { day: day.toISOString().slice(0, 10).replaceAll('-', ''), equity };
});

test('summarizeCurve calculates calendar CAGR and maximum drawdown', () => {
  const result = summarizeCurve([
    { day: '20240102', equity: 100 },
    { day: '20240702', equity: 80 },
    { day: '20250102', equity: 121 },
  ], 100);
  assert.ok(result.cagr > 20 && result.cagr < 22);
  assert.equal(result.mdd, 20);
  assert.equal(result.finalCapital, 121);
});

test('profitFactor uses gross wins divided by absolute gross losses', () => {
  assert.equal(profitFactor([{ pnl: 10 }, { pnl: -4 }, { pnl: 2 }, { pnl: -2 }]), 2);
  assert.equal(profitFactor([{ pnl: 10 }]), Infinity);
});

test('combineBarbell stops the satellite at 35 percent sleeve drawdown', () => {
  const core = curve([100, 100, 100]);
  const satellite = curve([100, 60, 120]);
  const result = combineBarbell(core, satellite, { initialCapital: 600, satelliteStopMdd: 35 });
  assert.equal(result.satelliteStopped, true);
  assert.equal(result.curve.at(-1).equity, 520);
});

test('combineBarbell rejects curves with different dates', () => {
  assert.throws(
    () => combineBarbell([{ day: '20240102', equity: 100 }], [{ day: '20240103', equity: 100 }]),
    /aligned/,
  );
});

test('applyDrawdownStop freezes the sleeve after the configured drawdown', () => {
  const result = applyDrawdownStop(curve([100, 120, 75, 150]), 35);
  assert.equal(result.stopped, true);
  assert.deepEqual(result.curve.map(row => row.equity), [100, 120, 75, 75]);
});

test('blockBootstrap is deterministic and produces requested five-year length', () => {
  const source = curve([100, 101, 99, 102, 103, 101]);
  const first = blockBootstrap(source, { initialCapital: 100, days: 20, blockSize: 2, seed: 7 });
  const second = blockBootstrap(source, { initialCapital: 100, days: 20, blockSize: 2, seed: 7 });
  assert.deepEqual(first, second);
  assert.equal(first.length, 21);
  assert.equal(first[0].equity, 100);
  assert.equal(first.every(row => Number.isFinite(row.equity) && row.equity > 0), true);
});

test('blockBootstrap maps 1240 trading days to approximately five calendar years', () => {
  const source = curve([100, 101, 102, 103, 104, 105]);
  const sampled = blockBootstrap(source, { initialCapital: 100, days: 248 * 5, blockSize: 2, seed: 1 });
  const summary = summarizeCurve(sampled, 100);
  assert.ok(summary.years > 4.99 && summary.years < 5.01);
});

test('summarizeMonteCarlo reports median, worst and ruin seeds', () => {
  const result = summarizeMonteCarlo([
    { mdd: 10, cagr: 30, finalCapital: 10 },
    { mdd: 20, cagr: 40, finalCapital: 1 },
    { mdd: 90, cagr: -50, finalCapital: 0.1 },
  ]);
  assert.equal(result.medianMdd, 20);
  assert.equal(result.worstMdd, 90);
  assert.equal(result.ruinSeeds, 1);
  assert.equal(result.medianCagr, 30);
});

const passingMetrics = {
  initialCapital: 6_000_000,
  cagr: 80,
  mcMedianMdd: 15,
  mcWorstMdd: 25,
  stressMdd: 30,
  stressFinal: 6_100_000,
  ruinSeeds: 0,
  shadowDays: 60,
};

const passingData = {
  pointInTimeUniverse: true,
  includesDelisted: true,
  start: '20150101',
};

test('classifyResearchResult blocks LIVE_ELIGIBLE when point-in-time data is absent', () => {
  assert.equal(
    classifyResearchResult(passingMetrics, { ...passingData, pointInTimeUniverse: false }),
    'SHADOW_ONLY',
  );
});

test('classifyResearchResult rejects risk failures before return and data gates', () => {
  assert.equal(
    classifyResearchResult({ ...passingMetrics, mcWorstMdd: 31 }, passingData),
    'REJECTED',
  );
});

test('classifyResearchResult only allows LIVE_ELIGIBLE after every gate', () => {
  assert.equal(classifyResearchResult(passingMetrics, passingData), 'LIVE_ELIGIBLE');
  assert.equal(classifyResearchResult({ ...passingMetrics, cagr: 70 }, passingData), 'SHADOW_ONLY');
});

test('researchFailureReasons lists every failed return, risk, data and shadow gate', () => {
  const reasons = researchFailureReasons({
    ...passingMetrics,
    cagr: 70,
    mcWorstMdd: 31,
    stressFinal: 5_900_000,
    shadowDays: 0,
  }, { ...passingData, pointInTimeUniverse: false });
  assert.deepEqual(reasons, [
    'CAGR 75.54% 미달',
    'MC 최악 MDD 30% 초과',
    '비용 스트레스 원금 미보전',
    'point-in-time 유니버스 미충족',
    'shadow 60거래일 미충족',
  ]);
});
