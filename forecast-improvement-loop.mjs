import { scoreVerification } from './forecast-core.mjs';

export const IMPROVEMENT_ENGINE_VERSION = 'fc-improvement-loop-v1';

export const DEFAULT_IMPROVEMENT_OPTIONS = {
  minGlobalRows: 8,
  minSegmentRows: 4,
  shrinkage: 0.5,
  maxBiasPp: 1.2,
  callGapPp: 15,
  minReplayRows: 12,
  minMaeGainPp: 0.15,
  minDirectionDelta: -0.02,
  maxBrierWorsen: 0.03,
};

export function segmentKey(row) {
  const layer = row.market_layer || 'KRX';
  const kind = row.target_kind || 'market';
  const horizon = row.target_start_hm && row.target_end_hm ? 'intraday' : 'daily';
  const sector = row.sector || row.market_layer || 'ALL';
  return `${layer}|${kind}|${horizon}|${sector}`;
}

export function normalizeImprovementRows(rows) {
  return (rows ?? [])
    .map(r => ({
      ...r,
      id: Number(r.id),
      forecast_median: Number(r.forecast_median),
      forecast_low: Number(r.forecast_low),
      forecast_high: Number(r.forecast_high),
      probability_up: Number(r.probability_up),
      probability_flat: Number(r.probability_flat),
      probability_down: Number(r.probability_down),
      flat_band: Number(r.flat_band),
      sigma: Number(r.sigma),
      actual_return: Number(r.actual_return),
      baselines: parseJsonMaybe(r.baselines) ?? {},
    }))
    .filter(r => Number.isFinite(r.id)
      && Number.isFinite(r.forecast_median)
      && Number.isFinite(r.forecast_low)
      && Number.isFinite(r.forecast_high)
      && Number.isFinite(r.probability_up)
      && Number.isFinite(r.probability_flat)
      && Number.isFinite(r.probability_down)
      && Number.isFinite(r.actual_return)
      && typeof r.target_end_date === 'string')
    .sort((a, b) => String(a.target_end_date).localeCompare(String(b.target_end_date)) || a.id - b.id);
}

export function buildImprovementProfile(rows, options = {}) {
  const opts = { ...DEFAULT_IMPROVEMENT_OPTIONS, ...options };
  const clean = normalizeImprovementRows(rows);
  const segments = {};

  const global = summarizeBias(clean, opts);
  const grouped = groupBy(clean, segmentKey);
  for (const [key, xs] of Object.entries(grouped)) {
    segments[key] = summarizeBias(xs, opts);
  }

  return {
    engine_version: IMPROVEMENT_ENGINE_VERSION,
    status: clean.length >= opts.minGlobalRows ? 'ready' : 'hold',
    reason: clean.length >= opts.minGlobalRows
      ? 'enough_verified_rows'
      : `need_${opts.minGlobalRows}_global_rows`,
    options: publicOptions(opts),
    trained_n: clean.length,
    global,
    segments,
  };
}

export function adjustForecastRow(row, profile, options = {}) {
  const opts = { ...DEFAULT_IMPROVEMENT_OPTIONS, ...profile?.options, ...options };
  const clean = normalizeImprovementRows([row])[0];
  if (!clean) return null;
  const rule = resolveRule(clean, profile, opts);
  const bias = rule?.bias_pp ?? 0;
  const probs = shiftProbabilities({
    up: clean.probability_up,
    flat: clean.probability_flat,
    down: clean.probability_down,
  }, bias, clean.sigma);
  const callGap = opts.callGapPp;
  const gap = probs.up - probs.down;
  const call = Math.abs(gap) >= callGap ? (gap > 0 ? 'up' : 'down') : 'no-call';

  return {
    ...clean,
    forecast_median: round4(clean.forecast_median + bias),
    forecast_low: round4(clean.forecast_low + bias),
    forecast_high: round4(clean.forecast_high + bias),
    probability_up: probs.up,
    probability_flat: probs.flat,
    probability_down: probs.down,
    call_direction: call,
    baselines: clean.baselines,
    improvement: {
      source: rule.source,
      key: rule.key,
      n: rule.n,
      bias_pp: bias,
      mean_signed_error_pp: rule.mean_signed_error_pp,
    },
  };
}

export function runWalkForwardReplay(rows, options = {}) {
  const opts = { ...DEFAULT_IMPROVEMENT_OPTIONS, ...options };
  const clean = normalizeImprovementRows(rows);
  const byDate = groupBy(clean, r => r.target_end_date);
  const train = [];
  const evaluations = [];
  let skippedN = 0;

  for (const date of Object.keys(byDate).sort()) {
    const todays = byDate[date];
    if (train.length < opts.minGlobalRows) {
      skippedN += todays.length;
      train.push(...todays);
      continue;
    }

    const profile = buildImprovementProfile(train, opts);
    for (const originalRow of todays) {
      const adjustedRow = adjustForecastRow(originalRow, profile, opts);
      if (!adjustedRow?.improvement || adjustedRow.improvement.source === 'none') {
        skippedN += 1;
        continue;
      }
      const original = scoreVerification(originalRow, originalRow.actual_return);
      const adjusted = scoreVerification(adjustedRow, originalRow.actual_return);
      evaluations.push({
        id: originalRow.id,
        date,
        sector: originalRow.sector,
        train_n: train.length,
        source: adjustedRow.improvement.source,
        bias_pp: adjustedRow.improvement.bias_pp,
        original,
        adjusted,
        original_forecast_median: originalRow.forecast_median,
        adjusted_forecast_median: adjustedRow.forecast_median,
        actual_return: round4(originalRow.actual_return),
      });
    }
    train.push(...todays);
  }

  const summary = summarizeReplay(evaluations, skippedN, opts);
  return {
    engine_version: IMPROVEMENT_ENGINE_VERSION,
    options: publicOptions(opts),
    summary,
    evaluations,
  };
}

export function buildImprovementLoop(rows, options = {}) {
  const opts = { ...DEFAULT_IMPROVEMENT_OPTIONS, ...options };
  const clean = normalizeImprovementRows(rows);
  const replay = runWalkForwardReplay(clean, opts);
  const next_profile = buildImprovementProfile(clean, opts);
  const gate = evaluateReplayGate(replay.summary, opts);
  return {
    engine_version: IMPROVEMENT_ENGINE_VERSION,
    trained_rows: clean.length,
    replay,
    next_profile,
    gate,
  };
}

export function formatImprovementLoopReport(loop) {
  const s = loop?.replay?.summary;
  const g = loop?.gate;
  const p = loop?.next_profile;
  if (!s || !g || !p) return '개선 루프: 계산 결과 없음';

  const lines = [];
  lines.push('개선 루프 shadow 검증');
  lines.push(`- 학습 표본: ${loop.trained_rows}건 / walk-forward 재검증: ${s.evaluated_n}건, 제외 ${s.skipped_n}건`);
  if (s.evaluated_n) {
    lines.push(`- 원 예측 MAE ${fmt(s.original_mae_pp)}%p -> 개선 MAE ${fmt(s.adjusted_mae_pp)}%p (${fmt(s.mae_gain_pp)}%p 개선)`);
    lines.push(`- 방향 적중 ${pct(s.original_direction_hit_rate)} -> ${pct(s.adjusted_direction_hit_rate)}, 범위 적중 ${pct(s.original_in_range_rate)} -> ${pct(s.adjusted_in_range_rate)}`);
  }
  lines.push(`- 다음 예측용 shadow bias: global ${fmt(p.global.bias_pp)}%p (n=${p.global.n})`);
  lines.push(`- 판정: ${g.decision} (${g.reasons.join(', ')})`);
  return lines.join('\n');
}

export function evaluateReplayGate(summary, options = {}) {
  const opts = { ...DEFAULT_IMPROVEMENT_OPTIONS, ...options };
  if (!summary || summary.evaluated_n < opts.minReplayRows) {
    return {
      decision: 'HOLD_SHADOW',
      eligible: false,
      reasons: [`need_${opts.minReplayRows}_replay_rows`],
    };
  }

  const reasons = [];
  if (summary.mae_gain_pp < opts.minMaeGainPp) reasons.push(`mae_gain_lt_${opts.minMaeGainPp}`);
  if (summary.direction_delta < opts.minDirectionDelta) reasons.push(`direction_delta_lt_${opts.minDirectionDelta}`);
  if (summary.brier_delta > opts.maxBrierWorsen) reasons.push(`brier_worsen_gt_${opts.maxBrierWorsen}`);

  return {
    decision: reasons.length ? 'HOLD_SHADOW' : 'SHADOW_CANDIDATE',
    eligible: reasons.length === 0,
    reasons: reasons.length ? reasons : ['walk_forward_gate_passed_shadow_only'],
  };
}

function summarizeBias(rows, opts) {
  const errors = rows.map(r => round4(r.actual_return - r.forecast_median));
  const meanSigned = mean(errors);
  const bias = clip(round4(meanSigned * opts.shrinkage), -opts.maxBiasPp, opts.maxBiasPp);
  const absErrors = errors.map(Math.abs);
  const misses = rows.filter(r => truthy(r.structural_miss)).length;
  return {
    n: rows.length,
    mean_signed_error_pp: round4(meanSigned),
    mean_abs_error_pp: round4(mean(absErrors)),
    bias_pp: round4(bias),
    structural_miss_rate: rows.length ? round4(misses / rows.length) : 0,
    top_error_causes: topCounts(rows.map(r => r.error_cause).filter(Boolean), 3),
  };
}

function resolveRule(row, profile, opts) {
  if (!profile) return { source: 'none', key: null, n: 0, bias_pp: 0, mean_signed_error_pp: 0 };
  const key = segmentKey(row);
  const segment = profile.segments?.[key];
  if (segment && segment.n >= opts.minSegmentRows) {
    return { source: 'segment', key, ...segment };
  }
  if (profile.global && profile.global.n >= opts.minGlobalRows) {
    return { source: 'global', key: 'global', ...profile.global };
  }
  return { source: 'none', key: null, n: 0, bias_pp: 0, mean_signed_error_pp: 0 };
}

function shiftProbabilities(input, bias, sigma) {
  const probs = normalizeProbs(input);
  const boost = Math.min(20, Math.max(0, Math.round((Math.abs(bias) / Math.max(Math.abs(sigma) || 0, 0.0001)) * 10)));
  if (!boost) return probs;
  if (bias > 0) moveProbability(probs, 'up', ['down', 'flat'], boost);
  else moveProbability(probs, 'down', ['up', 'flat'], boost);
  return normalizeProbs(probs);
}

function moveProbability(probs, target, donors, boost) {
  let left = boost;
  for (const donor of donors) {
    if (left <= 0) break;
    const take = Math.min(left, probs[donor]);
    probs[donor] -= take;
    probs[target] += take;
    left -= take;
  }
}

function normalizeProbs(input) {
  const raw = {
    up: Math.max(0, Number(input.up) || 0),
    flat: Math.max(0, Number(input.flat) || 0),
    down: Math.max(0, Number(input.down) || 0),
  };
  const total = raw.up + raw.flat + raw.down || 1;
  const scaled = Object.entries(raw).map(([k, v]) => ({ k, v: (v / total) * 100 }));
  const floored = scaled.map(({ k, v }) => ({ k, f: Math.floor(v), r: v - Math.floor(v) }));
  let remain = 100 - floored.reduce((a, x) => a + x.f, 0);
  floored.sort((a, b) => b.r - a.r);
  for (const x of floored) {
    if (remain <= 0) break;
    x.f += 1;
    remain -= 1;
  }
  return Object.fromEntries(floored.map(x => [x.k, x.f]));
}

function summarizeReplay(evaluations, skippedN, opts) {
  const n = evaluations.length;
  if (!n) {
    return {
      evaluated_n: 0,
      skipped_n: skippedN,
      original_mae_pp: null,
      adjusted_mae_pp: null,
      mae_gain_pp: null,
      original_direction_hit_rate: null,
      adjusted_direction_hit_rate: null,
      direction_delta: null,
      original_in_range_rate: null,
      adjusted_in_range_rate: null,
      brier_delta: null,
      gate: evaluateReplayGate({ evaluated_n: 0 }, opts),
    };
  }
  const originalMae = mean(evaluations.map(e => e.original.abs_error));
  const adjustedMae = mean(evaluations.map(e => e.adjusted.abs_error));
  const originalDir = rate(evaluations, e => e.original.direction_hit);
  const adjustedDir = rate(evaluations, e => e.adjusted.direction_hit);
  const originalRange = rate(evaluations, e => e.original.in_range);
  const adjustedRange = rate(evaluations, e => e.adjusted.in_range);
  const originalBrier = mean(evaluations.map(e => e.original.brier));
  const adjustedBrier = mean(evaluations.map(e => e.adjusted.brier));
  return {
    evaluated_n: n,
    skipped_n: skippedN,
    original_mae_pp: round4(originalMae),
    adjusted_mae_pp: round4(adjustedMae),
    mae_gain_pp: round4(originalMae - adjustedMae),
    original_direction_hit_rate: round4(originalDir),
    adjusted_direction_hit_rate: round4(adjustedDir),
    direction_delta: round4(adjustedDir - originalDir),
    original_in_range_rate: round4(originalRange),
    adjusted_in_range_rate: round4(adjustedRange),
    original_brier_mean: round4(originalBrier),
    adjusted_brier_mean: round4(adjustedBrier),
    brier_delta: round4(adjustedBrier - originalBrier),
  };
}

function publicOptions(opts) {
  return {
    minGlobalRows: opts.minGlobalRows,
    minSegmentRows: opts.minSegmentRows,
    shrinkage: opts.shrinkage,
    maxBiasPp: opts.maxBiasPp,
    callGapPp: opts.callGapPp,
    minReplayRows: opts.minReplayRows,
    minMaeGainPp: opts.minMaeGainPp,
    minDirectionDelta: opts.minDirectionDelta,
    maxBrierWorsen: opts.maxBrierWorsen,
  };
}

function groupBy(rows, keyFn) {
  const out = {};
  for (const row of rows) {
    const key = keyFn(row);
    (out[key] ??= []).push(row);
  }
  return out;
}

function topCounts(xs, limit) {
  const counts = {};
  for (const x of xs) counts[x] = (counts[x] || 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, n]) => ({ value, n }));
}

function parseJsonMaybe(value) {
  if (!value || typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function truthy(x) {
  return x === true || x === 'true' || x === 1 || x === '1';
}

function mean(xs) {
  const finite = xs.filter(Number.isFinite);
  return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : 0;
}

function rate(xs, pred) {
  return xs.length ? xs.filter(pred).length / xs.length : 0;
}

function clip(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function round4(x) {
  return Number.isFinite(Number(x)) ? Math.round(Number(x) * 10000) / 10000 : null;
}

function fmt(x) {
  return x == null ? '-' : Number(x).toFixed(2);
}

function pct(x) {
  return x == null ? '-' : `${Math.round(Number(x) * 100)}%`;
}
