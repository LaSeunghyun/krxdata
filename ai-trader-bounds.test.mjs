/**
 * ai-trader-bounds.test.mjs — parseDecision 권한 경계 단위 테스트.
 *
 * 이 레이어는 백테로 검증할 수 없다(과거 클로드 판단이 없다). 그래서 **경계가 기계적으로
 * 강제되는지**가 유일하게 사전 검증 가능한 부분이고, 그걸 여기서 못 박는다.
 * 실행: node ai-trader-bounds.test.mjs
 */
import { parseDecision } from './ai-trader.mjs';
import { AI_TRADER } from './strategy-contract.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};

/** 기본 컨텍스트 빌더 — 테스트마다 필요한 부분만 덮어쓴다. */
const ctxOf = (over = {}) => ({
  cands: [
    { code: 'C1', name: '후보1', sub: 'rsi2', px: 10000, conviction: 5 },
    { code: 'C2', name: '후보2', sub: 'hi120', px: 20000, conviction: 8 },
  ],
  holdings: [
    // rsi2 · 손절임박 · 유예 미사용 · 판정 전 → 유예 가능
    { code: 'H1', name: '보유1', sub: 'rsi2', ret_pct: -13, near_stop: true, exit_reserved: null, defer_used: 0, judged_today: false, ca_hold: false, hold_days: 3 },
    // 이익중 · 예약 없음 → 교체 매도 가능
    { code: 'H2', name: '보유2', sub: 'rsi2', ret_pct: 0.5, near_stop: false, exit_reserved: null, defer_used: 0, judged_today: false, ca_hold: false, hold_days: 4 },
    // 이미 예약됨 → 매도·교체·유예 전부 불가
    { code: 'H3', name: '보유3', sub: 'hi120', ret_pct: 12, near_stop: false, exit_reserved: '부분익절 tp2', defer_used: 0, judged_today: false, ca_hold: false, hold_days: 6 },
  ],
  rotateLeft: 1, sellLeft: 2, rotate: AI_TRADER.rotate,
  ...over,
});
const J = (o) => JSON.stringify(o);
const codes = (a) => (a ?? []).map(x => x.code);
const pairs = (a) => (a ?? []).map(x => `${x.sell_code}→${x.buy_code}`);

console.log('\n[buy] 매수는 후보 부분집합만 — AI 가 종목을 창작할 수 없다');
{
  const d = parseDecision(J({ skipAll: false, buy: [{ code: 'C1' }, { code: 'X9' }, { code: 'H1' }] }), ctxOf());
  eq('후보 C1 만 통과 (환각 X9·보유 H1 제거)', codes(d.buy), ['C1']);
  eq('제거분이 dropped 에 보고됨', d.dropped.buy, ['X9', 'H1']);
}
{
  const d = parseDecision(J({ skipAll: true, buy: [{ code: 'C1' }], rotate: [{ sell_code: 'H2', buy_code: 'C1' }] }), ctxOf());
  eq('skipAll 이면 buy 전멸', codes(d.buy), []);
  eq('skipAll 이면 rotate 도 전멸', pairs(d.rotate), []);
}

console.log('\n[sell] 보유분만 · 기존예약 제외 · 일일상한');
{
  const d = parseDecision(J({ skipAll: false, sell: [{ code: 'H1' }, { code: 'H3' }, { code: 'ZZ' }] }), ctxOf());
  eq('H1 만 통과 (H3=예약중 · ZZ=미보유)', codes(d.sell), ['H1']);
}
{
  const d = parseDecision(J({ skipAll: false, sell: [{ code: 'H1' }, { code: 'H2' }] }), ctxOf({ sellLeft: 1 }));
  eq('sellLeft 1 이면 1건만', codes(d.sell), ['H1']);
  eq('상한 초과분이 dropped 에 보고됨', d.dropped.sell, ['H2']);
}
{
  const d = parseDecision(J({ skipAll: false, sell: [{ code: 'H1' }, { code: 'H2' }] }), ctxOf({ sellLeft: 0 }));
  eq('sellLeft 0 이면 전멸', codes(d.sell), []);
}

console.log('\n[defer] rsi2 · 손절임박 · 미예약 · 포지션상한 · 판정전 · 절대하한');
{
  const d = parseDecision(J({ skipAll: false, defer_stop: [{ code: 'H1' }] }), ctxOf());
  eq('정상 케이스 통과', codes(d.defer), ['H1']);
}
{
  const c = ctxOf(); c.holdings[0].near_stop = false;
  eq('손절 임박 아니면 거부', codes(parseDecision(J({ skipAll: false, defer_stop: [{ code: 'H1' }] }), c).defer), []);
}
{
  const c = ctxOf(); c.holdings[0].defer_used = AI_TRADER.deferMaxPerPosition;
  eq(`포지션 유예 상한(${AI_TRADER.deferMaxPerPosition}) 소진 시 거부`, codes(parseDecision(J({ skipAll: false, defer_stop: [{ code: 'H1' }] }), c).defer), []);
}
{
  const c = ctxOf(); c.holdings[0].judged_today = true;
  eq('오늘 종가판정 완료면 거부(소비 시점 지남)', codes(parseDecision(J({ skipAll: false, defer_stop: [{ code: 'H1' }] }), c).defer), []);
}
{
  const c = ctxOf(); c.holdings[0].ret_pct = -(AI_TRADER.deferFloorPct + 1);
  eq(`절대하한 -${AI_TRADER.deferFloorPct}% 아래면 거부`, codes(parseDecision(J({ skipAll: false, defer_stop: [{ code: 'H1' }] }), c).defer), []);
}
{
  const c = ctxOf(); c.holdings[0].exit_reserved = 'AI판단(x)';
  eq('이미 예약된 청산은 유예로 취소되지 않는다', codes(parseDecision(J({ skipAll: false, defer_stop: [{ code: 'H1' }] }), c).defer), []);
}
{
  const c = ctxOf(); c.holdings[0].sub = 'hi120';
  eq('hi120 은 하드손절이 없어 유예 대상 아님', codes(parseDecision(J({ skipAll: false, defer_stop: [{ code: 'H1' }] }), c).defer), []);
}

console.log('\n[rotate] 짝 필수 · 매수측 승인 필수 · 손실상한 · 보유일 · 상한 · CA');
{
  const d = parseDecision(J({ skipAll: false, buy: [{ code: 'C1' }], rotate: [{ sell_code: 'H2', buy_code: 'C1' }] }), ctxOf());
  eq('정상 교체 통과', pairs(d.rotate), ['H2→C1']);
}
{
  const d = parseDecision(J({ skipAll: false, buy: [], rotate: [{ sell_code: 'H2', buy_code: 'C1' }] }), ctxOf());
  eq('매수측이 buy 승인목록에 없으면 거부(우회 차단)', pairs(d.rotate), []);
}
{
  const c = ctxOf(); c.holdings[1].ret_pct = -(AI_TRADER.rotate.maxSellLossPct + 1);
  eq(`손실 상한 -${AI_TRADER.rotate.maxSellLossPct}% 초과면 거부(손절 규칙에 맡김)`,
    pairs(parseDecision(J({ skipAll: false, buy: [{ code: 'C1' }], rotate: [{ sell_code: 'H2', buy_code: 'C1' }] }), c).rotate), []);
}
{
  const c = ctxOf(); c.holdings[1].hold_days = 0;
  eq('진입 당일(보유 0일) 교체 거부', pairs(parseDecision(J({ skipAll: false, buy: [{ code: 'C1' }], rotate: [{ sell_code: 'H2', buy_code: 'C1' }] }), c).rotate), []);
}
{
  const c = ctxOf(); c.holdings[1].ca_hold = true;
  eq('CA서킷 종목 교체 거부', pairs(parseDecision(J({ skipAll: false, buy: [{ code: 'C1' }], rotate: [{ sell_code: 'H2', buy_code: 'C1' }] }), c).rotate), []);
}
{
  const d = parseDecision(J({ skipAll: false, buy: [{ code: 'C1' }], rotate: [{ sell_code: 'H3', buy_code: 'C1' }] }), ctxOf());
  eq('이미 예약된 종목 교체 거부', pairs(d.rotate), []);
}
{
  const d = parseDecision(J({ skipAll: false, buy: [{ code: 'C1' }, { code: 'C2' }], rotate: [{ sell_code: 'H2', buy_code: 'C1' }, { sell_code: 'H1', buy_code: 'C2' }] }), ctxOf({ rotateLeft: 1 }));
  eq('rotateLeft 1 이면 1건만', pairs(d.rotate).length, 1);
}
{
  const d = parseDecision(J({ skipAll: false, buy: [{ code: 'C1' }], rotate: [{ sell_code: 'H2', buy_code: 'C1' }] }), ctxOf({ rotateLeft: 0 }));
  eq('rotateLeft 0 이면 전멸', pairs(d.rotate), []);
}
{
  const d = parseDecision(J({ skipAll: false, buy: [{ code: 'C1' }], rotate: [{ sell_code: 'H2' }] }), ctxOf());
  eq('짝이 불완전하면(buy_code 없음) 거부', pairs(d.rotate), []);
}

console.log('\n[파싱] 깨진 응답은 null 로 떨어져 실패 카운트로 간다');
eq('비 JSON', parseDecision('죄송합니다 판단 불가', ctxOf()), null);
eq('skipAll 누락', parseDecision(J({ buy: [] }), ctxOf()), null);
{
  const d = parseDecision('앞말\n```json\n' + J({ skipAll: false, buy: [{ code: 'C1' }] }) + '\n```\n뒷말', ctxOf());
  eq('코드펜스·전후 텍스트 포함도 파싱됨', codes(d.buy), ['C1']);
}

console.log(`\n${fail === 0 ? '전체 통과' : '실패 있음'} — pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
