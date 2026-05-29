// 원시 팩터 계산 — 순수 함수. fin = parseFinancials() 결과.
// 각 항목 {current, previous, before} 또는 null. cfOps = number|null.

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function valueFactors(fin, marketCap) {
  const ni = fin?.netIncome?.current;
  const eq = fin?.totalEquity?.current;
  const mc = num(marketCap);
  const per = num(ni) !== null && num(ni) > 0 && mc !== null && mc > 0 ? mc / ni : null;
  const pbr = num(eq) !== null && num(eq) > 0 && mc !== null && mc > 0 ? mc / eq : null;
  return { per, pbr };
}

export function qualityFactors(fin) {
  const ni = num(fin?.netIncome?.current);
  const eq = num(fin?.totalEquity?.current);
  const debt = num(fin?.totalDebt?.current);
  const ca = num(fin?.curAsset?.current);
  const cl = num(fin?.curLiab?.current);
  const cf = fin?.cfOps;

  const roe = ni !== null && eq !== null && ni > 0 && eq > 0 ? (ni / eq) * 100 : null;
  const debtRatio = eq !== null && eq > 0 && debt !== null ? (debt / eq) * 100 : null;
  const curRatio = cl !== null && cl > 0 && ca !== null ? (ca / cl) * 100 : null;
  const cfPositive = cf == null ? null : (cf > 0 ? 1 : 0);

  return { roe, debtRatio, curRatio, cfPositive };
}

export function quarterlyYoY(currentQ, yearAgoQ) {
  if (yearAgoQ > 0) return ((currentQ - yearAgoQ) / yearAgoQ) * 100;
  if (yearAgoQ === 0) return null;
  // yearAgoQ < 0
  if (currentQ > 0) return 999; // 흑자전환
  return ((currentQ - yearAgoQ) / Math.abs(yearAgoQ)) * 100;
}

export function sameQuarterYoY(quarterRows) {
  if (!Array.isArray(quarterRows) || quarterRows.length === 0) return null;
  // 가장 최근 (year, quarter)
  const sorted = quarterRows
    .slice()
    .sort((a, b) => (b.year - a.year) || (b.quarter - a.quarter));
  const latest = sorted[0];
  const prior = quarterRows.find(
    (r) => r.year === latest.year - 1 && r.quarter === latest.quarter,
  );
  if (!prior) return null;
  return { current: latest.value, yearAgo: prior.value };
}
