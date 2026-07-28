import test from 'node:test';
import assert from 'node:assert/strict';
import {
  absoluteTrendOn,
  hi120RegimeAllows,
  marketSeriesIndex,
  selectMomentumLeaders,
} from '../research-strategies.mjs';

test('absoluteTrendOn uses no prices after the evaluation index', () => {
  const closes = [80, 90, 100, 110, 120];
  assert.equal(absoluteTrendOn(closes, 4, 3), true);
  assert.equal(absoluteTrendOn([...closes, 1], 4, 3), true);
});

test('absoluteTrendOn returns false with insufficient history', () => {
  assert.equal(absoluteTrendOn([100, 110], 1, 3), false);
});

test('hi120RegimeAllows enforces the optional UP-only gate', () => {
  assert.equal(hi120RegimeAllows('UP', 'up'), true);
  assert.equal(hi120RegimeAllows('NEUTRAL', 'up'), false);
  assert.equal(hi120RegimeAllows('DOWN', 'all'), true);
});

test('selectMomentumLeaders keeps only positive finite scores in descending order', () => {
  const rows = [
    { code: 'A', momentum: 12 },
    { code: 'B', momentum: -1 },
    { code: 'C', momentum: 20 },
    { code: 'D', momentum: Number.NaN },
  ];
  assert.deepEqual(selectMomentumLeaders(rows, 2).map(row => row.code), ['C', 'A']);
});

test('marketSeriesIndex maps the evaluation date to the full cached series', () => {
  const dates = ['20211230', '20220103', '20230102', '20230103'];
  assert.equal(marketSeriesIndex(dates, '20230102'), 2);
  assert.equal(marketSeriesIndex(dates, '20220101'), 0);
});
