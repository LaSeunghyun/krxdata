#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BARBELL_COMBINATIONS,
  buildCandidateCommand,
  RESEARCH_CANDIDATES,
  shouldExecuteJob,
} from './research-candidates.mjs';
import {
  applyDrawdownStop,
  blockBootstrap,
  classifyResearchResult,
  combineBarbell,
  profitFactor,
  researchFailureReasons,
  summarizeCurve,
  summarizeMonteCarlo,
} from './research-metrics.mjs';
import { buildResearchReport, validateResearchSummary } from './research-report.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : fallback;
};

const from = argOf('--from', '20230102');
const to = argOf('--to', '20260611');
const capital = Number(argOf('--capital', '6000000'));
const seedCount = Number(argOf('--seeds', '20'));
const subsample = Number(argOf('--subsample', '0.8'));
const concurrency = Math.max(1, Number(argOf('--concurrency', '2')));
const outputDir = join(root, argOf('--out', 'research-results/100m-barbell-2026-07-22'));
const rawDir = join(outputDir, 'raw');
const force = argv.includes('--force');
const forcedCandidateIds = new Set(String(argOf('--force-candidate', '')).split(',').filter(Boolean));
const targetCapital = 100_000_000;
const requiredCagr = (Math.pow(targetCapital / capital, 1 / 5) - 1) * 100;

if (!Number.isFinite(capital) || capital <= 0) throw new Error('--capital must be positive');
if (!Number.isInteger(seedCount) || seedCount < 1) throw new Error('--seeds must be a positive integer');
if (!(subsample > 0 && subsample <= 1)) throw new Error('--subsample must be within (0, 1]');

mkdirSync(rawDir, { recursive: true });

function dumpPath(candidateId, tag) {
  return join(rawDir, `${candidateId}-${tag}.json`);
}

function runProcess(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { if (stdout.length < 50_000) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 50_000) stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`backtest exited ${code}\n${stderr || stdout}`));
    });
  });
}

async function runPool(jobs, limit) {
  let next = 0;
  let completed = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= jobs.length) return;
      const job = jobs[index];
      if (!shouldExecuteJob({ dumpExists: existsSync(job.dump), force, forcedCandidateIds, candidateId: job.candidate.id })) {
        JSON.parse(readFileSync(job.dump, 'utf8'));
      } else {
        await runProcess(buildCandidateCommand(job.candidate, job.run));
      }
      completed++;
      console.log(`[research] ${completed}/${jobs.length} ${job.candidate.id} ${job.tag}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, () => worker()));
}

function executableCandidates() {
  return RESEARCH_CANDIDATES.filter(candidate => candidate.strategy);
}

function buildJobs() {
  const jobs = [];
  for (const candidate of executableCandidates()) {
    const baseDump = dumpPath(candidate.id, 'base');
    jobs.push({
      candidate,
      tag: 'base',
      dump: baseDump,
      run: { from, to, capital, dump: baseDump, seed: 0, subsample: 1, stress: 0 },
    });
    const stressDump = dumpPath(candidate.id, 'stress');
    jobs.push({
      candidate,
      tag: 'stress',
      dump: stressDump,
      run: { from, to, capital, dump: stressDump, seed: 0, subsample: 1, stress: 1 },
    });
    for (let seed = 1; seed <= seedCount; seed++) {
      const tag = `mc-${String(seed).padStart(2, '0')}`;
      const mcDump = dumpPath(candidate.id, tag);
      jobs.push({
        candidate,
        tag,
        dump: mcDump,
        run: { from, to, capital, dump: mcDump, seed, subsample, stress: 0 },
      });
    }
  }
  return jobs;
}

function loadBook(candidateId, tag) {
  const candidate = RESEARCH_CANDIDATES.find(row => row.id === candidateId);
  const dump = JSON.parse(readFileSync(dumpPath(candidateId, tag), 'utf8'));
  const book = dump.books[candidate.strategy];
  if (!book?.daily?.length) throw new Error(`${candidateId} ${tag} has no daily curve`);
  return book;
}

function transformedCurve(candidate, book) {
  if (candidate.satelliteStopMdd != null) return applyDrawdownStop(book.daily, candidate.satelliteStopMdd).curve;
  return book.daily;
}

function yearReturns(curve) {
  const grouped = new Map();
  for (const row of curve) {
    const year = row.day.slice(0, 4);
    const value = grouped.get(year) ?? { first: row.equity, last: row.equity };
    value.last = row.equity;
    grouped.set(year, value);
  }
  return Object.fromEntries([...grouped].map(([year, value]) => [year, (value.last / value.first - 1) * 100]));
}

function regimeStats(trades) {
  const stats = {};
  for (const trade of trades) {
    const regime = trade.ctx?.regime ?? 'UNKNOWN';
    const row = stats[regime] ??= { trades: 0, wins: 0, pnl: 0 };
    row.trades++;
    if (trade.pnl > 0) row.wins++;
    row.pnl += trade.pnl;
  }
  return stats;
}

function baseMetrics(curve, book) {
  const summary = summarizeCurve(curve, capital);
  const pf = profitFactor(book?.trades ?? []);
  const trades = book?.trades ?? [];
  return {
    ...summary,
    profitFactor: Number.isFinite(pf) ? pf : null,
    trades: trades.length,
    winRate: trades.length ? trades.filter(trade => trade.pnl > 0).length / trades.length * 100 : 0,
    yearReturns: yearReturns(curve),
    regimeStats: regimeStats(trades),
  };
}

function bootstrapEvidence(curve) {
  const runs = [];
  for (let seed = 1; seed <= seedCount; seed++) {
    const sample = blockBootstrap(curve, { initialCapital: capital, days: 248 * 5, blockSize: 20, seed });
    runs.push(summarizeCurve(sample, capital));
  }
  const mc = summarizeMonteCarlo(runs);
  const sortedFinals = runs.map(run => run.finalCapital).sort((a, b) => a - b);
  return {
    runs,
    summary: mc,
    medianFiveYearCapital: sortedFinals[Math.floor(sortedFinals.length / 2)],
    reachProbability: runs.filter(run => run.finalCapital >= targetCapital).length / runs.length * 100,
  };
}

function conservativeMc(universeRuns, blockRuns) {
  const universe = summarizeMonteCarlo(universeRuns);
  const block = summarizeMonteCarlo(blockRuns);
  return {
    medianMdd: Math.max(universe.medianMdd, block.medianMdd),
    worstMdd: Math.max(universe.worstMdd, block.worstMdd),
    medianCagr: Math.min(universe.medianCagr, block.medianCagr),
    worstCagr: Math.min(universe.worstCagr, block.worstCagr),
    ruinSeeds: Math.max(universe.ruinSeeds, block.ruinSeeds),
    universe,
    block,
  };
}

function grade(base, mc, stress, dataQuality) {
  return classifyResearchResult(verdictMetrics(base, mc, stress), dataQuality);
}

function verdictMetrics(base, mc, stress) {
  return {
    initialCapital: capital,
    cagr: base.cagr,
    mcMedianMdd: mc.medianMdd,
    mcWorstMdd: mc.worstMdd,
    stressMdd: stress.mdd,
    stressFinal: stress.finalCapital,
    ruinSeeds: mc.ruinSeeds,
    shadowDays: 0,
  };
}

function cacheCoverage() {
  const cache = join(root, 'candles-daily.jsonl');
  const descriptor = openSync(cache, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, length).toString('utf8').split(/\r?\n/, 1)[0];
    const record = JSON.parse(line);
    return { start: record.d[0], end: record.d.at(-1) };
  } finally {
    closeSync(descriptor);
  }
}

const coverage = cacheCoverage();
const dataQuality = {
  start: coverage.start,
  end: coverage.end,
  evaluationStart: from,
  evaluationEnd: to,
  pointInTimeUniverse: false,
  includesDelisted: false,
  survivorshipBias: true,
};

function buildCandidateResults() {
  const results = [];
  for (const candidate of RESEARCH_CANDIDATES) {
    if (candidate.unavailable) {
      results.push({ ...candidate, grade: 'REJECTED', failureReasons: [candidate.unavailable] });
      continue;
    }
    const sourceId = candidate.derivedFrom ?? candidate.id;
    const baseBook = loadBook(sourceId, 'base');
    const stressBook = loadBook(sourceId, 'stress');
    const baseCurve = transformedCurve(candidate, baseBook);
    const stressCurve = transformedCurve(candidate, stressBook);
    const base = baseMetrics(baseCurve, candidate.derivedFrom ? { trades: [] } : baseBook);
    const stress = summarizeCurve(stressCurve, capital);
    const universeRuns = [];
    for (let seed = 1; seed <= seedCount; seed++) {
      const tag = `mc-${String(seed).padStart(2, '0')}`;
      const book = loadBook(sourceId, tag);
      universeRuns.push(summarizeCurve(transformedCurve(candidate, book), capital));
    }
    const bootstrap = bootstrapEvidence(baseCurve);
    const mc = conservativeMc(universeRuns, bootstrap.runs);
    results.push({
      ...candidate,
      grade: grade(base, mc, stress, dataQuality),
      failureReasons: researchFailureReasons(verdictMetrics(base, mc, stress), dataQuality),
      base,
      mc,
      stress,
      reachProbability: bootstrap.reachProbability,
      medianFiveYearCapital: bootstrap.medianFiveYearCapital,
      limitations: ['current-listed universe', '2023-2026 evaluation reused in prior research', 'no forward shadow days'],
    });
  }
  return results;
}

function buildPortfolioResults(candidateResults) {
  return BARBELL_COMBINATIONS.map(portfolio => {
    const coreBase = loadBook(portfolio.core, 'base');
    const satelliteBase = loadBook(portfolio.satellite, 'base');
    const combinedBase = combineBarbell(coreBase.daily, satelliteBase.daily, {
      initialCapital: capital,
      satelliteStopMdd: portfolio.satelliteStopMdd,
    });
    const base = baseMetrics(combinedBase.curve, { trades: [] });

    const coreStress = loadBook(portfolio.core, 'stress');
    const satelliteStress = loadBook(portfolio.satellite, 'stress');
    const stressCurve = combineBarbell(coreStress.daily, satelliteStress.daily, {
      initialCapital: capital,
      satelliteStopMdd: portfolio.satelliteStopMdd,
    }).curve;
    const stress = summarizeCurve(stressCurve, capital);

    const universeRuns = [];
    for (let seed = 1; seed <= seedCount; seed++) {
      const tag = `mc-${String(seed).padStart(2, '0')}`;
      const core = loadBook(portfolio.core, tag);
      const satellite = loadBook(portfolio.satellite, tag);
      const curve = combineBarbell(core.daily, satellite.daily, {
        initialCapital: capital,
        satelliteStopMdd: portfolio.satelliteStopMdd,
      }).curve;
      universeRuns.push(summarizeCurve(curve, capital));
    }
    const bootstrap = bootstrapEvidence(combinedBase.curve);
    const mc = conservativeMc(universeRuns, bootstrap.runs);
    return {
      ...portfolio,
      grade: grade(base, mc, stress, dataQuality),
      failureReasons: researchFailureReasons(verdictMetrics(base, mc, stress), dataQuality),
      base,
      mc,
      stress,
      satelliteStopped: combinedBase.satelliteStopped,
      reachProbability: bootstrap.reachProbability,
      medianFiveYearCapital: bootstrap.medianFiveYearCapital,
      components: {
        core: candidateResults.find(row => row.id === portfolio.core)?.grade,
        satellite: candidateResults.find(row => row.id === portfolio.satellite)?.grade,
      },
    };
  });
}

console.log(`[research] candidates=${executableCandidates().length}, seeds=${seedCount}, jobs=${buildJobs().length}, concurrency=${concurrency}`);
await runPool(buildJobs(), concurrency);

const candidates = buildCandidateResults();
const portfolios = buildPortfolioResults(candidates);
const summary = {
  generatedAt: new Date().toISOString(),
  assumptions: {
    initialCapital: capital,
    targetCapital,
    targetYears: 5,
    requiredCagr,
    coreWeight: 2 / 3,
    satelliteWeight: 1 / 3,
    mcSeeds: seedCount,
    subsample,
    blockSize: 20,
    leverage: false,
    monthlyContribution: 0,
  },
  dataQuality,
  candidates,
  portfolios,
};

validateResearchSummary(summary);
writeFileSync(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));
writeFileSync(join(outputDir, 'REPORT.md'), buildResearchReport(summary));
console.log(`[research] report=${join(outputDir, 'REPORT.md')}`);
