#!/usr/bin/env node
/** check-upbit-account.mjs — 업비트 계좌 잔고 확인 (읽기 전용) */
import { isUpbitTradingConfigured, getUpbitAccounts, getTickers } from './upbit-api.js';

if (!isUpbitTradingConfigured()) {
  console.log('UPBIT_ACCESS_KEY / UPBIT_SECRET_KEY 미설정 (.env)');
  process.exit(1);
}
const accounts = await getUpbitAccounts();
console.log('=== 업비트 계좌 ===');
let totalKrw = 0;
const coins = accounts.filter(a => a.currency !== 'KRW' && Number(a.balance) > 0);
const tickers = coins.length ? await getTickers(coins.map(c => `KRW-${c.currency}`)) : new Map();
for (const a of accounts) {
  const bal = Number(a.balance), locked = Number(a.locked);
  if (bal + locked <= 0) continue;
  if (a.currency === 'KRW') {
    totalKrw += bal + locked;
    console.log(`KRW 현금: ${Math.round(bal).toLocaleString()}원${locked > 0 ? ` (주문묶임 ${Math.round(locked).toLocaleString()}원)` : ''}`);
  } else {
    const t = tickers.get(`KRW-${a.currency}`);
    const val = t ? (bal + locked) * t.price : null;
    if (val != null) totalKrw += val;
    console.log(`${a.currency}: ${bal} (평단 ${Number(a.avg_buy_price).toLocaleString()}원${val != null ? `, 평가 ${Math.round(val).toLocaleString()}원` : ''})`);
  }
}
console.log(`총 평가액: ${Math.round(totalKrw).toLocaleString()}원`);
