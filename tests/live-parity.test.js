import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLiveCandidates,
  liveCandidateBudget,
} from '../live-parity.mjs';
import { LIVE_UNIVERSE_LIMIT } from '../strategy-contract.mjs';

test('live parity universe is configured as market-cap top 40', () => {
  assert.equal(LIVE_UNIVERSE_LIMIT, 40);
});

test('buildLiveCandidates uses the live regime gates and conviction ordering', () => {
  const rows = [
    { code: 'A', rsi: 1, breakoutPct: 0, sector: 'IT' },
    { code: 'B', rsi: 50, breakoutPct: 8, sector: '산업재' },
    { code: 'C', rsi: 0, breakoutPct: 0, sector: '금융' },
  ];

  const up = buildLiveCandidates(rows, { regime: 'UP', rsiMax: 10, minBreakout: 3 });
  assert.deepEqual(up.map(({ code, sub, conviction }) => ({ code, sub, conviction })), [
    { code: 'A', sub: 'rsi2', conviction: 9 },
    { code: 'B', sub: 'hi120', conviction: 8 },
    { code: 'C', sub: 'rsi2', conviction: 10 },
  ].sort((a, b) => b.conviction - a.conviction || (a.sub === 'hi120' ? -1 : 1)));

  const neutral = buildLiveCandidates(rows, { regime: 'NEUTRAL', rsiMax: 10, minBreakout: 3 });
  assert.equal(neutral.some(c => c.sub === 'hi120'), false);
  assert.equal(neutral.find(c => c.code === 'C').conviction, 8.5);
});

test('buildLiveCandidates can remove UP-regime rsi2 without changing other regimes', () => {
  const rows = [{ code: 'A', rsi: 0, breakoutPct: 4, sector: 'IT' }];

  const up = buildLiveCandidates(rows, { regime: 'UP', allowUpRsi: false });
  assert.deepEqual(up.map(c => c.sub), ['hi120']);

  const neutral = buildLiveCandidates(rows, { regime: 'NEUTRAL', allowUpRsi: false });
  assert.deepEqual(neutral.map(c => c.sub), ['rsi2']);
});

test('liveCandidateBudget matches live per-slot and strong-conviction sizing', () => {
  const common = { cash: 800_000, equity: 900_000, slots: 3, strongThreshold: 7, strongFraction: 0.5 };
  assert.equal(liveCandidateBudget({ ...common, conviction: 6.9 }), 300_000);
  assert.equal(liveCandidateBudget({ ...common, conviction: 7 }), 400_000);
  assert.equal(liveCandidateBudget({ ...common, cash: 200_000, conviction: 6 }), 200_000);
});

test('liveCandidateBudget applies a research-only exposure multiplier when supplied', () => {
  assert.equal(liveCandidateBudget({
    cash: 800_000,
    equity: 900_000,
    slots: 3,
    conviction: 7,
    strongThreshold: 7,
    strongFraction: 0.5,
    exposureMultiplier: 0.5,
  }), 200_000);
});
