import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mean, quantile, ewmaStd, classify, roundProbs100, probsFromHistory,
  buildForecast, scoreVerification, summarizeVerifications,
  FLAT_BAND_K, DEFAULT_CALL_K,
} from '../forecast-core.mjs';

// 재현 가능한 의사난수 수익률 (Date.now/Math.random 미사용 컨벤션 준수)
function synthReturns(n, { drift = 0, vol = 1, seed = 7 } = {}) {
  const out = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const u1 = (s + 1) / 2147483649;
    s = (s * 1103515245 + 12345) % 2147483648;
    const u2 = (s + 1) / 2147483649;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out.push(drift + vol * z);
  }
  return out;
}

test('quantile — 경험 분위수 보간', () => {
  const xs = [1, 2, 3, 4, 5];
  assert.equal(quantile(xs, 0), 1);
  assert.equal(quantile(xs, 1), 5);
  assert.equal(quantile(xs, 0.5), 3);
  assert.ok(Math.abs(quantile(xs, 0.1) - 1.4) < 1e-9);
});

test('ewmaStd — 잔차 기반: 상수 drift는 σ에서 제외, 진동은 포함', () => {
  // v2: 상수 수익률 = 잔차 0 → σ ≈ 0 (drift가 변동성으로 잡히지 않는다)
  assert.ok(ewmaStd(Array(200).fill(0.8)) < 0.01);
  // ±0.8 진동은 잔차 ≈ ±0.8 → σ ≈ 0.8
  const osc = Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.8 : -0.8));
  const sd = ewmaStd(osc);
  assert.ok(Math.abs(sd - 0.8) < 0.05, `got ${sd}`);
});

test('classify — 보합 밴드 경계', () => {
  assert.equal(classify(0.3, 0.2), 'up');
  assert.equal(classify(-0.3, 0.2), 'down');
  assert.equal(classify(0.15, 0.2), 'flat');
  assert.equal(classify(0.2, 0.2), 'flat'); // 경계는 보합
});

test('roundProbs100 — 항상 합 100 정수', () => {
  for (const raw of [
    { up: 1, flat: 1, down: 1 },
    { up: 33.4, flat: 33.3, down: 33.3 },
    { up: 0.1, flat: 0.1, down: 99.8 },
    { up: 50, flat: 0, down: 50 },
  ]) {
    const p = roundProbs100(raw);
    assert.equal(p.up + p.flat + p.down, 100, JSON.stringify(p));
    assert.ok([p.up, p.flat, p.down].every(Number.isInteger));
  }
});

test('probsFromHistory — 중앙값 양수 이동 시 상승 확률 증가', () => {
  const hist = synthReturns(120, { vol: 1 });
  const band = 0.25;
  const neutral = probsFromHistory(hist, 0, band);
  const bullish = probsFromHistory(hist, 0.5, band);
  assert.ok(bullish.up > neutral.up);
  assert.ok(bullish.down < neutral.down);
});

test('buildForecast — 표본 부족 시 null', () => {
  assert.equal(buildForecast(synthReturns(5)), null);
});

test('buildForecast — 구조·불변식', () => {
  const f = buildForecast(synthReturns(200, { vol: 1.2 }));
  assert.ok(f);
  assert.ok(f.low < f.median && f.median < f.high, '구간이 중앙값을 포함해야');
  assert.equal(f.probs.up + f.probs.flat + f.probs.down, 100);
  assert.ok(f.sigma > 0);
  assert.ok(Math.abs(f.band - FLAT_BAND_K * f.sigma) < 1e-3); // 각각 round4라 미세 오차 허용
  assert.ok(f.confidence >= 10 && f.confidence <= 90);
  assert.equal(typeof f.baselines.b1_persist, 'number');
  assert.equal(f.drivers.length, 3);
});

test('buildForecast — 무추세면 no-call, 강추세면 방향 콜', () => {
  const flat = buildForecast(synthReturns(200, { drift: 0, vol: 1 }));
  assert.equal(flat.call, 'no-call');
  // 강한 상승 추세: 최근 20구간 평균이 크면 중앙값(0.3×m20, 상한 0.5σ)이 콜 문턱(0.5σ)에 닿는다
  const trending = [...synthReturns(180, { vol: 0.5 }), ...Array(20).fill(2.0)];
  const f = buildForecast(trending);
  assert.equal(f.call, 'up', JSON.stringify({ median: f.median, sigma: f.sigma, k: DEFAULT_CALL_K }));
});

test('buildForecast — 품질 등급이 신뢰도를 깎는다', () => {
  const rs = synthReturns(200);
  const a = buildForecast(rs, { qualityGrade: 'A' });
  const c = buildForecast(rs, { qualityGrade: 'C' });
  assert.ok(c.confidence < a.confidence);
});

test('scoreVerification — 방향 적중·범위·Brier', () => {
  const row = {
    forecast_median: 0.5, forecast_low: -0.8, forecast_high: 1.8,
    probability_up: 55, probability_flat: 25, probability_down: 20,
    flat_band: 0.2, sigma: 0.8, call_direction: 'up',
    baselines: { b0_zero: 0, b1_persist: -0.3, b2_mean20: 0.4 },
  };
  const v = scoreVerification(row, 0.9);
  assert.equal(v.actual_class, 'up');
  assert.equal(v.pred_class, 'up');
  assert.equal(v.direction_hit, true);
  assert.equal(v.in_range, true);
  assert.equal(v.call_result, 'hit');
  assert.equal(v.partial_hit, false); // |0.9-0.5|=0.4 < σ0.8 → 강도도 대체로 맞음
  // Brier: (0.55-1)² + 0.25² + 0.20² = 0.2025+0.0625+0.04 = 0.305
  assert.ok(Math.abs(v.brier - 0.305) < 1e-9);
  assert.equal(v.baseline_scores.b1_persist.direction_hit, false);
  assert.equal(v.baseline_scores.b2_mean20.direction_hit, true);
});

test('scoreVerification — 방향 맞고 강도 크게 틀리면 partial_hit', () => {
  const row = {
    forecast_median: 0.3, forecast_low: -0.5, forecast_high: 1.1,
    probability_up: 60, probability_flat: 25, probability_down: 15,
    flat_band: 0.2, sigma: 0.8, call_direction: 'no-call',
    baselines: {},
  };
  const v = scoreVerification(row, 3.0); // 방향은 up 적중, 오차 2.7 > σ
  assert.equal(v.direction_hit, true);
  assert.equal(v.partial_hit, true);
  assert.equal(v.in_range, false);
  assert.equal(v.call_result, null);
});

test('scoreVerification — 하락 미스', () => {
  const row = {
    forecast_median: 0.4, forecast_low: -0.6, forecast_high: 1.4,
    probability_up: 50, probability_flat: 30, probability_down: 20,
    flat_band: 0.2, sigma: 0.8, call_direction: 'up',
    baselines: { b0_zero: 0 },
  };
  const v = scoreVerification(row, -1.0);
  assert.equal(v.actual_class, 'down');
  assert.equal(v.direction_hit, false);
  assert.equal(v.call_result, 'miss');
  // b0(0%)의 방향은 flat — 실제 down이므로 기준모형도 미적중
  assert.equal(v.baseline_scores.b0_zero.direction_hit, false);
  // 우리 오차 1.4 > b0 오차 1.0 → beat_all=false
  assert.equal(v.baseline_scores.beat_all, false);
});

test('summarizeVerifications — 집계 필드, 부분적중은 헤드라인 적중률에서 제외', () => {
  const rows = [
    { direction_hit: true, partial_hit: false, in_range: true, call_result: 'hit', brier: 0.2, abs_error: 0.3, baseline_scores: { beat_all: true } },
    { direction_hit: false, partial_hit: false, in_range: true, call_result: null, brier: 0.8, abs_error: 1.1, baseline_scores: { beat_all: false } },
    { direction_hit: true, partial_hit: true, in_range: false, call_result: 'miss', brier: 0.4, abs_error: 0.6, baseline_scores: { beat_all: false } },
    { direction_hit: true, partial_hit: false, in_range: true, call_result: null, brier: 0.3, abs_error: 0.2, baseline_scores: { beat_all: true } },
  ];
  const s = summarizeVerifications(rows);
  assert.equal(s.n, 4);
  assert.equal(s.direction_hit_rate, 0.5); // 완전 적중 2건만 (부분적중 1건은 제외)
  assert.equal(s.partial_count, 1);
  assert.equal(s.coverage_80, 0.75);
  assert.equal(s.call_count, 2);
  assert.equal(s.call_hit_rate, 0.5);
  assert.equal(s.beat_all_baselines_rate, 0.5);
  assert.equal(summarizeVerifications([]), null);
});

test('buildForecast — 조건부 표본(condReturns)이 중앙값 방향을 바꾼다', () => {
  const rs = synthReturns(200, { drift: -0.3, vol: 1 }); // 일반 표본은 하락 편향
  const base = buildForecast(rs);
  const cond = buildForecast(rs, { condReturns: Array(12).fill(1.2) }); // 유사일 표본은 강한 양수
  assert.ok(cond.median > base.median, `${cond.median} > ${base.median}`);
  // v2 수축 블렌드: 소표본도 비례 반영 — n=5는 n=12보다 약하게
  const few = buildForecast(rs, { condReturns: Array(5).fill(1.2) });
  assert.ok(few.median > base.median && few.median < cond.median,
    `${base.median} < ${few.median} < ${cond.median}`);
});
