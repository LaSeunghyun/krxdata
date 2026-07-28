/**
 * tg-order.mjs — 텔레그램 승인 기반 결정론적 주문 핸들러 (실주문). LLM 파싱 절대 안 씀.
 *
 * 명령 문법(엄격):
 *   "매수 <종목명> <금액>"      예: 매수 현대모비스 200만원 / 매수 KB금융 500000
 *   "매도 <종목명>"             즉시 전량 지정가 매도
 *   "매도 <종목명> 목표 <가격>"  목표가 지정가 매도 주문
 * 종목명→코드는 stock_analysis에서 해석(유일 매칭만 집행, 모호/없음이면 되물음 = 오주문 방지).
 * 지정가 주문(stock-live.mjs와 동일 limitBuyPx/limitSellPx). 매수 금액 상한 없음(사용자 결정) —
 *   단 매수가능현금 초과는 거부(불가능 주문 방지). chat 잠금은 호출부(telegram-agent).
 * dryRun 기본 true → 명시적으로 dryRun:false 넘길 때만 실주문(VM 활성화 시). 검증은 dryRun으로.
 */
import { getBuyingPower, getHoldings, getPricesMap, createOrder } from './toss-api.js';
import { addBotExclude, removeBotExclude } from './bot-exclude.mjs';

// KR 틱/지정가 — stock-live.mjs와 동일 구현(검증본 일치)
function tick(p) { if (p < 2000) return 1; if (p < 5000) return 5; if (p < 20000) return 10; if (p < 50000) return 50; if (p < 200000) return 100; if (p < 500000) return 500; return 1000; }
const limitBuyPx = (p) => { const t = tick(p); return Math.round((p * 1.005) / t) * t; };   // 현재가 +0.5% 올림틱(체결 유도)
const limitSellPx = (p) => { const t = tick(p); return Math.round((p * 0.995) / t) * t; };  // 현재가 -0.5% 내림틱(체결 유도)
const roundTick = (p) => Math.round(p / tick(p)) * tick(p);                                 // 명시 목표가 틱보정

/** "50만원"/"50만"/"1억"/"500000" → 원(숫자). 실패 시 null */
export function parseAmountKrw(s) {
  if (s == null) return null;
  const t = String(s).replace(/[,\s원]/g, '');
  let m;
  if ((m = t.match(/^([\d.]+)억$/))) return Math.round(parseFloat(m[1]) * 1e8);
  if ((m = t.match(/^([\d.]+)만$/))) return Math.round(parseFloat(m[1]) * 1e4);
  if ((m = t.match(/^(\d+)$/))) return Number(m[1]);
  return null;
}

/** 엄격 문법 파서 (LLM 아님). @returns {action, name?, amount?, targetPrice?} */
export function parseCommand(text) {
  const t = String(text || '').trim();
  let m;
  if ((m = t.match(/^매수\s+(.+?)\s+([\d.]+(?:억|만)?원?|\d+)$/))) return { action: 'buy', name: m[1].trim(), amount: parseAmountKrw(m[2]) };
  if ((m = t.match(/^매도\s+(.+?)\s+목표\s+([\d,]+)$/))) return { action: 'sell_target', name: m[1].trim(), targetPrice: Number(m[2].replace(/,/g, '')) };
  if ((m = t.match(/^매도\s+(.+?)$/))) return { action: 'sell', name: m[1].trim() };
  if ((m = t.match(/^(?:CA해제|서킷해제|ca-clear)\s+(.+?)$/i))) return { action: 'ca_clear', name: m[1].trim() };
  return { action: null };
}

/** 종목명 → {status:'ok',code,name,price} | {status:'ambiguous',matches} | {status:'none'} */
export async function resolveStock(name, { dbQuery }) {
  const esc = String(name).replace(/'/g, "''");
  const like = esc.replace(/[\\%_]/g, '\\$&'); // LIKE 메타문자(%,_,\) 이스케이프 — 오매칭 방지
  let rows = await dbQuery(`SELECT stock_code,corp_name,current_price FROM stock_analysis WHERE corp_name='${esc}'`);
  if (!rows.length) rows = await dbQuery(`SELECT stock_code,corp_name,current_price FROM stock_analysis WHERE corp_name ILIKE '%${like}%' ESCAPE '\\' LIMIT 6`);
  if (!rows.length) return { status: 'none' };
  if (rows.length > 1) {
    const exact = rows.find(r => r.corp_name === name);
    if (exact) return { status: 'ok', code: exact.stock_code, name: exact.corp_name, price: Number(exact.current_price) };
    return { status: 'ambiguous', matches: rows.map(r => r.corp_name) };
  }
  return { status: 'ok', code: rows[0].stock_code, name: rows[0].corp_name, price: Number(rows[0].current_price) };
}

async function livePrice(code, quote) {
  const q = quote ? await quote(code) : await getPricesMap([code]);
  const v = q instanceof Map ? q.get(code)?.price : q;
  return Number(v) || null;
}

/** 매수. dryRun=true면 계획만, false면 실주문. @returns {ok, msg, plan?, orderId?} */
export async function executeBuy({ name, amountKrw }, { dbQuery, seq, dryRun = true, quote } = {}) {
  if (!amountKrw || amountKrw < 1) return { ok: false, msg: '금액 파싱 실패' };
  const r = await resolveStock(name, { dbQuery });
  if (r.status === 'none') return { ok: false, msg: `'${name}' 종목 못 찾음` };
  if (r.status === 'ambiguous') return { ok: false, msg: `'${name}' 모호 — 정확히 입력: ${r.matches.join(' / ')}` };
  let px = r.price;
  if (!dryRun) { const live = await livePrice(r.code, quote); if (live) px = live; }
  if (!px || px < 1) return { ok: false, msg: `${r.name} 현재가 조회 실패` };
  const lpx = limitBuyPx(px);
  const qty = Math.floor((amountKrw * 0.999) / lpx);
  if (qty < 1) return { ok: false, msg: `금액 ${amountKrw.toLocaleString()}원 < 1주가(${lpx.toLocaleString()})` };
  const cost = lpx * qty;
  const plan = { code: r.code, name: r.name, side: 'BUY', px: lpx, qty, cost };
  if (dryRun) return { ok: true, dryRun: true, plan, msg: `[DRY] 매수 ${r.name}(${r.code}) 지정가 ${lpx.toLocaleString()} × ${qty}주 = ${cost.toLocaleString()}원` };
  const bp = await getBuyingPower(seq, { currency: 'KRW' });
  const cash = Number(bp?.cashBuyingPower ?? 0);
  if (cost > cash) return { ok: false, msg: `매수가능현금 부족 (필요 ${cost.toLocaleString()} > 보유 ${cash.toLocaleString()})` };
  const o = await createOrder(seq, { symbol: r.code, side: 'BUY', orderType: 'LIMIT', price: String(lpx), quantity: String(qty) });
  addBotExclude(r.code); // 수동 매수 → 자동봇이 안 건드리게 제외 등록(내가 관리)
  return { ok: true, plan, orderId: o?.orderId ?? o?.id, msg: `✅ 매수주문 ${r.name}(${r.code}) 지정가 ${lpx.toLocaleString()} × ${qty}주 (${cost.toLocaleString()}원)\n(자동봇 제외 등록 — 내가 관리)` };
}

/** 매도. targetPrice 있으면 그 지정가로(목표가 매도), 없으면 즉시 지정가. qty 미지정 시 전량. dryRun=true면 계획만. */
export async function executeSell({ name, qty, targetPrice }, { dbQuery, seq, dryRun = true, quote } = {}) {
  const r = await resolveStock(name, { dbQuery });
  if (r.status === 'none') return { ok: false, msg: `'${name}' 종목 못 찾음` };
  if (r.status === 'ambiguous') return { ok: false, msg: `'${name}' 모호 — ${r.matches.join(' / ')}` };
  if (dryRun) {
    const lpx = targetPrice ? roundTick(targetPrice) : limitSellPx(r.price || 0);
    return { ok: true, dryRun: true, msg: `[DRY] 매도 ${r.name}(${r.code}) 지정가 ${lpx.toLocaleString()}${targetPrice ? '(목표가)' : ''} (${qty ?? '전량'})` };
  }
  const h = await getHoldings(seq);
  const pos = (h?.items ?? []).find(x => x.symbol === r.code && Number(x.quantity) > 0);
  if (!pos) return { ok: false, msg: `${r.name} 보유 없음` };
  const holdQty = Number(pos.quantity);
  const sellQty = qty ? Math.min(qty, holdQty) : holdQty;
  let lpx;
  if (targetPrice) lpx = roundTick(targetPrice);
  else { const live = await livePrice(r.code, quote); const px = live || Number(pos.lastPrice) || 0; if (!px) return { ok: false, msg: `${r.name} 현재가 조회 실패` }; lpx = limitSellPx(px); }
  const o = await createOrder(seq, { symbol: r.code, side: 'SELL', orderType: 'LIMIT', price: String(lpx), quantity: String(sellQty) });
  // 격리해제는 자동으로 안 함 — 미체결 지정가 상태서 해제하면 자동봇이 재매수 위험(M1). 체결 확인 후 '격리해제 종목명'으로 수동.
  return { ok: true, orderId: o?.orderId ?? o?.id, msg: `✅ 매도주문 ${r.name}(${r.code}) 지정가 ${lpx.toLocaleString()} × ${sellQty}주${targetPrice ? '(목표가)' : ''}${sellQty >= holdQty ? `\n(전량 체결 후: 격리해제 ${r.name})` : ''}` };
}

/** CA해제 / 서킷해제 */
export async function executeCaClear({ name }, { dbQuery, dryRun = true } = {}) {
  const r = await resolveStock(name, { dbQuery });
  if (r.status === 'none') return { ok: false, msg: `'${name}' 종목 못 찾음` };
  if (r.status === 'ambiguous') return { ok: false, msg: `'${name}' 모호 — ${r.matches.join(' / ')}` };
  if (dryRun) return { ok: true, dryRun: true, msg: `[DRY] CA서킷 해제 ${r.name}(${r.code})` };
  return { ok: true, name: r.name, code: r.code, msg: `✅ CA서킷 해제 요청 ${r.name}(${r.code})` };
}
