export function recordDailyEquity(book, day, equity) {
  if (!Number.isFinite(equity)) throw new Error('daily equity must be finite');
  (book.daily ??= []).push({ day: String(day), equity });
}

export function serializeResearchBook(book) {
  return structuredClone({
    cash: book.cash,
    maxDD: book.maxDD,
    trades: book.trades ?? [],
    daily: book.daily ?? [],
  });
}
