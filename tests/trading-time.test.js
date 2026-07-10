import test from 'node:test';
import assert from 'node:assert/strict';
import { toUtcIso, toKstDateKey, toKstTimeLabel, kstDayRange } from '../trading-time.mjs';

test('toUtcIso preserves an already-UTC timestamp', () => {
  assert.equal(toUtcIso(new Date('2026-07-10T00:00:00.000Z')), '2026-07-10T00:00:00.000Z');
});

test('toKstDateKey formats Asia/Seoul day keys', () => {
  assert.equal(toKstDateKey(new Date('2026-07-10T00:00:00.000Z')), '20260710');
});

test('toKstTimeLabel formats Asia/Seoul time labels', () => {
  assert.equal(toKstTimeLabel(new Date('2026-07-10T00:00:00.000Z')), '09:00');
});

test('kstDayRange returns explicit KST boundaries', () => {
  const [start, end] = kstDayRange('2026-07-10');
  assert.equal(start.toISOString(), '2026-07-09T15:00:00.000Z');
  assert.equal(end.toISOString(), '2026-07-10T15:00:00.000Z');
});
