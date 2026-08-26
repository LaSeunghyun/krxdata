import test from 'node:test';
import assert from 'node:assert/strict';
import { botHeldQty, classifyPosition } from '../position-ownership.mjs';

// 2026-08-26 사고 당시 실제 저널에서 뽑은 픽스처.
// 봇은 한화오션만 샀고 295310·052690 은 사용자가 토스 앱에서 직접 샀다(저널 BUY 0건, 실측).
const TRADES = [
  { ts: '2026-08-07 08:12:25', code: '042660', name: '한화오션', side: 'BUY',  qty: 34, px: 91100, sub: 'rsi2' },
  { ts: '2026-08-03 09:14:33', code: '029780', name: '삼성카드', side: 'BUY',  qty: 64, px: 46634, sub: 'rsi2' },
  { ts: '2026-08-07 08:02:43', code: '029780', name: '삼성카드', side: 'SELL', qty: 64, px: 47000 },
];

test('botHeldQty 는 BUY 합에서 SELL 합을 뺀다', () => {
  assert.equal(botHeldQty(TRADES, '042660'), 34);
  assert.equal(botHeldQty(TRADES, '029780'), 0);   // 전량 매도됨
  assert.equal(botHeldQty(TRADES, '295310'), 0);   // 봇이 산 적 없음
});

test('사용자가 직접 산 종목은 user 로 판정한다 (295310 실측)', () => {
  const r = classifyPosition({ code: '295310', brokerQty: 326, currentPx: 48300, meta: {}, trades: TRADES });
  assert.equal(r.kind, 'user');
});

test('사용자가 직접 산 종목은 user 로 판정한다 (052690 실측)', () => {
  const r = classifyPosition({ code: '052690', brokerQty: 25, currentPx: 130900, meta: {}, trades: TRADES });
  assert.equal(r.kind, 'user');
});

test('봇이 산 종목은 bot 으로 판정하고 meta 를 복원한다 (한화오션 실측)', () => {
  const r = classifyPosition({ code: '042660', brokerQty: 34, currentPx: 95000, meta: {}, trades: TRADES });
  assert.equal(r.kind, 'bot');
  assert.equal(r.restoreMeta.sub, 'rsi2');
  assert.equal(r.restoreMeta.entry, 91100);
  assert.equal(r.restoreMeta.boughtAt, '2026-08-07 08:12:25');
});

test('복원 meta 의 hi 는 진입가와 현재가 중 큰 값이다 (트레일이 늦게 걸리는 안전측)', () => {
  const up = classifyPosition({ code: '042660', brokerQty: 34, currentPx: 95000, meta: {}, trades: TRADES });
  assert.equal(up.restoreMeta.hi, 95000);
  const down = classifyPosition({ code: '042660', brokerQty: 34, currentPx: 80000, meta: {}, trades: TRADES });
  assert.equal(down.restoreMeta.hi, 91100);
  assert.ok(down.restoreMeta.hi >= down.restoreMeta.entry);
});

test('meta.sub 가 있으면 저널을 보지 않고 bot 으로 통과시킨다', () => {
  const r = classifyPosition({ code: '295310', brokerQty: 326, currentPx: 48300, meta: { sub: 'rsi2' }, trades: TRADES });
  assert.equal(r.kind, 'bot');
  assert.equal(r.restoreMeta, undefined);
});

test('사용자가 봇 보유분에 추가매수하면 user 로 떨어진다', () => {
  const r = classifyPosition({ code: '042660', brokerQty: 50, currentPx: 95000, meta: {}, trades: TRADES });
  assert.equal(r.kind, 'user');   // botQty 34 < brokerQty 50
});

test('저널을 읽을 수 없으면 unknown 이다 (판정 보류 — 격리로 실패하지 않는다)', () => {
  assert.equal(classifyPosition({ code: '042660', brokerQty: 34, currentPx: 1, meta: {}, trades: null }).kind, 'unknown');
  assert.equal(classifyPosition({ code: '042660', brokerQty: 34, currentPx: 1, meta: {}, trades: undefined }).kind, 'unknown');
});

test('저널이 비어 있는 것과 읽을 수 없는 것은 다르다', () => {
  assert.equal(classifyPosition({ code: '042660', brokerQty: 34, currentPx: 1, meta: {}, trades: [] }).kind, 'user');
});

test('SELL 이 BUY 보다 많은 이상 데이터는 user 로 떨어진다 (안전측)', () => {
  const bad = [{ code: 'X', side: 'SELL', qty: 10, px: 1, ts: 't' }];
  assert.equal(botHeldQty(bad, 'X'), -10);
  assert.equal(classifyPosition({ code: 'X', brokerQty: 5, currentPx: 1, meta: {}, trades: bad }).kind, 'user');
});

test('저널 BUY 에 sub 가 없으면 복원 불가라 user 로 떨어진다', () => {
  const noSub = [{ code: 'Y', side: 'BUY', qty: 10, px: 1000, ts: 't' }];
  assert.equal(classifyPosition({ code: 'Y', brokerQty: 10, currentPx: 1100, meta: {}, trades: noSub }).kind, 'user');
});

test('비유한 가격(Infinity·NaN)은 0 으로 떨어뜨린다 — hi=Infinity 는 트레일을 항상 발동시킨다', () => {
  const B = (px) => [{ ts: 't', code: 'A', side: 'BUY', qty: 10, px, sub: 'rsi2' }];
  for (const cpx of [Infinity, -Infinity, NaN, 'abc', null, undefined]) {
    for (const bpx of [91100, 0, NaN, Infinity, undefined]) {
      const r = classifyPosition({ code: 'A', brokerQty: 10, currentPx: cpx, meta: {}, trades: B(bpx) });
      assert.equal(r.kind, 'bot');
      assert.ok(Number.isFinite(r.restoreMeta.hi), `hi 가 비유한: cpx=${String(cpx)} bpx=${String(bpx)}`);
      assert.ok(Number.isFinite(r.restoreMeta.entry), `entry 가 비유한: cpx=${String(cpx)} bpx=${String(bpx)}`);
      assert.ok(r.restoreMeta.hi >= r.restoreMeta.entry);
    }
  }
});

test('정상 유한값은 그대로 통과한다 (검출력 유지)', () => {
  const B = [{ ts: 't', code: 'A', side: 'BUY', qty: 10, px: 91100, sub: 'rsi2' }];
  const r = classifyPosition({ code: 'A', brokerQty: 10, currentPx: 95000, meta: {}, trades: B });
  assert.equal(r.restoreMeta.entry, 91100);
  assert.equal(r.restoreMeta.hi, 95000);
});
