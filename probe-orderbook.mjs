#!/usr/bin/env node
// probe-orderbook.mjs — 토스 호가창 응답 스키마 확인용 일회성 프로브 (2026-08-04)
// measure-slippage.mjs 의 parseAsks/parseBestBid 가 맞게 파싱하는지 실물로 확인한다.
// VM 에서 실행(로컬 IP 는 토스 API 화이트리스트 밖).
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getOrderbook, getPricesMap } from './toss-api.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const code = process.argv[2] ?? '005930';
const ob = await getOrderbook(code);
console.log('=== 최상위 키 ===');
console.log(Object.keys(ob ?? {}).join(', '));
console.log('\n=== 원본 (1200자) ===');
console.log(JSON.stringify(ob, null, 1).slice(0, 1200));

// measure-slippage.mjs 와 동일한 파서를 복제해 즉석 검증
function parseAsks(o) {
  if (!o) return [];
  const arr = o.asks ?? o.askLevels ?? o.sellLevels ?? null;
  if (Array.isArray(arr) && arr.length) {
    return arr.map(a => ({ px: Number(a.price ?? a.px ?? a.askPrice), qty: Number(a.quantity ?? a.qty ?? a.volume ?? a.askQuantity) }))
      .filter(x => x.px > 0 && x.qty > 0).sort((a, b) => a.px - b.px);
  }
  const out = [];
  for (let i = 1; i <= 10; i++) {
    const px = Number(o[`askPrice${i}`] ?? o[`ask${i}Price`]);
    const qty = Number(o[`askQuantity${i}`] ?? o[`askQty${i}`] ?? o[`ask${i}Quantity`]);
    if (px > 0 && qty > 0) out.push({ px, qty });
  }
  return out.sort((a, b) => a.px - b.px);
}
const asks = parseAsks(ob);
console.log(`\n=== parseAsks 결과: ${asks.length}단계 ===`);
console.log(asks.slice(0, 5).map(a => `${a.px.toLocaleString()} × ${a.qty}`).join('  |  '));
if (!asks.length) { console.log('★ 파싱 실패 — measure-slippage.mjs 의 parseAsks 를 위 원본 구조에 맞게 고쳐야 한다.'); process.exit(1); }

const pm = await getPricesMap([code]);
const last = Number(pm?.get?.(code)?.price ?? 0);
function simFill(a, krw) {
  let spent = 0, sh = 0;
  for (const lv of a) { const take = Math.min(lv.px * lv.qty, krw - spent); if (take <= 0) break; sh += take / lv.px; spent += take; if (spent >= krw - 1) break; }
  return { avgPx: sh > 0 ? spent / sh : null, exhausted: spent < krw - 1 };
}
for (const krw of [100_000, 3_000_000]) {
  const r = simFill(asks, krw);
  console.log(`시뮬 ${(krw / 10000).toLocaleString()}만원 → 평균 ${r.avgPx ? Math.round(r.avgPx).toLocaleString() : '?'}원` +
    `${last > 0 && r.avgPx ? ` · 현재가 대비 +${((r.avgPx / last - 1) * 100).toFixed(4)}%` : ''}${r.exhausted ? ' (호가 소진)' : ''}`);
}
console.log(`\n※ 장 마감 상태면 호가가 비거나 정적일 수 있다. 장중 재실행으로 최종 확인할 것.`);
