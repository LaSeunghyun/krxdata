const annualize = (stdev) => stdev * Math.sqrt(252);

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function realizedVolatility(closes, endIndex, window = 20) {
  if (!Array.isArray(closes) || endIndex == null || endIndex < window) return 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let i = endIndex - window + 1; i <= endIndex; i++) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (!(prev > 0) || !(curr > 0)) return 0;
    const r = Math.log(curr / prev);
    sum += r;
    sumSq += r * r;
    count++;
  }
  if (count < 2) return 0;
  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  return annualize(Math.sqrt(variance));
}

export function volatilityThrottleMultiplier(closes, endIndex, {
  volWindow = 20,
  refLookback = 252,
} = {}) {
  const current = realizedVolatility(closes, endIndex, volWindow);
  if (!(current > 0)) return 1;
  const refStart = Math.max(volWindow, endIndex - refLookback);
  const refs = [];
  for (let i = refStart; i < endIndex; i++) {
    const vol = realizedVolatility(closes, i, volWindow);
    if (vol > 0) refs.push(vol);
  }
  const ref = median(refs);
  if (!(ref > 0)) return 1;
  return Math.min(1, ref / current);
}

export function volatilityThrottleSeries(closes, {
  volWindow = 20,
  refLookback = 252,
} = {}) {
  return closes.map((_, i) => volatilityThrottleMultiplier(closes, i, { volWindow, refLookback }));
}
