import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLlmJson, sanitizeRows, buildVerificationPrompt, buildDailyPrompt,
  analyzeVerifications, analyzeDaily, llmEnabled, ERROR_CATEGORIES,
} from '../forecast-llm.mjs';

test('parseLlmJson — 코드펜스·잡텍스트 제거 후 JSON 추출', () => {
  assert.deepEqual(parseLlmJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseLlmJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseLlmJson('서두 텍스트 {"a":{"b":2}} 꼬리'), { a: { b: 2 } });
  assert.equal(parseLlmJson('JSON 없음'), null);
  assert.equal(parseLlmJson(''), null);
  assert.equal(parseLlmJson('{"broken":'), null);
});

test('sanitizeRows — 범주·등급·id 강제', () => {
  const valid = new Set([1, 2]);
  const rows = sanitizeRows([
    { id: 1, error_cause: '변동성 과소평가', cause_certainty: '확인됨', note: 'ok' },
    { id: 2, error_cause: '내가 지어낸 원인', cause_certainty: '거의 확실', note: 'x'.repeat(500) },
    { id: 99, error_cause: '확인 불가', cause_certainty: '확인 불가', note: '원장에 없는 id' },
    { id: 1.0, error_cause: null, cause_certainty: null, note: null },
  ], valid);
  assert.equal(rows.length, 3); // id 99 탈락
  assert.equal(rows[0].error_cause, '변동성 과소평가');
  assert.equal(rows[1].error_cause, null); // 규칙 밖 범주 → null 강등
  assert.equal(rows[1].cause_certainty, null);
  assert.equal(rows[1].note.length, 200); // 노트 길이 제한
});

test('sanitizeRows — 원인 있는데 등급 누락 시 "확인 불가"로 보수 강등', () => {
  const rows = sanitizeRows([{ id: 1, error_cause: '인과관계 오판', cause_certainty: '이상한값', note: '' }], new Set([1]));
  assert.equal(rows[0].error_cause, '인과관계 오판');
  assert.equal(rows[0].cause_certainty, '확인 불가');
});

test('프롬프트 — 13범주·금지 규칙·JSON-only 지시 포함', () => {
  const p = buildVerificationPrompt({ verified: [] });
  for (const c of ERROR_CATEGORIES) assert.ok(p.includes(c));
  assert.ok(p.includes('사후 스토리텔링 금지'));
  assert.ok(p.includes('매수·매도 추천'));
  const d = buildDailyPrompt({});
  assert.ok(d.includes('20거래일'));
});

test('analyzeVerifications — mock invoke로 파이프라인 검증 (CLI 미호출)', () => {
  const payload = { verified: [{ id: 7 }] };
  const mockOut = '{"narrative":"시장 분석 내러티브.","rows":[{"id":7,"error_cause":"확인 불가","cause_certainty":"확인 불가","note":"n"}]}';
  const res = analyzeVerifications(payload, { invoke: () => mockOut });
  assert.equal(res.narrative, '시장 분석 내러티브.');
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].id, 7);
  // 파싱 불가 출력 → null (보고는 계속 나가야 하므로 throw 금지)
  assert.equal(analyzeVerifications(payload, { invoke: () => '엉뚱한 텍스트' }), null);
});

test('analyzeDaily — mock invoke', () => {
  const res = analyzeDaily({}, { invoke: () => '{"narrative":"결산 해설."}' });
  assert.equal(res.narrative, '결산 해설.');
  assert.equal(analyzeDaily({}, { invoke: () => '{}' }), null);
});

test('llmEnabled — FORECAST_LLM=0으로만 비활성', () => {
  assert.equal(llmEnabled({}), true);
  assert.equal(llmEnabled({ FORECAST_LLM: '0' }), false);
  assert.equal(llmEnabled({ FORECAST_LLM: '1' }), true);
});

test('validateReport — 금지 문구·필수 섹션 검사', async () => {
  const { validateReport } = await import('../forecast-llm.mjs');
  const ok = '📊 시장 전망\n【데이터 상태】x\n【코스피 전망】y\n【코스닥 전망】z\n【직전 예측 검증】w\n' + 'a'.repeat(300);
  assert.equal(validateReport(ok), null);
  assert.match(validateReport(ok + '(합 100)'), /금지 문구/);
  assert.match(validateReport(ok + 'AI 세부 분석'), /금지 문구/);
  assert.match(validateReport(ok + '10번 중 8번'), /금지 문구/);
  assert.match(validateReport(ok.replace('【코스닥 전망】', '')), /섹션 누락/);
  assert.match(validateReport('짧음'), /짧음/);
});

test('validateReport — 규칙 §3의 나머지 금지 문구도 코드로 막는다', async () => {
  const { validateReport, BANNED_PHRASES } = await import('../forecast-llm.mjs');
  const ok = '📊\n【데이터 상태】x\n【코스피 전망】y\n【코스닥 전망】z\n【직전 예측 검증】w\n' + 'a'.repeat(300);
  for (const b of ['80% 범위', '80% 예상 범위', '적중 목표 80%']) {
    assert.ok(BANNED_PHRASES.includes(b), `${b}가 BANNED_PHRASES에 있어야 함`);
    assert.match(validateReport(ok + b), /금지 문구/);
  }
});

test('validateReport — 소수 2자리 초과 반려', async () => {
  const { validateReport } = await import('../forecast-llm.mjs');
  const ok = '📊\n【데이터 상태】x\n【코스피 전망】y\n【코스닥 전망】z\n【직전 예측 검증】w\n' + 'a'.repeat(300);
  assert.equal(validateReport(ok + ' +0.09%'), null);
  assert.match(validateReport(ok + ' +0.0879%'), /소수 2자리 초과/);
});

// ── 엔진 숫자 충실도 (프롬프트 §1·§2·§10을 기계 검사로) ────────────
const engPayload = (over = {}) => ({
  engine: [{ name: '코스피', median_pct: 0.3, prob_up: 45, prob_flat: 20, prob_down: 35, ...over }],
});
const kospiSection = ({ ret = '+0.30', lo = '-1.70', hi = '+2.30',
  up = '45', flat = '20', down = '35', dir = '약한 상승 우세' } = {}) =>
  `📊\n【데이터 상태】x\n【코스피 전망】\n${dir} · 확신도: 보통\n` +
  `· 예상 수익률: ${ret}% · 예상 범위(±2%p): ${lo}% ~ ${hi}%\n` +
  `· 오름 ${up}% · 보합 ${flat}% · 내림 ${down}%\n` +
  `판단 근거:\n1. 관측\n【코스닥 전망】z\n【직전 예측 검증】w\n` + 'a'.repeat(300);

test('checkEngineFidelity — 충실한 보고서는 통과', async () => {
  const { validateReport } = await import('../forecast-llm.mjs');
  assert.equal(validateReport(kospiSection(), engPayload()), null);
});

test('checkEngineFidelity — 예상 수익률 조작 탐지 (§1)', async () => {
  const { validateReport } = await import('../forecast-llm.mjs');
  const err = validateReport(kospiSection({ ret: '+0.80', lo: '-1.20', hi: '+2.80' }), engPayload());
  assert.match(err, /예상 수익률 0\.8% — engine 값 0\.3%/);
});

test('checkEngineFidelity — ±2%p 범위 산술 오류 탐지 (§10)', async () => {
  const { validateReport } = await import('../forecast-llm.mjs');
  assert.match(validateReport(kospiSection({ lo: '-1.20' }), engPayload()), /범위 하한/);
  assert.match(validateReport(kospiSection({ hi: '+2.00' }), engPayload()), /범위 상한/);
});

test('checkEngineFidelity — 확률 조작 탐지 (§1)', async () => {
  const { validateReport } = await import('../forecast-llm.mjs');
  assert.match(validateReport(kospiSection({ up: '60' }), engPayload()), /오름 60% — engine 값 45%/);
});

test('checkEngineFidelity — 방향 문구 ↔ 확률차 모순 탐지 (§2, 8%p 기준)', async () => {
  const { validateReport } = await import('../forecast-llm.mjs');
  // gap = 45-35 = 10%p ≥ 8 → 상승 우세여야 하는데 혼조로 씀
  assert.match(validateReport(kospiSection({ dir: '혼조' }), engPayload()), /상승 우세 표기가 아님/);
  // gap = 42-40 = 2%p < 8 → 혼조여야 하는데 상승 우세로 씀
  assert.match(
    validateReport(kospiSection({ up: '42', down: '40' }), engPayload({ prob_up: 42, prob_down: 40 })),
    /혼조/,
  );
  // gap = -10%p → 하락 우세여야 하는데 상승 우세로 씀
  assert.match(
    validateReport(kospiSection({ up: '35', down: '45' }), engPayload({ prob_up: 35, prob_down: 45 })),
    /하락 우세 표기가 아님/,
  );
});

test('checkEngineFidelity — 매핑 모호(동일 시장 2행)하면 건너뛴다 (오탐 방지)', async () => {
  const { checkEngineFidelity } = await import('../forecast-llm.mjs');
  const dup = { engine: [
    { name: '코스피', median_pct: 0.3, prob_up: 45, prob_flat: 20, prob_down: 35 },
    { name: '코스피', median_pct: 1.9, prob_up: 70, prob_flat: 10, prob_down: 20 },
  ] };
  assert.deepEqual(checkEngineFidelity(kospiSection(), dup), []);
});

test('checkEngineFidelity — payload 없으면 검사 생략 (하위 호환)', async () => {
  const { checkEngineFidelity } = await import('../forecast-llm.mjs');
  assert.deepEqual(checkEngineFidelity(kospiSection(), null), []);
  assert.deepEqual(checkEngineFidelity(kospiSection(), { engine: [] }), []);
});

test('composeReport — 위반 되먹임 후 1회 재시도로 복구', async () => {
  const { composeReport } = await import('../forecast-llm.mjs');
  const prompts = [];
  let n = 0;
  const invoke = (p) => {
    prompts.push(p);
    return ++n === 1 ? kospiSection({ ret: '+0.80', lo: '-1.20', hi: '+2.80' }) : kospiSection();
  };
  const res = composeReport({ ...engPayload(), allow_websearch: false }, { invoke });
  assert.equal(res.error, null);
  assert.equal(res.attempts, 2);
  assert.match(prompts[1], /직전 시도가 아래 기계 검증에 걸렸다/);
  assert.match(prompts[1], /예상 수익률/);
});

test('composeReport — 재시도도 실패하면 폴백용 error 반환 (throw 금지)', async () => {
  const { composeReport } = await import('../forecast-llm.mjs');
  const res = composeReport({ ...engPayload(), allow_websearch: false },
    { invoke: () => kospiSection({ ret: '+0.80', lo: '-1.20', hi: '+2.80' }) });
  assert.equal(res.text, null);
  assert.match(res.error, /엔진 값 불일치/);
  assert.equal(res.attempts, 2);
});

test('composeReport — retries:0이면 재시도 없음', async () => {
  const { composeReport } = await import('../forecast-llm.mjs');
  let n = 0;
  const res = composeReport({ ...engPayload(), allow_websearch: false },
    { invoke: () => { n++; return kospiSection({ ret: '+0.80', lo: '-1.20', hi: '+2.80' }); }, retries: 0 });
  assert.equal(n, 1);
  assert.equal(res.attempts, 1);
});

test('buildReportPrompt — 45자 규칙이 수치 라인을 예외로 둔다 (템플릿 자체가 47자)', async () => {
  const { buildReportPrompt } = await import('../forecast-llm.mjs');
  const p = buildReportPrompt({ engine: [] });
  assert.ok(p.includes('자 수 제한을 적용하지 않는다'),
    '수치 라인 예외가 없으면 템플릿이 규칙을 위반하는 모순 상태');
});
