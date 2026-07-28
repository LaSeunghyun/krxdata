export function absoluteTrendOn(closes, index, lookback = 120) {
  if (!Array.isArray(closes) || index < lookback - 1 || index >= closes.length) return false;
  const window = closes.slice(index - lookback + 1, index + 1);
  if (window.length !== lookback || window.some(value => !Number.isFinite(value))) return false;
  const average = window.reduce((sum, value) => sum + value, 0) / window.length;
  return closes[index] > average;
}

export function hi120RegimeAllows(regime, gate = 'all') {
  if (gate === 'all') return true;
  if (gate === 'up') return regime === 'UP';
  throw new Error(`unsupported hi120 regime gate: ${gate}`);
}

export function selectMomentumLeaders(rows, limit = 3) {
  return rows
    .filter(row => Number.isFinite(row?.momentum) && row.momentum > 0)
    .sort((a, b) => b.momentum - a.momentum || String(a.code).localeCompare(String(b.code)))
    .slice(0, limit);
}

export function marketSeriesIndex(dates, day) {
  let low = 0;
  let high = dates.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (dates[middle] <= day) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}
