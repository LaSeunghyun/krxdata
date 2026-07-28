import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchReport, validateResearchSummary } from '../research-report.mjs';

const summary = {
  generatedAt: '2026-07-22T00:00:00.000Z',
  assumptions: { initialCapital: 6_000_000, targetCapital: 100_000_000, targetYears: 5, requiredCagr: 75.54 },
  dataQuality: { start: '20210929', end: '20260612', pointInTimeUniverse: false, includesDelisted: false, survivorshipBias: true },
  candidates: [
    { id: 'A1', name: 'combo', grade: 'REJECTED', base: { cagr: 12.3, mdd: 20, finalCapital: 9_000_000 }, mc: { medianMdd: 22, worstMdd: 31 }, stress: { finalCapital: 5_000_000, mdd: 35 }, reachProbability: 0, failureReasons: ['CAGR 75.54% 미달'] },
  ],
  portfolios: [],
};

test('validateResearchSummary rejects non-finite metrics', () => {
  assert.doesNotThrow(() => validateResearchSummary(summary));
  assert.throws(
    () => validateResearchSummary({ ...summary, candidates: [{ ...summary.candidates[0], base: { ...summary.candidates[0].base, cagr: Number.NaN } }] }),
    /finite/,
  );
});

test('buildResearchReport exposes the target, data limitation and candidate verdict', () => {
  const report = buildResearchReport(summary);
  assert.match(report, /75\.54%/);
  assert.match(report, /생존편향/);
  assert.match(report, /REJECTED/);
  assert.match(report, /1억원 도달률/);
  assert.match(report, /탈락 사유/);
  assert.match(report, /CAGR 75\.54% 미달/);
});
