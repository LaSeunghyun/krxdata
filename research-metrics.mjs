function parseDay(day) {
  const text = String(day);
  return Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = state + 0x6D2B79F5 | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function summarizeCurve(curve, initialCapital) {
  if (!Array.isArray(curve) || curve.length === 0) {
    return { finalCapital: initialCapital, cagr: 0, mdd: 0, years: 0 };
  }
  let peak = initialCapital;
  let mdd = 0;
  for (const row of curve) {
    if (!Number.isFinite(row.equity) || row.equity <= 0) throw new Error('curve equity must be positive and finite');
    peak = Math.max(peak, row.equity);
    mdd = Math.max(mdd, (peak - row.equity) / peak * 100);
  }
  const elapsedDays = Math.max(1, (parseDay(curve.at(-1).day) - parseDay(curve[0].day)) / 86_400_000);
  const years = elapsedDays / 365.2425;
  const finalCapital = curve.at(-1).equity;
  const cagr = (Math.pow(finalCapital / initialCapital, 1 / years) - 1) * 100;
  return { finalCapital, cagr, mdd, years };
}

export function profitFactor(trades) {
  const grossWins = trades.filter(trade => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLosses = -trades.filter(trade => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0);
  return grossLosses === 0 ? (grossWins > 0 ? Infinity : 0) : grossWins / grossLosses;
}

export function combineBarbell(coreCurve, satelliteCurve, {
  initialCapital = 6_000_000,
  satelliteStopMdd = Infinity,
} = {}) {
  if (!coreCurve.length || coreCurve.length !== satelliteCurve.length) throw new Error('curves must be aligned');
  for (let index = 0; index < coreCurve.length; index++) {
    if (coreCurve[index].day !== satelliteCurve[index].day) throw new Error('curves must be aligned');
  }

  let core = initialCapital * 2 / 3;
  let satellite = initialCapital / 3;
  let satellitePeak = satellite;
  let satelliteStopped = false;
  let previousQuarter = null;
  const combined = [];

  for (let index = 0; index < coreCurve.length; index++) {
    if (index > 0) {
      core *= coreCurve[index].equity / coreCurve[index - 1].equity;
      if (!satelliteStopped) satellite *= satelliteCurve[index].equity / satelliteCurve[index - 1].equity;
    }

    satellitePeak = Math.max(satellitePeak, satellite);
    const satelliteMdd = satellitePeak > 0 ? (satellitePeak - satellite) / satellitePeak * 100 : 100;
    if (!satelliteStopped && satelliteMdd >= satelliteStopMdd) satelliteStopped = true;

    const month = Number(coreCurve[index].day.slice(4, 6));
    const quarter = `${coreCurve[index].day.slice(0, 4)}Q${Math.ceil(month / 3)}`;
    if (!satelliteStopped && previousQuarter && quarter !== previousQuarter) {
      const total = core + satellite;
      core = total * 2 / 3;
      satellite = total / 3;
      satellitePeak = satellite;
    }
    previousQuarter = quarter;
    combined.push({ day: coreCurve[index].day, equity: core + satellite });
  }

  return { curve: combined, satelliteStopped };
}

export function applyDrawdownStop(curve, stopMdd = 35) {
  if (!curve.length) return { curve: [], stopped: false };
  let peak = curve[0].equity;
  let frozenEquity = null;
  const stoppedCurve = curve.map(row => {
    if (frozenEquity != null) return { day: row.day, equity: frozenEquity };
    peak = Math.max(peak, row.equity);
    const drawdown = peak > 0 ? (peak - row.equity) / peak * 100 : 100;
    if (drawdown >= stopMdd) frozenEquity = row.equity;
    return { day: row.day, equity: row.equity };
  });
  return { curve: stoppedCurve, stopped: frozenEquity != null };
}

export function blockBootstrap(curve, {
  initialCapital = 6_000_000,
  days = 248 * 5,
  blockSize = 20,
  seed = 1,
} = {}) {
  if (curve.length < 2) throw new Error('block bootstrap needs at least two curve points');
  const returns = [];
  for (let index = 1; index < curve.length; index++) returns.push(curve[index].equity / curve[index - 1].equity - 1);
  const rng = mulberry32(seed);
  const output = [{ day: '20000101', equity: initialCapital }];
  let equity = initialCapital;
  let produced = 0;
  while (produced < days) {
    const maxStart = Math.max(0, returns.length - blockSize);
    const start = Math.floor(rng() * (maxStart + 1));
    for (let offset = 0; offset < blockSize && produced < days && start + offset < returns.length; offset++) {
      equity *= 1 + returns[start + offset];
      produced++;
      const syntheticDate = new Date(Date.UTC(2000, 0, 1) + produced * (365.2425 / 248) * 86_400_000);
      output.push({ day: syntheticDate.toISOString().slice(0, 10).replaceAll('-', ''), equity });
    }
  }
  return output;
}

export function summarizeMonteCarlo(runs) {
  if (!runs.length) return { medianMdd: null, worstMdd: null, medianCagr: null, worstCagr: null, ruinSeeds: 0 };
  return {
    medianMdd: median(runs.map(run => run.mdd)),
    worstMdd: Math.max(...runs.map(run => run.mdd)),
    medianCagr: median(runs.map(run => run.cagr)),
    worstCagr: Math.min(...runs.map(run => run.cagr)),
    ruinSeeds: runs.filter(run => run.mdd >= 80 || run.finalCapital <= 0).length,
  };
}

export function classifyResearchResult(metrics, dataQuality) {
  const riskPass = metrics.mcMedianMdd <= 20
    && metrics.mcWorstMdd <= 30
    && metrics.stressMdd <= 35
    && metrics.stressFinal >= metrics.initialCapital
    && metrics.ruinSeeds === 0;
  if (!riskPass) return 'REJECTED';

  const returnPass = metrics.cagr >= 75.54;
  const dataPass = dataQuality.pointInTimeUniverse
    && dataQuality.includesDelisted
    && String(dataQuality.start) <= '20160101';
  return returnPass && dataPass && metrics.shadowDays >= 60 ? 'LIVE_ELIGIBLE' : 'SHADOW_ONLY';
}

export function researchFailureReasons(metrics, dataQuality) {
  const reasons = [];
  if (metrics.cagr < 75.54) reasons.push('CAGR 75.54% 미달');
  if (metrics.mcMedianMdd > 20) reasons.push('MC MDD 중앙값 20% 초과');
  if (metrics.mcWorstMdd > 30) reasons.push('MC 최악 MDD 30% 초과');
  if (metrics.stressFinal < metrics.initialCapital) reasons.push('비용 스트레스 원금 미보전');
  if (metrics.stressMdd > 35) reasons.push('비용 스트레스 MDD 35% 초과');
  if (metrics.ruinSeeds > 0) reasons.push('파산 시드 발생');
  if (!dataQuality.pointInTimeUniverse) reasons.push('point-in-time 유니버스 미충족');
  if (!dataQuality.includesDelisted) reasons.push('상장폐지 종목 미포함');
  if (String(dataQuality.start) > '20160101') reasons.push('2016년 이전 데이터 미확보');
  if (metrics.shadowDays < 60) reasons.push('shadow 60거래일 미충족');
  return reasons;
}
