import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJudgePrompt, judgeCandidate } from '../ai-judge.mjs';

const sig = {
  code: '005930',
  name: '삼성전자',
  news: [{
    title: '삼성전자 반도체 실적 개선',
    source: '예시경제',
    published: '2026-07-23T01:00:00.000Z',
    link: 'https://example.com/a',
    snippet: '반도체 업황 개선 기사',
  }],
  events: [],
};

test('buildJudgePrompt uses supplied news instead of asking for WebSearch', () => {
  const prompt = buildJudgePrompt(sig);

  assert.match(prompt, /제공된 뉴스/);
  assert.doesNotMatch(prompt, /WebSearch로/);
  assert.match(prompt, /삼성전자 반도체 실적 개선/);
});

test('judgeCandidate does not enable Claude WebSearch by default', () => {
  let capturedPrompt = '';
  const res = judgeCandidate(sig, {
    invoke: (prompt, options) => {
      capturedPrompt = prompt;
      assert.deepEqual(options?.extraArgs ?? [], []);
      return '{"decision":"skip","conviction":2,"catalyst":"뉴스 확인","thesis":[],"supporting":[],"opposing":["근거 부족"],"news_check":"제공 뉴스 확인"}';
    },
  });

  assert.equal(res.decision, 'skip');
  assert.match(capturedPrompt, /삼성전자 반도체 실적 개선/);
  assert.doesNotMatch(capturedPrompt, /WebSearch로/);
});
