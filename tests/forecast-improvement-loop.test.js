import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adjustForecastRow,
  buildImprovementProfile,
  runWalkForwardReplay,
} from '../forecast-improvement-loop.mjs';

function row(id, date, sector, median, actual, extra = {}) {
  return {
    id,
    run_id: `fc_close_${date}`,
    market_layer: 'KRX',
    target_kind: 'market',
    sector,
    target_end_date: date,
    forecast_median: median,
    forecast_low: median - 1,
    forecast_high: median + 1,
    probability_up: 34,
    probability_flat: 32,
    probability_down: 34,
    flat_band: 0.25,
    sigma: 1,
    call_direction: 'no-call',
    baselines: {},
    actual_return: actual,
    structural_miss: Math.abs(actual - median) >= 2,
    ...extra,
  };
}

test('buildImprovementProfile learns capped signed-error bias by segment', () => {
  const rows = [
    row(1, '20260720', 'KOSPI_PROXY', 0, 1),
    row(2, '20260721', 'KOSPI_PROXY', 0, 1),
    row(3, '20260722', 'KOSPI_PROXY', 0, 1),
    row(4, '20260720', 'KOSDAQ_PROXY', 0, -0.4),
    row(5, '20260721', 'KOSDAQ_PROXY', 0, -0.4),
    row(6, '20260722', 'KOSDAQ_PROXY', 0, -0.4),
  ];

  const profile = buildImprovementProfile(rows, {
    minGlobalRows: 4,
    minSegmentRows: 3,
    shrinkage: 0.5,
    maxBiasPp: 0.4,
  });

  assert.equal(profile.status, 'ready');
  assert.equal(profile.global.n, 6);
  assert.equal(profile.segments['KRX|market|daily|KOSPI_PROXY'].n, 3);
  assert.equal(profile.segments['KRX|market|daily|KOSPI_PROXY'].bias_pp, 0.4);
  assert.equal(profile.segments['KRX|market|daily|KOSDAQ_PROXY'].bias_pp, -0.2);
});

test('adjustForecastRow applies shadow bias to median, range, probabilities, and call', () => {
  const profile = buildImprovementProfile([
    row(1, '20260720', 'KOSPI_PROXY', 0, 1),
    row(2, '20260721', 'KOSPI_PROXY', 0, 1),
    row(3, '20260722', 'KOSPI_PROXY', 0, 1),
  ], {
    minGlobalRows: 3,
    minSegmentRows: 3,
    shrinkage: 1,
    maxBiasPp: 1.2,
  });

  const adjusted = adjustForecastRow(row(10, '20260723', 'KOSPI_PROXY', 0, 0.8), profile);

  assert.equal(adjusted.forecast_median, 1);
  assert.equal(adjusted.forecast_low, 0);
  assert.equal(adjusted.forecast_high, 2);
  assert.equal(adjusted.probability_up + adjusted.probability_flat + adjusted.probability_down, 100);
  assert.ok(adjusted.probability_up > adjusted.probability_down);
  assert.equal(adjusted.call_direction, 'up');
  assert.equal(adjusted.improvement.source, 'segment');
});

test('runWalkForwardReplay trains only on prior dates and reports original vs adjusted fit', () => {
  const rows = [
    row(1, '20260720', 'KOSPI_PROXY', 0, 1),
    row(2, '20260720', 'KOSDAQ_PROXY', 0, 1),
    row(3, '20260721', 'KOSPI_PROXY', 0, 1),
    row(4, '20260721', 'KOSDAQ_PROXY', 0, 1),
    row(5, '20260722', 'KOSPI_PROXY', 0, 1),
    row(6, '20260722', 'KOSDAQ_PROXY', 0, 1),
  ];

  const replay = runWalkForwardReplay(rows, {
    minGlobalRows: 4,
    minSegmentRows: 4,
    shrinkage: 0.5,
    maxBiasPp: 1,
    minReplayRows: 2,
  });

  assert.equal(replay.summary.evaluated_n, 2);
  assert.equal(replay.summary.skipped_n, 4);
  assert.equal(replay.summary.original_mae_pp, 1);
  assert.equal(replay.summary.adjusted_mae_pp, 0.5);
  assert.equal(replay.summary.mae_gain_pp, 0.5);
  assert.equal(replay.evaluations.every(e => e.train_n === 4), true);
});
