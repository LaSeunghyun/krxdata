#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const defaultOutputDir = here;
const missingCandleCodes = Object.freeze(['140910', '204210', '230980', '451700', '464680']);
const baselineArgs = Object.freeze([
  '--strategies', 'combo-v2',
  '--live-parity',
  '--skipneutralrsi',
  '--rsivol', '1.25',
  '--slots', '3',
  '--tp1r', '0.5',
  '--tp2r', '1',
]);

const executableCandidates = Object.freeze([
  Object.freeze({
    id: 'A-baseline',
    family: 'A',
    name: 'Baseline live-parity SMA20/60',
    strategy: 'combo-v2',
    args: baselineArgs,
    notes: ['Current live baseline. No deployment action is implied.'],
  }),
  Object.freeze({
    id: 'B-volsurge-sat',
    family: 'B',
    name: 'Satellite volsurge only',
    strategy: 'combo-v2',
    args: Object.freeze([
      '--strategies', 'combo-v2',
      '--live-parity',
      '--skipneutralrsi',
      '--rsivol', '999',
      '--minbreak', '999',
      '--slots', '2',
      '--tp1r', '0.5',
      '--tp2r', '1',
      '--volsurge', '2,2,0.7,2',
    ]),
    notes: ['Research-only satellite; volsurge is not live default.'],
  }),
  Object.freeze({
    id: 'B-hi120-sat',
    family: 'B',
    name: 'Satellite hi120 concentrated',
    strategy: 'combo-v2',
    args: Object.freeze([
      '--strategies', 'combo-v2',
      '--live-parity',
      '--skipneutralrsi',
      '--rsivol', '999',
      '--slots', '2',
      '--tp1r', '0.5',
      '--tp2r', '1',
    ]),
    notes: ['Research-only concentrated breakout sleeve; rsi2 is disabled through an unreachable volume filter.'],
  }),
  Object.freeze({
    id: 'D-no-up-rsi',
    family: 'D',
    name: 'Meta-filter proxy: remove UP rsi2',
    strategy: 'combo-v2',
    args: Object.freeze([...baselineArgs, '--no-up-rsi']),
    notes: ['Research-only proxy for a meta decision to skip one historically weak sub/regime bucket.'],
  }),
]);

const barbellDefinitions = Object.freeze([
  ...[0.6, 0.7, 0.8].map(coreWeight => Object.freeze({
    id: `B-volsurge-${Math.round(coreWeight * 100)}-${Math.round((1 - coreWeight) * 100)}`,
    family: 'B',
    name: `Barbell baseline ${Math.round(coreWeight * 100)} / volsurge ${Math.round((1 - coreWeight) * 100)}`,
    core: 'A-baseline',
    satellite: 'B-volsurge-sat',
    coreWeight,
    satelliteStopMddPct: 35,
  })),
  ...[0.6, 0.7, 0.8].map(coreWeight => Object.freeze({
    id: `B-hi120-${Math.round(coreWeight * 100)}-${Math.round((1 - coreWeight) * 100)}`,
    family: 'B',
    name: `Barbell baseline ${Math.round(coreWeight * 100)} / hi120 ${Math.round((1 - coreWeight) * 100)}`,
    core: 'A-baseline',
    satellite: 'B-hi120-sat',
    coreWeight,
    satelliteStopMddPct: 35,
  })),
]);

const kellyFractions = Object.freeze([0.25, 0.5, 0.75, 1.0]);

function parseArgs(argv) {
  const argOf = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const only = new Set(String(argOf('--only', '')).split(',').map(s => s.trim()).filter(Boolean));
  return {
    from: argOf('--from', '20230102'),
    to: argOf('--to', '20260611'),
    capital: Number(argOf('--capital', '6000000')),
    targetCapital: Number(argOf('--target', '100000000')),
    seeds: Number(argOf('--seeds', '20')),
    subsample: Number(argOf('--subsample', '0.8')),
    blockDays: Number(argOf('--blockdays', String(248 * 15))),
    blockSize: Number(argOf('--blocksize', '20')),
    concurrency: Math.max(1, Number(argOf('--concurrency', '1'))),
    outputDir: resolve(repoRoot, argOf('--out', relative(repoRoot, defaultOutputDir))),
    force: argv.includes('--force'),
    skipRuns: argv.includes('--skip-runs'),
    runOnly: argv.includes('--run-only'),
    only,
  };
}

function median(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function percentile(values, p) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const pos = (nums.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return nums[lo];
  return nums[lo] + (nums[hi] - nums[lo]) * (pos - lo);
}

function pct(count, total) {
  return total ? count / total * 100 : 0;
}

function pathDuration(summary) {
  return summary.reached ? summary.tt100TradingDays : summary.censorTradingDays;
}

export function quantileWithCensoring(observations, quantile) {
  if (!observations.length) return null;
  const rows = observations
    .map(row => ({
      duration: row.reached ? row.tt100TradingDays : row.censorTradingDays,
      event: Boolean(row.reached),
    }))
    .filter(row => Number.isFinite(row.duration) && row.duration > 0)
    .sort((a, b) => a.duration - b.duration);
  let atRisk = rows.length;
  let survival = 1;
  let index = 0;
  while (index < rows.length && atRisk > 0) {
    const duration = rows[index].duration;
    let events = 0;
    let censored = 0;
    while (index < rows.length && rows[index].duration === duration) {
      if (rows[index].event) events++;
      else censored++;
      index++;
    }
    if (events > 0) {
      survival *= 1 - events / atRisk;
      if (1 - survival >= quantile) return duration;
    }
    atRisk -= events + censored;
  }
  return null;
}

export function summarizeTt100Path(curve, {
  initialCapital = 6_000_000,
  targetCapital = 100_000_000,
} = {}) {
  if (!Array.isArray(curve) || !curve.length) throw new Error('curve must not be empty');
  let peak = initialCapital;
  let maxDrawdownPct = 0;
  let reachedAt = null;
  let hitHalfCapital = false;
  let hitSeventyLoss = false;

  curve.forEach((row, index) => {
    const equity = Number(row.equity);
    if (!Number.isFinite(equity) || equity <= 0) throw new Error('curve equity must be positive and finite');
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak * 100 : 100);
    if (equity <= initialCapital * 0.5) hitHalfCapital = true;
    if (equity <= initialCapital * 0.3) hitSeventyLoss = true;
    if (!reachedAt && equity >= targetCapital) {
      reachedAt = { day: String(row.day), tradingDays: index + 1 };
    }
  });

  const totalTradingDays = curve.length;
  const finalCapital = Number(curve.at(-1).equity);
  const years = Math.max(1 / 248, totalTradingDays / 248);
  const cagrPct = (Math.pow(finalCapital / initialCapital, 1 / years) - 1) * 100;
  return {
    firstDay: String(curve[0].day),
    lastDay: String(curve.at(-1).day),
    totalTradingDays,
    finalCapital,
    cagrPct,
    maxDrawdownPct,
    reached: Boolean(reachedAt),
    censored: !reachedAt,
    tt100Day: reachedAt?.day ?? null,
    tt100TradingDays: reachedAt?.tradingDays ?? null,
    censorTradingDays: reachedAt ? reachedAt.tradingDays : totalTradingDays,
    hitHalfCapital,
    hitSeventyLoss,
  };
}

export function applyFractionalExposure(curve, fraction, initialCapital = 6_000_000) {
  if (!Array.isArray(curve) || !curve.length) throw new Error('curve must not be empty');
  if (!Number.isFinite(fraction) || fraction < 0) throw new Error('fraction must be non-negative');
  let equity = initialCapital;
  const output = [{ day: String(curve[0].day), equity }];
  for (let index = 1; index < curve.length; index++) {
    const prev = Number(curve[index - 1].equity);
    const next = Number(curve[index].equity);
    if (!(prev > 0) || !(next > 0)) throw new Error('curve equity must be positive');
    equity *= 1 + (next / prev - 1) * fraction;
    output.push({ day: String(curve[index].day), equity });
  }
  return output;
}

function assertAligned(a, b) {
  if (a.length !== b.length) throw new Error('curves must have the same length');
  for (let index = 0; index < a.length; index++) {
    if (String(a[index].day) !== String(b[index].day)) throw new Error('curves must be aligned by day');
  }
}

function quarterKey(day) {
  const text = String(day);
  const month = Number(text.slice(4, 6));
  return `${text.slice(0, 4)}Q${Math.ceil(month / 3)}`;
}

export function combineBarbellCurves(coreCurve, satelliteCurve, {
  initialCapital = 6_000_000,
  coreWeight = 0.7,
  satelliteStopMddPct = 35,
  rebalance = 'quarterly',
} = {}) {
  if (!Array.isArray(coreCurve) || !coreCurve.length) throw new Error('core curve must not be empty');
  if (!Array.isArray(satelliteCurve) || !satelliteCurve.length) throw new Error('satellite curve must not be empty');
  assertAligned(coreCurve, satelliteCurve);
  if (!(coreWeight > 0 && coreWeight < 1)) throw new Error('coreWeight must be within (0, 1)');

  let core = initialCapital * coreWeight;
  let satellite = initialCapital * (1 - coreWeight);
  let satellitePeak = satellite;
  let satelliteStopped = false;
  let stopDay = null;
  let previousQuarter = quarterKey(coreCurve[0].day);
  const curve = [];

  for (let index = 0; index < coreCurve.length; index++) {
    if (index > 0) {
      core *= Number(coreCurve[index].equity) / Number(coreCurve[index - 1].equity);
      if (!satelliteStopped) {
        satellite *= Number(satelliteCurve[index].equity) / Number(satelliteCurve[index - 1].equity);
      }
    }

    satellitePeak = Math.max(satellitePeak, satellite);
    const satelliteDrawdown = satellitePeak > 0 ? (satellitePeak - satellite) / satellitePeak * 100 : 100;
    if (!satelliteStopped && satelliteDrawdown >= satelliteStopMddPct) {
      satelliteStopped = true;
      stopDay = String(coreCurve[index].day);
    }

    const q = quarterKey(coreCurve[index].day);
    if (!satelliteStopped && rebalance === 'quarterly' && index > 0 && q !== previousQuarter) {
      const total = core + satellite;
      core = total * coreWeight;
      satellite = total * (1 - coreWeight);
      satellitePeak = satellite;
    }
    previousQuarter = q;
    curve.push({ day: String(coreCurve[index].day), equity: core + satellite });
  }

  return { curve, satelliteStopped, stopDay };
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

function syntheticDay(index) {
  const date = new Date(Date.UTC(2000, 0, 1) + index * (365.2425 / 248) * 86_400_000);
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

function blockBootstrapCurve(curve, {
  initialCapital = 6_000_000,
  days = 248 * 15,
  blockSize = 20,
  seed = 1,
} = {}) {
  if (curve.length < 2) throw new Error('block bootstrap needs at least two curve points');
  const returns = [];
  for (let index = 1; index < curve.length; index++) {
    returns.push(Number(curve[index].equity) / Number(curve[index - 1].equity) - 1);
  }
  const rng = mulberry32(seed);
  const output = [{ day: syntheticDay(0), equity: initialCapital }];
  let equity = initialCapital;
  let produced = 0;
  while (produced < days) {
    const maxStart = Math.max(0, returns.length - blockSize);
    const start = Math.floor(rng() * (maxStart + 1));
    for (let offset = 0; offset < blockSize && produced < days && start + offset < returns.length; offset++) {
      equity *= 1 + returns[start + offset];
      produced++;
      output.push({ day: syntheticDay(produced), equity: Math.max(1, equity) });
    }
  }
  return output;
}

function profitFactor(trades) {
  const wins = trades.filter(trade => Number(trade.pnl) > 0).reduce((sum, trade) => sum + Number(trade.pnl), 0);
  const losses = -trades.filter(trade => Number(trade.pnl) < 0).reduce((sum, trade) => sum + Number(trade.pnl), 0);
  if (losses === 0) return wins > 0 ? Infinity : 0;
  return wins / losses;
}

function tradeStats(book, initialCapital, scale = 1) {
  const trades = book?.trades ?? [];
  const wins = trades.filter(trade => Number(trade.pnl) > 0).length;
  const notional = trades.reduce((sum, trade) => sum + Math.abs(Number(trade.entry) * Number(trade.qty)), 0) * scale;
  return {
    trades: trades.length,
    winRatePct: trades.length ? wins / trades.length * 100 : 0,
    profitFactor: Number.isFinite(profitFactor(trades)) ? profitFactor(trades) : null,
    roundTripNotional: notional,
    turnoverX: initialCapital > 0 ? notional / initialCapital : null,
  };
}

function aggregatePathSummaries(summaries) {
  const windows = { m6: 124, m12: 248, m24: 496 };
  const total = summaries.length;
  const reached = summaries.filter(row => row.reached);
  const worstMdd = summaries.reduce((best, row) => !best || row.maxDrawdownPct > best.maxDrawdownPct ? row : best, null);
  const worstFinal = summaries.reduce((best, row) => !best || row.finalCapital < best.finalCapital ? row : best, null);
  return {
    paths: total,
    reachedCount: reached.length,
    censoredCount: total - reached.length,
    pReachAnyPct: pct(reached.length, total),
    pReach6mPct: pct(summaries.filter(row => row.reached && row.tt100TradingDays <= windows.m6).length, total),
    pReach12mPct: pct(summaries.filter(row => row.reached && row.tt100TradingDays <= windows.m12).length, total),
    pReach24mPct: pct(summaries.filter(row => row.reached && row.tt100TradingDays <= windows.m24).length, total),
    pHalfCapitalPct: pct(summaries.filter(row => row.hitHalfCapital).length, total),
    pSeventyLossPct: pct(summaries.filter(row => row.hitSeventyLoss).length, total),
    tt100P25TradingDays: quantileWithCensoring(summaries, 0.25),
    tt100MedianTradingDays: quantileWithCensoring(summaries, 0.50),
    tt100P75TradingDays: quantileWithCensoring(summaries, 0.75),
    reachedOnlyMedianTradingDays: median(reached.map(row => row.tt100TradingDays)),
    medianFinalCapital: median(summaries.map(row => row.finalCapital)),
    p25FinalCapital: percentile(summaries.map(row => row.finalCapital), 0.25),
    p75FinalCapital: percentile(summaries.map(row => row.finalCapital), 0.75),
    medianMddPct: median(summaries.map(row => row.maxDrawdownPct)),
    worstMddPct: worstMdd?.maxDrawdownPct ?? null,
    worstMddPath: worstMdd,
    worstFinalPath: worstFinal,
  };
}

function loadDump(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function dumpPath(rawDir, candidateId, tag) {
  return join(rawDir, `${candidateId}-${tag}.json`);
}

function logPath(rawDir, candidateId, tag) {
  return join(rawDir, `${candidateId}-${tag}.log`);
}

function windowsPath(rawDir, candidateId) {
  return join(rawDir, `${candidateId}-tt100-derived.json`);
}

function buildRunArgs(candidate, run, options) {
  return [
    'backtest-swing.mjs',
    '--from', options.from,
    '--to', options.to,
    '--capital', String(options.capital),
    ...candidate.args,
    '--exclude', missingCandleCodes.join(','),
    '--dump', run.dump,
    '--seed', String(run.seed),
    '--subsample', String(run.subsample),
    '--stress', String(run.stress),
  ];
}

function backtestEnv(options) {
  const guard = relative(repoRoot, join(options.outputDir, 'cache-only-fetch-filter.mjs')).split(sep).join('/');
  return {
    ...process.env,
    NODE_OPTIONS: `--import ./${guard}`,
  };
}

function runProcess(args, logFile, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: backtestEnv(options),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      writeFileSync(logFile, `${stdout}\n${stderr}`);
      if (code === 0) resolvePromise();
      else reject(new Error(`backtest exited ${code}: ${args.join(' ')}\n${stderr || stdout}`));
    });
  });
}

function selectedExecutableCandidates(options) {
  if (!options.only.size) return executableCandidates;
  return executableCandidates.filter(candidate => options.only.has(candidate.id));
}

function buildJobs(options, rawDir) {
  const jobs = [];
  for (const candidate of selectedExecutableCandidates(options)) {
    jobs.push({ candidate, tag: 'base', seed: 0, subsample: 1, stress: 0 });
    jobs.push({ candidate, tag: 'stress', seed: 0, subsample: 1, stress: 1 });
    for (let seed = 1; seed <= options.seeds; seed++) {
      jobs.push({
        candidate,
        tag: `mc-${String(seed).padStart(2, '0')}`,
        seed,
        subsample: options.subsample,
        stress: 0,
      });
    }
  }
  return jobs.map(job => ({
    ...job,
    dump: dumpPath(rawDir, job.candidate.id, job.tag),
    log: logPath(rawDir, job.candidate.id, job.tag),
  }));
}

async function runJobs(jobs, options) {
  if (options.skipRuns) return;
  let next = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= jobs.length) return;
      const job = jobs[index];
      if (!options.force && existsSync(job.dump)) {
        done++;
        console.log(`[tt100] skip ${done}/${jobs.length} ${job.candidate.id} ${job.tag}`);
        continue;
      }
      const args = buildRunArgs(job.candidate, job, options);
      await runProcess(args, job.log, options);
      done++;
      console.log(`[tt100] done ${done}/${jobs.length} ${job.candidate.id} ${job.tag}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, () => worker()));
}

function loadBook(rawDir, candidate, tag) {
  const dump = loadDump(dumpPath(rawDir, candidate.id, tag));
  const book = dump.books?.[candidate.strategy];
  if (!book?.daily?.length) throw new Error(`${candidate.id} ${tag} has no daily curve`);
  return { dump, book };
}

function summarizeEvidence({
  id,
  family,
  name,
  kind,
  notes = [],
  baseCurve,
  stressCurve,
  mcCurves,
  tradeStats: trades,
  options,
  extra = {},
}) {
  const basePath = summarizeTt100Path(baseCurve, options);
  const stressPath = summarizeTt100Path(stressCurve, options);
  const universePaths = mcCurves.map(curve => summarizeTt100Path(curve, options));
  const blockCurves = [];
  const blockPaths = [];
  for (let seed = 1; seed <= options.seeds; seed++) {
    const curve = blockBootstrapCurve(baseCurve, {
      initialCapital: options.capital,
      days: options.blockDays,
      blockSize: options.blockSize,
      seed,
    });
    blockCurves.push(curve);
    blockPaths.push(summarizeTt100Path(curve, options));
  }
  const universe = aggregatePathSummaries(universePaths);
  const block = aggregatePathSummaries(blockPaths);
  const conservative = {
    pReach6mPct: Math.min(universe.pReach6mPct, block.pReach6mPct),
    pReach12mPct: Math.min(universe.pReach12mPct, block.pReach12mPct),
    pReach24mPct: Math.min(universe.pReach24mPct, block.pReach24mPct),
    pReachAnyPct: Math.min(universe.pReachAnyPct, block.pReachAnyPct),
    pHalfCapitalPct: Math.max(universe.pHalfCapitalPct, block.pHalfCapitalPct),
    pSeventyLossPct: Math.max(universe.pSeventyLossPct, block.pSeventyLossPct),
    worstMddPct: Math.max(universe.worstMddPct ?? 0, block.worstMddPct ?? 0),
  };
  return {
    id,
    family,
    name,
    kind,
    notes,
    base: basePath,
    stress: stressPath,
    costStress: {
      finalCapitalDelta: stressPath.finalCapital - basePath.finalCapital,
      cagrDeltaPct: stressPath.cagrPct - basePath.cagrPct,
      mddDeltaPct: stressPath.maxDrawdownPct - basePath.maxDrawdownPct,
    },
    universeMonteCarlo: universe,
    blockBootstrap: block,
    conservative,
    trades,
    blockRaw: blockPaths,
    verdict: null,
    verdictReasons: [],
    ...extra,
  };
}

function empiricalKellyBySub(trades) {
  const groups = new Map();
  for (const trade of trades) {
    const key = trade.ctx?.sub ?? 'unknown';
    const group = groups.get(key) ?? { trades: 0, wins: 0, grossWin: 0, grossLoss: 0 };
    group.trades++;
    if (Number(trade.pnl) > 0) {
      group.wins++;
      group.grossWin += Number(trade.pnl);
    } else {
      group.grossLoss += -Number(trade.pnl);
    }
    groups.set(key, group);
  }
  return Object.fromEntries([...groups.entries()].map(([key, group]) => {
    const p = group.trades ? group.wins / group.trades : 0;
    const avgWin = group.wins ? group.grossWin / group.wins : 0;
    const lossCount = group.trades - group.wins;
    const avgLoss = lossCount ? group.grossLoss / lossCount : 0;
    const payoff = avgLoss > 0 ? avgWin / avgLoss : null;
    const fullKelly = payoff && payoff > 0 ? p - (1 - p) / payoff : 0;
    return [key, {
      ...group,
      winRatePct: p * 100,
      avgWin,
      avgLoss,
      payoff,
      fullKelly: Math.max(0, Math.min(1, fullKelly)),
    }];
  }));
}

function verdictFor(result, baseline) {
  if (result.id === 'A-baseline') {
    return {
      verdict: 'NO_DEPLOY',
      reasons: ['This is the current baseline; no live change is proposed.'],
    };
  }
  const reachImproved = result.conservative.pReach24mPct > baseline.conservative.pReach24mPct
    || (result.blockBootstrap.tt100MedianTradingDays != null
      && baseline.blockBootstrap.tt100MedianTradingDays != null
      && result.blockBootstrap.tt100MedianTradingDays < baseline.blockBootstrap.tt100MedianTradingDays);
  const deathNotWorse = result.conservative.pSeventyLossPct <= baseline.conservative.pSeventyLossPct;
  const halfNotMuchWorse = result.conservative.pHalfCapitalPct <= baseline.conservative.pHalfCapitalPct + 5;
  const riskClearlyBad = result.conservative.pSeventyLossPct > 0
    || result.conservative.pHalfCapitalPct > 20
    || result.conservative.worstMddPct > 55;

  if (reachImproved && deathNotWorse && halfNotMuchWorse && !riskClearlyBad) {
    return {
      verdict: 'SHADOW_ONLY',
      reasons: [
        'Reach evidence improved versus baseline, but current-listed survivorship bias blocks live candidacy.',
        'Needs forward shadow and point-in-time universe before promotion.',
      ],
    };
  }
  return {
    verdict: 'NO_DEPLOY',
    reasons: [
      reachImproved ? 'Reach improved, but drawdown/death risk or data quality is not acceptable.' : 'No conservative TT100/reach improvement versus baseline.',
      'Current-listed universe and same-day close signal treatment remain optimistic.',
    ],
  };
}

function attachVerdicts(results) {
  const baseline = results.find(row => row.id === 'A-baseline');
  for (const result of results) {
    const verdict = verdictFor(result, baseline);
    result.verdict = verdict.verdict;
    result.verdictReasons = verdict.reasons;
  }
}

function buildExecutableResults(options, rawDir) {
  return executableCandidates.map(candidate => {
    const base = loadBook(rawDir, candidate, 'base');
    const stress = loadBook(rawDir, candidate, 'stress');
    const mcCurves = [];
    for (let seed = 1; seed <= options.seeds; seed++) {
      const tag = `mc-${String(seed).padStart(2, '0')}`;
      mcCurves.push(loadBook(rawDir, candidate, tag).book.daily);
    }
    const stats = tradeStats(base.book, options.capital);
    return summarizeEvidence({
      id: candidate.id,
      family: candidate.family,
      name: candidate.name,
      kind: 'backtest',
      notes: candidate.notes,
      baseCurve: base.book.daily,
      stressCurve: stress.book.daily,
      mcCurves,
      tradeStats: stats,
      options,
      extra: {
        args: candidate.args,
        rawFiles: {
          base: relative(repoRoot, dumpPath(rawDir, candidate.id, 'base')),
          stress: relative(repoRoot, dumpPath(rawDir, candidate.id, 'stress')),
          mcPattern: relative(repoRoot, dumpPath(rawDir, candidate.id, 'mc-XX')),
        },
      },
    });
  });
}

function buildBarbellResults(options, rawDir, executableResults) {
  const candidateMap = new Map(executableCandidates.map(candidate => [candidate.id, candidate]));
  const bookMap = new Map();
  for (const candidate of executableCandidates) {
    bookMap.set(`${candidate.id}:base`, loadBook(rawDir, candidate, 'base').book);
    bookMap.set(`${candidate.id}:stress`, loadBook(rawDir, candidate, 'stress').book);
    for (let seed = 1; seed <= options.seeds; seed++) {
      const tag = `mc-${String(seed).padStart(2, '0')}`;
      bookMap.set(`${candidate.id}:${tag}`, loadBook(rawDir, candidate, tag).book);
    }
  }

  return barbellDefinitions.map(def => {
    const coreBase = bookMap.get(`${def.core}:base`);
    const satBase = bookMap.get(`${def.satellite}:base`);
    const baseCombined = combineBarbellCurves(coreBase.daily, satBase.daily, def);
    const stressCombined = combineBarbellCurves(
      bookMap.get(`${def.core}:stress`).daily,
      bookMap.get(`${def.satellite}:stress`).daily,
      def,
    );
    const mcCurves = [];
    for (let seed = 1; seed <= options.seeds; seed++) {
      const tag = `mc-${String(seed).padStart(2, '0')}`;
      mcCurves.push(combineBarbellCurves(
        bookMap.get(`${def.core}:${tag}`).daily,
        bookMap.get(`${def.satellite}:${tag}`).daily,
        def,
      ).curve);
    }
    const coreStats = executableResults.find(row => row.id === def.core).trades;
    const satStats = executableResults.find(row => row.id === def.satellite).trades;
    const stats = {
      trades: Math.round(coreStats.trades * def.coreWeight + satStats.trades * (1 - def.coreWeight)),
      winRatePct: null,
      profitFactor: null,
      roundTripNotional: null,
      turnoverX: (coreStats.turnoverX ?? 0) * def.coreWeight + (satStats.turnoverX ?? 0) * (1 - def.coreWeight),
    };
    return summarizeEvidence({
      id: def.id,
      family: def.family,
      name: def.name,
      kind: 'barbell',
      notes: [
        `Core=${def.core}, satellite=${def.satellite}, satellite kill-switch=${def.satelliteStopMddPct}% sleeve DD.`,
      ],
      baseCurve: baseCombined.curve,
      stressCurve: stressCombined.curve,
      mcCurves,
      tradeStats: stats,
      options,
      extra: {
        definition: def,
        satelliteStoppedBase: baseCombined.satelliteStopped,
        satelliteStopDayBase: baseCombined.stopDay,
      },
    });
  });
}

function buildKellyResults(options, rawDir) {
  const baseline = executableCandidates.find(candidate => candidate.id === 'A-baseline');
  const baseBook = loadBook(rawDir, baseline, 'base').book;
  const stressBook = loadBook(rawDir, baseline, 'stress').book;
  const kelly = empiricalKellyBySub(baseBook.trades);
  return kellyFractions.map(fraction => {
    const baseCurve = applyFractionalExposure(baseBook.daily, fraction, options.capital);
    const stressCurve = applyFractionalExposure(stressBook.daily, fraction, options.capital);
    const mcCurves = [];
    for (let seed = 1; seed <= options.seeds; seed++) {
      const tag = `mc-${String(seed).padStart(2, '0')}`;
      const book = loadBook(rawDir, baseline, tag).book;
      mcCurves.push(applyFractionalExposure(book.daily, fraction, options.capital));
    }
    return summarizeEvidence({
      id: `C-kelly-${String(fraction).replace('.', 'p')}x`,
      family: 'C',
      name: `Kelly-like fractional exposure ${fraction}x`,
      kind: 'kelly-proxy',
      notes: [
        'Research proxy only: daily baseline returns are scaled; no full Kelly deployment and no live sizing change.',
        'Edge estimates are computed from historical baseline trades by sub only.',
      ],
      baseCurve,
      stressCurve,
      mcCurves,
      tradeStats: tradeStats(baseBook, options.capital, fraction),
      options,
      extra: {
        fraction,
        empiricalKellyBySub: kelly,
      },
    });
  });
}

function formatKrw(value) {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${Math.round(value).toLocaleString('ko-KR')} KRW`;
}

function formatPct(value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${value.toFixed(digits)}%`;
}

function formatDays(value) {
  if (value == null || !Number.isFinite(value)) return 'censored';
  return String(Math.round(value));
}

function reportRow(row) {
  const cells = [
    row.id,
    row.verdict,
    formatKrw(row.base.finalCapital),
    formatPct(row.base.cagrPct),
    formatPct(row.base.maxDrawdownPct),
    formatPct(row.conservative.pReach6mPct),
    formatPct(row.conservative.pReach12mPct),
    formatPct(row.conservative.pReach24mPct),
    formatPct(row.blockBootstrap.pReachAnyPct),
    formatDays(row.blockBootstrap.tt100P25TradingDays),
    formatDays(row.blockBootstrap.tt100MedianTradingDays),
    formatDays(row.blockBootstrap.tt100P75TradingDays),
    formatPct(row.conservative.pHalfCapitalPct),
    formatPct(row.conservative.pSeventyLossPct),
    row.trades.trades ?? '-',
    row.trades.turnoverX == null ? '-' : `${row.trades.turnoverX.toFixed(1)}x`,
    `${formatKrw(row.stress.finalCapital)} / ${formatPct(row.stress.maxDrawdownPct)}`,
  ];
  return `| ${cells.join(' | ')} |`;
}

function buildReport(summary) {
  const allResults = summary.results;
  const rows = allResults.map(reportRow).join('\n');
  const verdictRows = allResults.map(row => `| ${row.id} | ${row.verdict} | ${row.verdictReasons.join('; ')} |`).join('\n');
  const baseline = allResults.find(row => row.id === 'A-baseline');
  const bestReach = [...allResults].sort((a, b) => b.conservative.pReach24mPct - a.conservative.pReach24mPct)[0];
  const bestRisk = [...allResults].sort((a, b) => a.conservative.pSeventyLossPct - b.conservative.pSeventyLossPct
    || a.conservative.pHalfCapitalPct - b.conservative.pHalfCapitalPct
    || a.conservative.worstMddPct - b.conservative.worstMddPct)[0];
  const generated = summary.generatedAt;
  const baseCommand = summary.baselineCommand;
  return `# TT100 research - 속도 vs 계좌 사망확률

Generated: ${generated}

## Mathematical reality

- Starting capital 6,000,000 KRW to 100,000,000 KRW is 16.67x. If the live balance is treated as about 6.1M, the multiple is about 16.4x.
- At CAGR 11-21%, the mathematical time to 100M from 6M is about 27.0-14.8 years. A 8-year arrival needs about 42.1% CAGR.
- P(6/12/24 months to 100M) should be treated as approximately zero for non-ruin strategies unless the strategy accepts extreme concentration or leverage.
- In the 2023-01-02 to 2026-06-11 backtest window, TT100 observations that do not hit 100M are right-censored, not infinite.
- Headline: 속도 vs 계좌 사망확률.

## Baseline parity check

Fixed baseline string:

\`\`\`powershell
${baseCommand}
\`\`\`

Line mapping checked before research:

| Item | Live path | Backtest path | Result |
|---|---|---|---|
| Regime | stock-live.mjs:52-60 SMA20/60 after HMA rollback | backtest-swing.mjs:288 default proxy, backtest-swing.mjs:355-358 and :418 regimema 20,60 | match |
| RSI volume filter | strategy-contract.mjs:55-57 and stock-live.mjs:90 | backtest-swing.mjs:84 and :850 with --rsivol 1.25 | match |
| NEUTRAL rsi2 skip | strategy-contract.mjs:57 and stock-live.mjs:91 | backtest-swing.mjs:104 and :856 with --skipneutralrsi | match |
| Slots | strategy-contract.mjs:16, stock-live.mjs:317-323 | backtest-swing.mjs:84 with --slots 3, liveCandidateBudget at live-parity.mjs:51-64 | match |
| Partial TP | strategy-contract.mjs:81-84, stock-live.mjs:250-261 | backtest-swing.mjs:786-790 with trailPct 8, --tp1r 0.5, --tp2r 1 | match |

Safety: all runs used \`NODE_OPTIONS=--import ./research-results/tt100-2026-07-23/cache-only-fetch-filter.mjs\` and \`--exclude ${missingCandleCodes.join(',')}\`. The preload permits Supabase reads and blocks non-Supabase fetches.

## Candidate definitions

- A-baseline: fixed live-parity baseline, SMA20/60 regime, skipNeutral RSI, rsiVol 1.25, slots 3, partial TP +4/+8.
- B-volsurge-sat: research-only volsurge sleeve with rsi2 and hi120 disabled, then 60/70/80 baseline barbell portfolios with a 35% satellite drawdown freeze.
- B-hi120-sat: research-only concentrated hi120 sleeve with rsi2 disabled, then 60/70/80 baseline barbell portfolios with a 35% satellite drawdown freeze.
- C-kelly: 0.25/0.5/0.75/1.0x fractional exposure proxy from baseline daily returns. Historical edge is estimated from baseline trades by sub only; no full Kelly deployment is considered.
- D-no-up-rsi: meta-filter proxy that removes UP-regime rsi2 entries. This is not a trained triple-barrier model and is marked as shadow-only at most because the same sample suggested the filter.
- Disclosure/AI catalyst sleeve: not backtested for TT100 because the disclosure/AI shadow sample is only about three months; it remains data collection only.

Raw outputs are under \`research-results/tt100-2026-07-23/raw/\`: backtest dumps/logs per candidate/run plus \`*-tt100-derived.json\` for derived TT100 evidence.

## Results

Conservative probabilities use the worse side of universe-subsample MC and block bootstrap: reach probabilities are the lower value, loss probabilities and worst MDD are the higher value. TT100 p25/median/p75 are Kaplan-Meier style right-censored estimates from the 15-year block-bootstrap paths; "censored" means the percentile was not identified inside the horizon.

| ID | Verdict | Base final | Base CAGR | Base MDD | P6M | P12M | P24M | Block P15Y | TT100 p25 | TT100 median | TT100 p75 | P<=50% | P>=70% loss | Trades | Turnover | Stress final / MDD |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${rows}

## Worst paths

- Baseline base path: final ${formatKrw(baseline.base.finalCapital)}, MDD ${formatPct(baseline.base.maxDrawdownPct)}, TT100 ${baseline.base.reached ? `${baseline.base.tt100TradingDays} trading days` : `censored at ${baseline.base.censorTradingDays} trading days`}.
- Baseline universe MC worst MDD: ${formatPct(baseline.universeMonteCarlo.worstMddPct)}; worst final ${formatKrw(baseline.universeMonteCarlo.worstFinalPath?.finalCapital)}.
- Baseline block-bootstrap worst MDD: ${formatPct(baseline.blockBootstrap.worstMddPct)}; worst final ${formatKrw(baseline.blockBootstrap.worstFinalPath?.finalCapital)}.
- Highest conservative 24M reach probability: ${bestReach.id} at ${formatPct(bestReach.conservative.pReach24mPct)}.
- Lowest account-death risk tie-breaker: ${bestRisk.id}, P(70% loss) ${formatPct(bestRisk.conservative.pSeventyLossPct)}, P(50% capital breach) ${formatPct(bestRisk.conservative.pHalfCapitalPct)}.

## Verdicts

| Candidate | Verdict | Reason |
|---|---|---|
${verdictRows}

## Methodology and limitations

- Universe MC: \`--subsample ${summary.assumptions.subsample} x ${summary.assumptions.seeds} seeds\`.
- Block bootstrap: ${summary.assumptions.blockDays} synthetic trading days, ${summary.assumptions.blockSize}-day return blocks, ${summary.assumptions.seeds} seeds.
- Cost stress: \`--stress 1\`, which doubles fee bps and uses 2-tick slippage in the existing backtest model.
- Same-day close signal/close buy mechanics remain optimistic relative to real execution; do not label satellite or derived curves as live-parity deployment evidence.
- Data is current-listed and excludes delisted names, so survivorship bias is present. This alone blocks LIVE_CANDIDATE.
- Disclosure/AI catalyst data is too short for TT100 validation in this window; it remains research/shadow-only input, not a backtestable live candidate.
- Barbell x satellite x Kelly x meta combinations create PBO risk. Treat any improvement as a hypothesis for shadow logging, not as a live setting.

## Separate live-account suggestions, not applied

No VM deploy, systemd restart, broker order, SSH/scp, or live file change was made. The only permissible next step from this evidence is shadow logging or a point-in-time/delisted-universe data upgrade; no strategy-contract.mjs, stock-live.mjs, or live-parity.mjs change is proposed here.
`;
}

function writeDerivedRaw(rawDir, result) {
  writeFileSync(windowsPath(rawDir, result.id), JSON.stringify({
    id: result.id,
    name: result.name,
    kind: result.kind,
    base: result.base,
    stress: result.stress,
    universeMonteCarlo: result.universeMonteCarlo,
    blockBootstrap: result.blockBootstrap,
    conservative: result.conservative,
    verdict: result.verdict,
    verdictReasons: result.verdictReasons,
  }, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!(options.capital > 0)) throw new Error('--capital must be positive');
  if (!(options.targetCapital > options.capital)) throw new Error('--target must exceed --capital');
  if (!(options.seeds >= 1)) throw new Error('--seeds must be positive');
  if (!(options.subsample > 0 && options.subsample <= 1)) throw new Error('--subsample must be within (0, 1]');
  const rawDir = join(options.outputDir, 'raw');
  mkdirSync(rawDir, { recursive: true });

  const jobs = buildJobs(options, rawDir);
  console.log(`[tt100] jobs=${jobs.length} seeds=${options.seeds} subsample=${options.subsample} concurrency=${options.concurrency}`);
  await runJobs(jobs, options);
  if (options.runOnly) {
    console.log('[tt100] run-only complete');
    return;
  }

  const executableResults = buildExecutableResults(options, rawDir);
  const barbellResults = buildBarbellResults(options, rawDir, executableResults);
  const kellyResults = buildKellyResults(options, rawDir);
  const results = [...executableResults, ...barbellResults, ...kellyResults];
  attachVerdicts(results);
  for (const result of results) writeDerivedRaw(rawDir, result);

  const summary = {
    generatedAt: new Date().toISOString(),
    objective: 'TT100 research from 6,000,000 KRW to 100,000,000 KRW',
    baselineCommand: `node backtest-swing.mjs ${baselineArgs.join(' ')}`,
    safety: {
      noLiveFilesModifiedByHarness: true,
      networkPolicy: 'Supabase read only via cache-only preload',
      missingCandleCodes,
    },
    assumptions: {
      from: options.from,
      to: options.to,
      initialCapital: options.capital,
      targetCapital: options.targetCapital,
      targetMultiple: options.targetCapital / options.capital,
      seeds: options.seeds,
      subsample: options.subsample,
      blockDays: options.blockDays,
      blockSize: options.blockSize,
      currentListedUniverse: true,
      pointInTimeUniverse: false,
      includesDelisted: false,
      sameDayCloseSignal: true,
    },
    executableCandidates,
    barbellDefinitions,
    results,
    liveChangesApplied: false,
    modifiedLiveFiles: [],
  };

  writeFileSync(join(options.outputDir, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(options.outputDir, 'REPORT.md'), buildReport(summary));
  console.log(`[tt100] summary=${join(options.outputDir, 'summary.json')}`);
  console.log(`[tt100] report=${join(options.outputDir, 'REPORT.md')}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  await main();
}
