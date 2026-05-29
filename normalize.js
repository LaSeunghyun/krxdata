// 섹터 횡단면 정규화 — 모든 함수는 입력을 변형하지 않는다(no mutation).
// 비유한값(NaN/Infinity/null/undefined)은 결측으로 취급. 반환값은 항상 유한.

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);

export function mean(values) {
  const xs = values.filter(isFiniteNum);
  if (xs.length === 0) return 0;
  let s = 0;
  for (const v of xs) s += v;
  return s / xs.length;
}

export function std(values) {
  const xs = values.filter(isFiniteNum);
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const v of xs) acc += (v - m) * (v - m);
  const variance = acc / xs.length; // 모집단(population, /n)
  if (variance <= 0) return 0;
  return Math.sqrt(variance);
}

// R-7 선형보간 분위수. s = 오름차순 정렬 배열.
function quantileSorted(s, p) {
  const n = s.length;
  if (n === 0) return NaN;
  if (n === 1) return s[0];
  const idx = p * (n - 1);
  const i = Math.floor(idx);
  const frac = idx - i;
  if (i + 1 >= n) return s[n - 1];
  return s[i] + frac * (s[i + 1] - s[i]);
}

export function winsorize(values, lowerP = 0.01, upperP = 0.99) {
  const finite = values.filter(isFiniteNum);
  if (finite.length === 0) return values.slice();
  const sorted = finite.slice().sort((a, b) => a - b);
  const lo = quantileSorted(sorted, lowerP);
  const hi = quantileSorted(sorted, upperP);
  return values.map((v) => {
    if (!isFiniteNum(v)) return v;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  });
}

export function sectorZScores(rows, valueKey, sectorKey, opts = {}) {
  const winsor = opts.winsor === undefined ? [0.01, 0.99] : opts.winsor;

  // 섹터별 유한값 수집
  const bySector = new Map();
  for (const row of rows) {
    const sec = row[sectorKey];
    const raw = row[valueKey];
    if (!bySector.has(sec)) bySector.set(sec, []);
    if (isFiniteNum(raw)) bySector.get(sec).push(raw);
  }

  // 섹터별 mean/std 산출 (옵션 winsorize 후)
  const stats = new Map();
  for (const [sec, vals] of bySector) {
    let arr = vals;
    if (winsor && arr.length > 0) arr = winsorize(arr, winsor[0], winsor[1]);
    stats.set(sec, { m: mean(arr), s: std(arr) });
  }

  return rows.map((row) => {
    const raw = row[valueKey];
    if (!isFiniteNum(raw)) return 0; // 결측 → 섹터 중립
    const { s, m } = stats.get(row[sectorKey]);
    if (s === 0) return 0; // 무분산 섹터 → 0
    const z = (raw - m) / s;
    return Number.isFinite(z) ? z : 0;
  });
}
