#!/usr/bin/env node
/** upbit-sell-all.mjs — 지정 코인 전량 시장가 매도 + 체결 확인 (예: node upbit-sell-all.mjs PYTH) */
import { getUpbitAccounts, createUpbitOrder, getUpbitOrder } from './upbit-api.js';

const CUR = process.argv[2];
if (!CUR) { console.error('사용법: node upbit-sell-all.mjs <통화심볼>'); process.exit(1); }

const accounts = await getUpbitAccounts();
const acc = accounts.find(a => a.currency === CUR);
if (!acc || Number(acc.balance) <= 0) { console.log(`${CUR} 보유 없음`); process.exit(1); }
console.log(`${CUR} 보유 ${acc.balance} (평단 ${Number(acc.avg_buy_price).toLocaleString()}원) — 시장가 전량 매도 주문`);

const order = await createUpbitOrder({ market: `KRW-${CUR}`, side: 'ask', ord_type: 'market', volume: acc.balance });
console.log(`주문 접수 uuid=${order.uuid} state=${order.state}`);

for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 1500));
  const o = await getUpbitOrder(order.uuid);
  if (o.state === 'done' || o.state === 'cancel') {
    const funds = (o.trades ?? []).reduce((s, t) => s + Number(t.funds), 0);
    const vol = (o.trades ?? []).reduce((s, t) => s + Number(t.volume), 0);
    const fee = Number(o.paid_fee);
    console.log(`체결 완료: ${vol} ${CUR} 매도, 체결대금 ${Math.round(funds).toLocaleString()}원, 수수료 ${Math.round(fee).toLocaleString()}원, 순입금 ${Math.round(funds - fee).toLocaleString()}원`);
    const after = await getUpbitAccounts();
    const krw = after.find(a => a.currency === 'KRW');
    console.log(`매도 후 KRW 잔고: ${Math.round(Number(krw?.balance ?? 0)).toLocaleString()}원`);
    process.exit(0);
  }
  console.log(`대기중... state=${o.state}`);
}
console.log('20회 폴링 내 미체결 — 수동 확인 필요');
