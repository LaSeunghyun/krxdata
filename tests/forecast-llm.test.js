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
