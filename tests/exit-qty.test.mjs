import test from 'node:test';
import assert from 'node:assert/strict';
import { plannedSellQty } from '../exit-qty.mjs';

test('2026-08-26 사고 재현 — 재매수분이 청산되지 않는다', () => {
  // 08:00 예약 생성 시점 보유 326주 → 147주만 체결 → 예약 잔량 179
  const first = plannedSellQty({ brokerQty: 326, exitQty: 326, frac: 1 });
  assert.equal(first.sellQty, 326);

  const capAfter = 326 - 147;               // 부분체결 후 예약 잔량
  assert.equal(capAfter, 179);

  // 08:06 사용자가 143주 재매수 → 브로커 보유 322주. 예약분 179 만 팔아야 한다.
  const second = plannedSellQty({ brokerQty: 322, exitQty: capAfter, frac: 1 });
  assert.equal(second.sellQty, 179, '사고 당시엔 322주를 전부 팔았다');
  assert.equal(second.base, 179);
  assert.equal(second.release, false);
});

test('exitQty 가 없으면 현행 동작으로 폴백한다 (구 예약 호환)', () => {
  const r = plannedSellQty({ brokerQty: 100, exitQty: undefined, frac: 1 });
  assert.equal(r.sellQty, 100);
  assert.equal(r.base, 100);
});

test('브로커 보유가 예약보다 적으면 보유수량이 상한이다', () => {
  const r = plannedSellQty({ brokerQty: 40, exitQty: 100, frac: 1 });
  assert.equal(r.sellQty, 40);
});

test('부분익절(frac 0.5)은 상한 기준으로 절반을 판다', () => {
  const r = plannedSellQty({ brokerQty: 322, exitQty: 179, frac: 0.5 });
  assert.equal(r.sellQty, 89, 'floor(179*0.5) — 브로커 322 기준이 아니다');
});

test('예약이 소진된 뒤 사용자가 재매수해도 1주를 팔지 않고 예약을 해제한다', () => {
  const r = plannedSellQty({ brokerQty: 143, exitQty: 0, frac: 1 });
  assert.equal(r.sellQty, 0);
  assert.equal(r.release, true, 'Math.max(1,...) 가 1주를 파는 것을 막아야 한다');
});

test('부분익절에서도 상한 소진이면 해제한다', () => {
  const r = plannedSellQty({ brokerQty: 143, exitQty: 0, frac: 0.5 });
  assert.equal(r.release, true);
  assert.equal(r.sellQty, 0);
});

test('브로커 보유가 0이면 해제한다', () => {
  assert.equal(plannedSellQty({ brokerQty: 0, exitQty: 100, frac: 1 }).release, true);
});

test('음수·NaN 입력은 해제로 떨어진다 (안전측)', () => {
  assert.equal(plannedSellQty({ brokerQty: -5, exitQty: 10, frac: 1 }).release, true);
  assert.equal(plannedSellQty({ brokerQty: NaN, exitQty: 10, frac: 1 }).release, true);
});

test('부분익절 최소 1주는 상한이 남아 있을 때만 보장된다', () => {
  const r = plannedSellQty({ brokerQty: 100, exitQty: 1, frac: 0.5 });
  assert.equal(r.sellQty, 1, 'floor(1*0.5)=0 이지만 상한이 1 남았으므로 1주');
  assert.equal(r.release, false);
});

test('frac 이 비유한이면 전량(1)로 폴백한다 — NaN 이 주문수량으로 새어나가면 예약이 영구 미집행된다', () => {
  for (const f of [NaN, Infinity, -Infinity, 'abc']) {
    const r = plannedSellQty({ brokerQty: 100, exitQty: 100, frac: f });
    assert.ok(Number.isInteger(r.sellQty), `sellQty 가 정수가 아님(frac=${String(f)}): ${r.sellQty}`);
    assert.equal(r.sellQty, 100, `frac=${String(f)} 는 전량으로 폴백해야 한다`);
  }
});

test('정상 frac 은 그대로 동작한다 (검출력 유지)', () => {
  assert.equal(plannedSellQty({ brokerQty: 100, exitQty: 100, frac: 1 }).sellQty, 100);
  assert.equal(plannedSellQty({ brokerQty: 100, exitQty: 100, frac: 0.5 }).sellQty, 50);
});
