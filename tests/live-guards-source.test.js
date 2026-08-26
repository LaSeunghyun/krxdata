import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const live = readFileSync(join(ROOT, 'stock-live.mjs'), 'utf8');
const trader = readFileSync(join(ROOT, 'ai-trader.mjs'), 'utf8');
const tg = readFileSync(join(ROOT, 'telegram-agent.mjs'), 'utf8');

/**
 * 2026-08-26 사고의 4개 원인 중 3개가 "가드가 소스에는 있는데 실행 경로가 아니었다" 유형이었다.
 *   가드가 존재하는 것과 배선된 것은 다르다. stock-live.mjs 는 top-level await·무한루프라
 *   import 이 불가능해(두 번째 트레이더가 뜬다) 행위 테스트를 붙일 수 없으므로,
 *   여기서 소스 텍스트로 배선을 못 박는다.
 *
 * ★ 후보 0건은 "위반 없음"이 아니라 "판정 없음"이다. 코드 형태가 바뀌어 정규식이 죽으면
 *   루프가 0회 돌고 조용히 통과한다 — 그래서 모든 루프형 단언은 최소 후보 수를 먼저 단언한다.
 */

test('stock-live 가 소유권 판정을 실제로 호출한다', () => {
  assert.ok(/import\s*\{[^}]*classifyPosition[^}]*\}\s*from\s*'\.\/position-ownership\.mjs'/.test(live), 'classifyPosition import 가 없다');
  assert.ok(/classifyPosition\s*\(/.test(live), 'classifyPosition 호출이 없다 — 모듈만 있고 배선이 없다');
});

test('stock-live 가 예약청산 수량 상한을 실제로 호출한다', () => {
  assert.ok(/import\s*\{[^}]*plannedSellQty[^}]*\}\s*from\s*'\.\/exit-qty\.mjs'/.test(live), 'plannedSellQty import 가 없다');
  assert.ok(/plannedSellQty\s*\(/.test(live), 'plannedSellQty 호출이 없다');
});

test('상한 없는 옛 매도수량 산식이 되살아나지 않았다', () => {
  assert.ok(!/const\s+sellQty\s*=\s*frac\s*>=\s*1\s*\?\s*qty\s*:/.test(live),
    '브로커 보유수량을 그대로 파는 옛 산식이 남아 있다 — 08-26 재매수 143주 사고의 직접 원인');
});

test('부분익절 판정이 브로커 수량이 아니라 예약 상한 기준이다', () => {
  assert.ok(/const partial = sellQty < base;/.test(live), 'partial 이 base 기준이 아니다');
  assert.ok(!/const partial = sellQty < qty;/.test(live), 'partial 이 qty 기준으로 되돌아갔다 — 봇 몫 전량청산을 부분익절로 오판한다');
});

test('예약을 심는 모든 지점이 exitQty 를 같이 세운다', () => {
  const lines = live.split('\n');
  const hits = lines.map((l, i) => [l, i]).filter(([l]) => /\bm\.exitAt\s*=\s*[^=]/.test(l));
  // ★ 0건이면 "위반 없음"이 아니라 "판정 없음"이다. 정규식이 조용히 죽는 것을 막는다.
  assert.ok(hits.length >= 5, `예약 대입 지점을 ${hits.length}개만 찾았다 — 정규식이 죽었거나 코드 형태가 바뀌었다`);
  for (const [, i] of hits) {
    const win = lines.slice(i, i + 3).join('\n');
    assert.ok(/exitQty/.test(win), `stock-live.mjs:${i + 1} 예약 대입에 exitQty 가 없다 — 상한 없는 새 예약 경로가 추가됐다`);
  }
});

test('sellOk 가 sub 와 hold_days 를 검사한다', () => {
  const m = trader.match(/const sellOk = \(x\) => \{[\s\S]*?\n    \};/);
  assert.ok(m, 'sellOk 정의를 찾지 못했다 — 선언 형태가 바뀌면 이 대조가 조용히 죽는다');
  assert.ok(/h\.sub == null/.test(m[0]), 'sellOk 에 sub 검사가 없다 — 수동 포지션을 AI 가 팔 수 있다');
  assert.ok(/hold_days/.test(m[0]) && /minHoldDays/.test(m[0]), 'sellOk 에 보유일수 검사가 없다');
});

test('sellOk 는 TDZ 를 피해 AI_TRADER.rotate 를 직접 참조한다', () => {
  const m = trader.match(/const sellOk = \(x\) => \{[\s\S]*?\n    \};/);
  assert.ok(m, 'sellOk 정의를 찾지 못했다');
  assert.ok(/AI_TRADER\.rotate\.minHoldDays/.test(m[0]),
    'const R 은 sellOk 보다 아래에 선언돼 있어 R.minHoldDays 를 쓰면 호출 시 ReferenceError 다');
});

test('stock-live 가 텔레그램 요청을 소비한다', () => {
  assert.ok(/readRequestsAfter\s*\(/.test(live), 'readRequestsAfter 호출이 없다 — 승인해도 아무 일도 안 난다');
  assert.ok(/applyExitApproval\s*\(/.test(live) && /applyUnquarantine\s*\(/.test(live), '요청 핸들러 호출이 없다');
});

test('telegram-agent 가 청산승인·격리해제를 요청 채널로 보낸다', () => {
  assert.ok(/청산승인/.test(tg), '청산승인 파서가 없다');
  assert.ok(/appendRequest\s*\(\s*\{\s*type:\s*'ai_exit_approve'/.test(tg), '청산승인이 요청 채널에 적재되지 않는다');
  assert.ok(/appendRequest\s*\(\s*\{\s*type:\s*'unquarantine'/.test(tg), '격리해제가 요청 채널에 적재되지 않는다');
});

test('telegram-agent 는 자동 격리 파일을 직접 쓰지 않는다 (파일당 writer 1개 원칙)', () => {
  const code = tg.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/removeBotExcludeAuto|addBotExcludeAuto/.test(code),
    'telegram-agent 가 자동 격리 파일의 두 번째 writer 가 됐다 — 락 없는 read-modify-write 라 갱신이 유실된다');
});

test('판정용 저널 리더가 파괴적인 loadJournal 을 쓰지 않는다', () => {
  const m = live.match(/function readJournalTradesSafe\(\)[\s\S]*?\n\}/);
  assert.ok(m, 'readJournalTradesSafe 정의를 찾지 못했다');
  assert.ok(!/loadJournal/.test(m[0]),
    'loadJournal 은 손상 시 .corrupt 로 rename 하고 {trades:[]} 를 준다 — 그러면 봇 포지션이 전량 자동격리되고 검증된 손절이 사라진다');
  assert.ok(/return null/.test(m[0]), '실패를 null 로 구분하지 않으면 판정 보류가 불가능하다');
});

test('AI 청산이 사람 승인 경로를 탄다', () => {
  assert.ok(/AI_TRADER\.sellRequiresApproval/.test(live), 'sellRequiresApproval 분기가 없다');
  assert.ok(/state\.aiExitPending/.test(live), '제안 저장소가 없다');
  assert.ok(/briefDay: briefDayOf\(\)/.test(live), '권고문에 근거 브리핑 날짜가 실리지 않는다 — 사유 신선도를 사람이 판단할 수 없다');
});
