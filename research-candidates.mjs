const LIVE_PARITY_ARGS = Object.freeze([
  '--strategies', 'combo-v2',
  '--live-parity',
  '--slots', '3',
  '--sectorcap', '1',
  '--rsiuni', '40',
  '--tp1r', '0.5',
  '--tp2r', '1',
]);

export const RESEARCH_CANDIDATES = Object.freeze([
  Object.freeze({ id: 'A1', name: 'live-parity combo-v2', family: 'tournament', role: 'core', strategy: 'combo-v2', args: LIVE_PARITY_ARGS }),
  Object.freeze({ id: 'A2', name: 'medium trend/cash', family: 'tournament', role: 'core', strategy: 'trend-cash', args: Object.freeze(['--strategies', 'trend-cash']) }),
  Object.freeze({ id: 'A3', name: 'point-in-time quality momentum', family: 'tournament', role: 'core', unavailable: 'point-in-time fundamentals unavailable' }),
  Object.freeze({ id: 'B2', name: 'combo-v2 volatility throttle', family: 'combo-improvement', role: 'core', strategy: 'combo-v2', args: Object.freeze([...LIVE_PARITY_ARGS, '--volshadow', '1']) }),
  Object.freeze({ id: 'B3', name: 'combo-v2 faster time exits', family: 'combo-improvement', role: 'core', strategy: 'combo-v2', args: Object.freeze([...LIVE_PARITY_ARGS, '--maxholdr', '3', '--maxholdh', '40']) }),
  Object.freeze({ id: 'C1', name: 'two-slot hi120 momentum', family: 'aggressive-control', role: 'satellite', strategy: 'hi120', args: Object.freeze(['--strategies', 'hi120', '--hislots', '2', '--hiregime', 'all']) }),
  Object.freeze({ id: 'C2', name: 'UP-gated two-slot hi120', family: 'aggressive-control', role: 'satellite', strategy: 'hi120', args: Object.freeze(['--strategies', 'hi120', '--hislots', '2', '--hiregime', 'up']) }),
  Object.freeze({ id: 'C3', name: 'UP-gated hi120 with 35% sleeve stop', family: 'aggressive-control', role: 'satellite', derivedFrom: 'C2', satelliteStopMdd: 35 }),
]);

export const BARBELL_COMBINATIONS = Object.freeze([
  Object.freeze({ id: 'P1', name: 'baseline barbell', core: 'A1', satellite: 'C1', satelliteStopMdd: Infinity }),
  Object.freeze({ id: 'P2', name: 'throttled gated barbell', core: 'B2', satellite: 'C2', satelliteStopMdd: Infinity }),
  Object.freeze({ id: 'P3', name: 'defensive trend barbell', core: 'A2', satellite: 'C2', satelliteStopMdd: 35 }),
]);

export function buildCandidateCommand(candidate, run) {
  if (!candidate?.strategy || !candidate?.args) throw new Error(`candidate ${candidate?.id ?? 'unknown'} is not executable`);
  return [
    'backtest-swing.mjs',
    '--from', String(run.from),
    '--to', String(run.to),
    '--capital', String(run.capital),
    ...candidate.args,
    '--dump', String(run.dump),
    '--seed', String(run.seed ?? 0),
    '--subsample', String(run.subsample ?? 1),
    '--stress', String(run.stress ?? 0),
  ];
}

export function shouldExecuteJob({ dumpExists, force = false, forcedCandidateIds = new Set(), candidateId }) {
  return force || forcedCandidateIds.has(candidateId) || !dumpExists;
}
