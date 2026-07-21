/**
 * forecast-core.mjs — 시장 예측 원장의 순수 통계 엔진 (I/O 없음, 전부 테스트 가능)
 *
 * 설계: docs/superpowers/specs/2026-07-21-krxdata-market-forecast-ledger-design.md
 *  - 숫자(중앙값·80% 구간·확률)는 전부 이 엔진이 산출한다. LLM은 조정만 담당(Phase 1.5).
 *  - 분포는 정규 가정 없이 경험 분위수. 보합 밴드는 ±FLAT_BAND_K×σ로 구간 길이에 자동 스케일.
 *  - 기준모형 3종(0%·직전구간 지속·최근 20구간 평균)은 예측 시점에 함께 고정한다.
 */

export const ENGINE_VERSION = 'fc-engine-v1';
export const FLAT_BAND_K = 0.25;   // 보합 밴드 = ±0.25σ
export const MEDIAN_SHRINK = 0.3;  // 중앙값 = 0.3 × 최근 20구간 평균 (과신 방지 수축)
export const MEDIAN_CAP_SIGMA = 0.5; // 중앙값 상한 = ±0.5σ
export const DEFAULT_CALL_K = 0.5; // |중앙값| ≥ 0.5σ 일 때만 방향 콜

// ── 기초 통계 ────────────────────────────────────────────────
export function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// 경험 분위수 (선형 보간, p ∈ [0,1])
export function quantile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

// EWMA 표준편차 (RiskMetrics λ=0.94, 평균 0 가정 — 일간 수익률 관행)
export function ewmaStd(returns, lambda = 0.94) {
  if (!returns.length) return 0;
  let v = returns[0] * returns[0];
  for (let i = 1; i < returns.length; i++) {
    v = lambda * v + (1 - lambda) * returns[i] * returns[i];
  }
  return Math.sqrt(v);
}

// ── 분류 ─────────────────────────────────────────────────────
export function classify(ret, band) {
  if (ret > band) return 'up';
  if (ret < -band) return 'down';
  return 'flat';
}

// 확률 합 100 보정 (최대 잔여법, 정수 %)
export function roundProbs100(raw) {
  const keys = ['up', 'flat', 'down'];
  const total = keys.reduce((a, k) => a + raw[k], 0) || 1;
  const scaled = keys.map(k => ({ k, v: (raw[k] / total) * 100 }));
  const floored = scaled.map(({ k, v }) => ({ k, f: Math.floor(v), r: v - Math.floor(v) }));
  let remain = 100 - floored.reduce((a, x) => a + x.f, 0);
  floored.sort((a, b) => b.r - a.r);
  for (const x of floored) { if (remain <= 0) break; x.f += 1; remain -= 1; }
  return Object.fromEntries(floored.map(x => [x.k, x.f]));
}

// 경험 분포(중앙값 중심 재배치) → 상승/보합/하락 확률 (+1 라플라스 평활)
export function probsFromHistory(returns, median, band) {
  const m = mean(returns);
  const counts = { up: 1, flat: 1, down: 1 };
  for (const r of returns) counts[classify(r - m + median, band)] += 1;
  return roundProbs100(counts);
}

// ── 예측 생성 ────────────────────────────────────────────────
/**
 * buildForecast(returns, opts) — 구간 수익률 이력(%)으로 원장 한 행의 숫자 전부 산출
 * @param returns 과거 구간 수익률 배열(%), 오래된 것부터. 최소 30개 권장.
 * @param opts { callK, qualityGrade }
 */
export function buildForecast(returns, opts = {}) {
  const callK = opts.callK ?? DEFAULT_CALL_K;
  const n = returns.length;
  if (n < 10) return null; // 표본 부족 — 예측 자체를 만들지 않는다

  const hist = returns.slice(-120);
  const last20 = returns.slice(-20);
  const sigma = ewmaStd(hist) || 0.0001;
  const band = FLAT_BAND_K * sigma;

  // 조건부 표본(전일 급락·급등 유사일 등)이 충분하면 단순 최근평균보다 우선한다 (§8 우선순위)
  const cond = Array.isArray(opts.condReturns) && opts.condReturns.length >= 8 ? opts.condReturns : null;
  const m20 = mean(cond ?? last20);
  const capped = Math.max(-MEDIAN_CAP_SIGMA * sigma,
    Math.min(MEDIAN_CAP_SIGMA * sigma, MEDIAN_SHRINK * m20));
  const median = round4(capped);

  const m = mean(hist);
  const low = round4(median + quantile(hist.map(r => r - m), 0.10));
  const high = round4(median + quantile(hist.map(r => r - m), 0.90));
  const probs = probsFromHistory(hist, median, band);

  // 콜 게이트는 수축·캡 전의 원신호(m20)로 판정한다. zero-mean EWMA는 σ ≥ |m20|이
  // 항상 성립해 캡된 median(≤0.5σ) 기준으로는 게이트가 발화 불가능하기 때문.
  // |m20| ≥ 0.5σ는 순수 노이즈에서 z≈2.2 (오발 ~2.5%) — 강추세에서만 콜.
  const call = Math.abs(m20) >= callK * sigma
    ? (m20 > 0 ? 'up' : 'down')
    : 'no-call';

  const baselines = {
    b0_zero: 0,
    b1_persist: round4(returns[n - 1]),
    b2_mean20: round4(m20),
  };

  let confidence = 60;
  if (hist.length >= 120) confidence += 10;
  if (hist.length < 60) confidence -= 20;
  if (opts.qualityGrade === 'B') confidence -= 10;
  if (opts.qualityGrade === 'C') confidence -= 30;
  confidence = Math.max(10, Math.min(90, confidence));

  return {
    median, low, high, sigma: round4(sigma), band: round4(band),
    probs, call, baselines, confidence,
    m20: round4(m20), nSamples: hist.length,
    drivers: [
      `최근20구간 평균 ${m20.toFixed(2)}% (수축 ${MEDIAN_SHRINK}배 적용)`,
      `EWMA 변동성 ${sigma.toFixed(2)}%, 보합밴드 ±${band.toFixed(2)}%`,
      `직전 구간 ${returns[n - 1].toFixed(2)}%`,
    ],
    invalidation: [
      `구간 내 ±${(2 * sigma).toFixed(1)}% 초과 급변(공시·해외발) 발생 시`,
      `데이터 지연으로 DATA_STALE 판정 시`,
    ],
  };
}

// ── 검증 채점 ────────────────────────────────────────────────
/**
 * scoreVerification(row, actualReturn)
 * @param row 원장 행 (forecast_median, forecast_low/high, probability_*, flat_band, sigma,
 *            call_direction, baselines)
 * @returns forecast_verification 컬럼 값
 */
export function scoreVerification(row, actualReturn) {
  const band = Number(row.flat_band) || 0;
  const sigma = Number(row.sigma) || 0;
  const median = Number(row.forecast_median) || 0;
  const probs = {
    up: Number(row.probability_up) / 100,
    flat: Number(row.probability_flat) / 100,
    down: Number(row.probability_down) / 100,
  };

  const actualClass = classify(actualReturn, band);
  const predClass = ['up', 'flat', 'down']
    .reduce((a, b) => (probs[a] >= probs[b] ? a : b));
  const directionHit = predClass === actualClass;
  const absError = round4(Math.abs(actualReturn - median));
  const inRange = actualReturn >= Number(row.forecast_low) && actualReturn <= Number(row.forecast_high);
  const partialHit = directionHit && predClass !== 'flat' && sigma > 0 && absError > sigma;

  // 다범주 Brier (0=완벽, 2=최악)
  const o = { up: 0, flat: 0, down: 0 };
  o[actualClass] = 1;
  const brier = round4(['up', 'flat', 'down']
    .reduce((a, k) => a + (probs[k] - o[k]) ** 2, 0));

  let callResult = null;
  if (row.call_direction === 'up' || row.call_direction === 'down') {
    callResult = row.call_direction === actualClass ? 'hit' : 'miss';
  }

  const bl = typeof row.baselines === 'string' ? JSON.parse(row.baselines) : (row.baselines ?? {});
  const baselineScores = {};
  for (const [k, pred] of Object.entries(bl)) {
    const p = Number(pred) || 0;
    baselineScores[k] = {
      abs_error: round4(Math.abs(actualReturn - p)),
      direction_hit: classify(p, band) === actualClass,
    };
  }
  const beatAll = Object.values(baselineScores).length > 0 &&
    Object.values(baselineScores).every(s => absError < s.abs_error);

  return {
    actual_return: round4(actualReturn),
    actual_class: actualClass,
    pred_class: predClass,
    direction_hit: directionHit,
    partial_hit: partialHit,
    abs_error: absError,
    in_range: inRange,
    brier,
    call_result: callResult,
    baseline_scores: { ...baselineScores, beat_all: beatAll },
  };
}

// ── 집계 (일일 결산) ─────────────────────────────────────────
export function summarizeVerifications(rows) {
  if (!rows.length) return null;
  const n = rows.length;
  // 부분 적중(방향 맞고 강도 크게 틀림)은 헤드라인 적중률에 합산하지 않는다 — 별도 카운트
  const fullHits = rows.filter(r => r.direction_hit && !r.partial_hit).length;
  const partials = rows.filter(r => r.partial_hit).length;
  const inRange = rows.filter(r => r.in_range).length;
  const calls = rows.filter(r => r.call_result);
  const callHits = calls.filter(r => r.call_result === 'hit').length;
  const briers = rows.map(r => Number(r.brier)).filter(Number.isFinite);
  const maes = rows.map(r => Number(r.abs_error)).filter(Number.isFinite);
  const beat = rows.filter(r => r.baseline_scores?.beat_all).length;
  return {
    n,
    direction_hit_rate: round4(fullHits / n),
    partial_count: partials,
    coverage_80: round4(inRange / n),
    mae: round4(mean(maes)),
    brier_mean: round4(mean(briers)),
    call_count: calls.length,
    call_hit_rate: calls.length ? round4(callHits / calls.length) : null,
    beat_all_baselines_rate: round4(beat / n),
  };
}

// 표본 요약 (조건부/일반 기준값 비교 표시용 — §8: 표본수·평균·중앙값·상승비율·범위)
export function sampleStats(xs) {
  if (!xs?.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: xs.length,
    mean: round4(mean(xs)),
    median: round4(quantile(xs, 0.5)),
    up_ratio: round4(xs.filter(r => r > 0).length / xs.length),
    min: round4(s[0]),
    max: round4(s[s.length - 1]),
  };
}

function round4(x) { return Math.round(x * 10000) / 10000; }
