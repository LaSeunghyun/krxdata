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

// ── 2026-08-26: sellOk 를 rotOk 와 대칭으로. 수동/전략미상 포지션과 당일 매수분은 AI 가 못 판다.
{
  const ctx = ctxOf({
    holdings: [
      // 사용자가 토스 앱에서 직접 산 포지션 (sub 미상) — 2026-08-26 사고의 종목 유형
      { code: 'M1', name: '수동픽', sub: null, ret_pct: -10.4, near_stop: false, exit_reserved: null, defer_used: 0, judged_today: false, ca_hold: false, hold_days: null },
      // 봇이 오늘 산 포지션 — 진입 당일 청산 금지
      { code: 'T0', name: '당일매수', sub: 'rsi2', ret_pct: -1, near_stop: false, exit_reserved: null, defer_used: 0, judged_today: false, ca_hold: false, hold_days: 0 },
      // 보유일수를 알 수 없는 봇 포지션 — 모르면 거부
      { code: 'TN', name: '보유일미상', sub: 'rsi2', ret_pct: -1, near_stop: false, exit_reserved: null, defer_used: 0, judged_today: false, ca_hold: false, hold_days: null },
      // 정상 — 통과해야 한다(검출력 유지)
      { code: 'OK', name: '정상보유', sub: 'rsi2', ret_pct: -2, near_stop: false, exit_reserved: null, defer_used: 0, judged_today: false, ca_hold: false, hold_days: 4 },
    ],
  });
  const j = JSON.stringify({
    skipAll: false, buy: [], rotate: [], defer_stop: [],
    sell: [{ code: 'M1', reason: 'x' }, { code: 'T0', reason: 'x' }, { code: 'TN', reason: 'x' }, { code: 'OK', reason: 'x' }],
  });
  const d = parseDecision(j, ctx);
  eq('sellOk: sub 미상 포지션은 AI 가 팔 수 없다', d.sell.some(x => x.code === 'M1'), false);
  eq('sellOk: 진입 당일(hold_days 0) 포지션은 팔 수 없다', d.sell.some(x => x.code === 'T0'), false);
  eq('sellOk: 보유일수 미상은 거부한다', d.sell.some(x => x.code === 'TN'), false);
  eq('sellOk: 정상 보유는 여전히 통과한다(검출력 유지)', d.sell.some(x => x.code === 'OK'), true);
  eq('sellOk: 거부분은 dropped.sell 에 남는다', d.dropped.sell.includes('M1'), true);
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

console.log('\n[충돌] sell 과 rotate 에 같은 종목 — rotate 우선, sell 에서 제거');
{
  const d = parseDecision(J({ skipAll: false, buy: [{ code: 'C1' }],
    sell: [{ code: 'H2', reason: '익일청산' }, { code: 'H1', reason: '정상' }],
    rotate: [{ sell_code: 'H2', buy_code: 'C1' }] }), ctxOf());
  eq('rotate 는 살아남는다', pairs(d.rotate), ['H2→C1']);
  eq('충돌한 H2 는 sell 에서 제거됨', codes(d.sell), ['H1']);
  eq('충돌이 dropped 에 태그로 남는다', d.dropped.sellRotConflict, ['H2']);
}
{
  // ★ rotate 가 경계·상한으로 기각돼도 **그 매도 레그는 sell 에서 제거한다.**
  //   AI 는 "이걸 팔아 저걸 산다"고 짝으로 지명한 것이고, 매수가 안 될 거면 매도도 하면 안 된다.
  //   남겨두면 매수 없는 단독 매도가 익일 집행돼 왕복비용만 나가고 현금이 유휴가 된다.
  //   방향은 "거래를 줄이는" 쪽 = 통과한 3축과 같은 방향.
  const d = parseDecision(J({ skipAll: false, buy: [],
    sell: [{ code: 'H2', reason: '익일청산' }],
    rotate: [{ sell_code: 'H2', buy_code: 'C1' }] }), ctxOf());
  eq('rotate 기각 시 그 매도 레그도 sell 에서 제거(단독 매도 방지)', codes(d.sell), []);
  eq('제거가 충돌 태그로 계측된다', d.dropped.sellRotConflict, ['H2']);
}
{
  // 상한으로 잘린 짝의 매도 레그도 같은 규칙 — 새어나가면 안 된다
  const d = parseDecision(J({ skipAll: false, buy: [{ code: 'C1' }, { code: 'C2' }],
    sell: [{ code: 'H1', reason: '이건 순수 청산' }],
    rotate: [{ sell_code: 'H2', buy_code: 'C1' }, { sell_code: 'H1', buy_code: 'C2' }] }), ctxOf({ rotateLeft: 1 }));
  eq('상한으로 잘린 짝의 sell_code 도 sell 에서 제거', codes(d.sell), []);
  eq('rotate 는 1건만 살아남는다', pairs(d.rotate).length, 1);
}

console.log('\n[계측] 파싱 단계에서 조용히 사라지는 것을 잡는다');
{
  // 모델이 다른 키 이름을 쓰면 전 항목이 빈 배열이 되는데, 기존엔 dropped 에도 흔적이 없어
  // "AI 가 아무것도 안 골랐다"와 구분이 안 됐다(skipAll:false 로 정상 판단처럼 통과 + failStreak 리셋).
  const d = parseDecision(J({ skipAll: false, buy: [{ ticker: '005930' }], sell_now: ['H1'], hard_stop_pct: 20 }), ctxOf());
  eq('잘못된 키 구조는 buy 가 비고', codes(d.buy), []);
  eq('사라진 건수와 미지의 키가 malformed 에 남는다',
    d.dropped.malformed, ['buy×1', '미지의키:sell_now', '미지의키:hard_stop_pct']);
}
{
  const d = parseDecision(J({ skipAll: false, buy: [{ code: 'C1', reason: '정상' }], sell: [], rotate: [], defer_stop: [] }), ctxOf());
  eq('정상 응답이면 malformed 는 비어 있다', d.dropped.malformed, []);
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
