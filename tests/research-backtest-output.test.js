import test from 'node:test';
import assert from 'node:assert/strict';
import { recordDailyEquity, serializeResearchBook } from '../research-backtest-output.mjs';

test('recordDailyEquity records only the supplied day and finite equity', () => {
  const book = { daily: [] };
  recordDailyEquity(book, '20250102', 6_100_000);
  assert.deepEqual(book.daily, [{ day: '20250102', equity: 6_100_000 }]);
  assert.throws(() => recordDailyEquity(book, '20250103', Number.NaN), /finite/);
});

test('serializeResearchBook returns the research contract without mutable references', () => {
  const book = {
    cash: 6_200_000,
    maxDD: 12.5,
    trades: [{ code: '005930', pnl: 20_000 }],
    daily: [{ day: '20250102', equity: 6_100_000 }],
  };
  const output = serializeResearchBook(book);
  book.trades[0].pnl = -1;
  assert.equal(output.trades[0].pnl, 20_000);
  assert.equal(output.daily.length, 1);
});
