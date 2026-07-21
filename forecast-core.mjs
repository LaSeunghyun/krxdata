/**
 * forecast-core.mjs — 시장 예측 원장의 순수 통계 엔진 (I/O 없음, 전부 테스트 가능)
 *
 * 설계: docs/superpowers/specs/2026-07-21-krxdata-market-forecast-ledger-design.md
 *  - 숫자(중앙값·80% 구간·확률)는 전부 이 엔진이 산출한다. LLM은 조정만 담당(Phase 1.5).
 *  - 분포는 정규 가정 없이 경험 분위수. 보합 밴드는 ±FLAT_BAND_K×σ로 구간 길이에 자동 스케일.
 *  - 기준모형 3종(0%·직전구간 지속·최근 20구간 평균)은 예측 시점에 함께 고정한다.
 */

export const ENGINE_VERSION = 'fc-engine-v2'; // v2(2026-07-21): 잔차 EWMA σ·조건부 수축 블렌드·확률기반 콜 게이트·Winkler (codex 리뷰 반영)
export const FLAT_BAND_K = 0.25;   // 보합 밴드 = ±0.25σ
export const MEDIAN_SHRINK = 0.3;  // 중앙값 = 0.3 × 최근 20구간 평균 (과신 방지 수축)
export const MEDIAN_CAP_SIGMA = 0.5; // 중앙값 상한 = ±0.5σ
export const DEFAULT_CALL_K = 0.5; // (v1 잔재 — v2는 확률 차 기준)
export const RANGE_CAP_PP = 10; // 80% 범위 총폭 상한 10%p (사용자 지시 2026-07-21). 절단 시 range_capped 표기
export const STRUCTURAL_MISS_PP = 2.0; // |실제−예측중앙값| ≥ 2%p면 "구조적 미스"(사용자 지시 2026-07-21) → 원인분석·개선 트리거

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

// EWMA 표준편차 — 잔차 기반(EWMA 평균 제거). zero-mean 방식은 추세장에서 drift가
// σ에 섞여 과대추정된다 (codex 리뷰 P: "변동성"은 방향성 제외 잔차여야 함)
export function ewmaStd(returns, lambda = 0.94) {
  if (!returns.length) return 0;
  let mu = returns[0];
  let v = 0;
  for (let i = 1; i < returns.length; i++) {
    const resid = returns[i] - mu;
    v = lambda * v + (1 - lambda) * resid * resid;
    mu = lambda * mu + (1 - lambda) * returns[i];
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

  // 조건부 표본(전일 등락 유사일)은 하드 스위치가 아니라 표본수 비례 수축 블렌드로 섞는다
  // w = n/(n+8): n=4면 33%, n=8이면 50%, n=24면 75% (codex 리뷰: n≥8 스위치는 정보 낭비)
  const condXs = Array.isArray(opts.condReturns) ? opts.condReturns : [];
  const condW = condXs.length / (condXs.length + 8);
  const m20 = condXs.length
    ? condW * mean(condXs) + (1 - condW) * mean(last20)
    : mean(last20);
  const capped = Math.max(-MEDIAN_CAP_SIGMA * sigma,
    Math.min(MEDIAN_CAP_SIGMA * sigma, MEDIAN_SHRINK * m20));
  const median = round4(capped);

  const m = mean(hist);
  let low = round4(median + quantile(hist.map(r => r - m), 0.10));
  let high = round4(median + quantile(hist.map(r => r - m), 0.90));
  // 총폭 상한: 중앙값 기준 비례 절단(비대칭 유지). 절단되면 명목 80% 구간이 아니므로
  // range_capped를 원장·보고에 남긴다 — 커버리지 채점이 그 비용을 정직하게 보여준다.
  const cap = opts.rangeCapPp ?? RANGE_CAP_PP;
  let rangeCapped = false;
  if (high - low > cap) {
    const scale = cap / (high - low);
    low = round4(median + (low - median) * scale);
    high = round4(median + (high - median) * scale);
    rangeCapped = true;
  }
  const probs = probsFromHistory(hist, median, band);

  // 콜 게이트는 채점 대상과 동일한 최종 확률분포 기준: 우세 확률 차 ≥ CALL_GAP_PP(기본 15%p).
  // (codex P4: |m20| 같은 중간 신호가 아니라 확률 기반 정책 + 콜 비율 상시 병기)
  const callGapPp = opts.callGapPp ?? 15;
  const probGap = probs.up - probs.down;
  const call = Math.abs(probGap) >= callGapPp ? (probGap > 0 ? 'up' : 'down') : 'no-call';

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
    median, low, high, range_capped: rangeCapped, sigma: round4(sigma), band: round4(band),
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
  // 범위 적중 = 예측 중앙값 ±2%p 이내 (2026-07-22 사용자 지시: 80% 경험분위수 대신 고정 ±2% 밴드).
  //   in_range = !structural_miss (둘 다 |실제−중앙값| 기준). engine의 forecast_low/high(80%분위)는 Winkler·원장 기록용으로만 잔존.
  const inRange = absError < STRUCTURAL_MISS_PP;
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

  // Winkler 구간점수(α=0.2, 낮을수록 좋음) — 커버리지만 보면 구간을 넓혀 게이밍 가능하므로
  // 폭 + 이탈 페널티를 함께 채점한다 (codex 리뷰: L1은 커버리지·구간폭 동시 통과여야)
  const lo = Number(row.forecast_low), hi = Number(row.forecast_high);
  const winkler = round4((hi - lo)
    + (2 / 0.2) * Math.max(0, lo - actualReturn)
    + (2 / 0.2) * Math.max(0, actualReturn - hi));

  // 구조적 미스: 예측 중앙값에서 실제가 STRUCTURAL_MISS_PP(2%p) 이상 벗어남 → 원인분석·개선 트리거
  const structuralMiss = absError >= STRUCTURAL_MISS_PP;

  return {
    actual_return: round4(actualReturn),
    actual_class: actualClass,
    pred_class: predClass,
    direction_hit: directionHit,
    partial_hit: partialHit,
    abs_error: absError,
    in_range: inRange,
    brier,
    winkler,
    call_result: callResult,
    structural_miss: structuralMiss,
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
  const winklers = rows.map(r => Number(r.winkler)).filter(Number.isFinite);
  const maes = rows.map(r => Number(r.abs_error)).filter(Number.isFinite);
  const beat = rows.filter(r => r.baseline_scores?.beat_all).length;
  return {
    n,
    direction_hit_rate: round4(fullHits / n),
    partial_count: partials,
    coverage_80: round4(inRange / n),
    mae: round4(mean(maes)),
    brier_mean: round4(mean(briers)),
    winkler_mean: winklers.length ? round4(mean(winklers)) : null,
    call_count: calls.length,
    call_hit_rate: calls.length ? round4(callHits / calls.length) : null,
    beat_all_baselines_rate: round4(beat / n),
  };
}

// 구조적 미스(2%p↑) 집계 → 반복 원인 있으면 재캘리브레이션 권고 (개선 루프).
// 게이트: 전체 표본 ≥ minSample(20거래일 규칙) AND 특정 원인 ≥ minCause 반복일 때만 권고.
// 단일 이상치(외부충격)는 권고 안 함 — 근거 없는 조기 파라미터 변경 방지.
export function summarizeStructuralMisses(rows, { minSample = 20, minCause = 3 } = {}) {
  const misses = rows.filter(r => r.structural_miss);
  const byCause = {};
  for (const r of misses) {
    const c = r.error_cause || '미분류';
    byCause[c] = (byCause[c] || 0) + 1;
  }
  let dominantCause = null, dominantN = 0;
  for (const [c, n] of Object.entries(byCause)) if (n > dominantN) { dominantCause = c; dominantN = n; }
  const recommend = rows.length >= minSample && dominantN >= minCause;
  return { total: rows.length, missCount: misses.length, byCause, dominantCause, dominantN, recommend };
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
