import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrderKey, createOrderStateStore } from '../live-order-state.mjs';

test('createOrderKey is deterministic for the same signal', () => {
  const a = createOrderKey({ date: '2026-07-10', side: 'BUY', code: '000660', reason: 'rsi2', sub: 'combo', qty: 4 });
  const b = createOrderKey({ date: '2026-07-10', side: 'BUY', code: '000660', reason: 'rsi2', sub: 'combo', qty: 4 });
  assert.equal(a, b);
});

test('order state store claims a key only once and records status transitions', async () => {
  const store = createOrderStateStore();
  assert.equal(await store.claim('k1', { code: '000660' }), true);
  assert.equal(await store.claim('k1', { code: '000660' }), false);
  assert.equal((await store.get('k1')).status, 'queued');
  await store.markSubmitted('k1', { orderId: 'abc' });
  assert.equal((await store.get('k1')).status, 'submitted');
  await store.markFilled('k1', { price: 1000 });
  assert.equal((await store.get('k1')).status, 'filled');
});
