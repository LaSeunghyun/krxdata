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
import { appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 수동 주문 기록 (★ 2026-08-04 신설).
 *
 * ═══ 왜 필요했나 ═══
 * 이 파일이 `recordTrade` 를 전혀 호출하지 않아 **텔레그램 수동 매매가 성과 측정에서 사라졌다.**
 * 08-04 실측: stock-live-journal.json 에 매수 33건 / 매도 24건인데, 매수만 있고 매도 기록이 없는
 * 종목이 8개였다(한미반도체·LG에너지솔루션·미래에셋증권·BNK금융지주·카카오·한국항공우주·
 * 한국타이어·삼성전기). 그래서 라이브 승률 33% 는 **봇 자동매도 경로만의 값**이고 편향돼 있다.
 * 측정이 안 되면 어떤 전략 개선도 라이브에서 효과를 확인할 수 없다.
 *
 * ═══ 왜 별 파일(append-only JSONL)인가 ═══
 * stock-live.mjs 의 recordTrade 는 저널 **전체를 읽어 배열에 push 하고 다시 쓴다**(read-modify-write).
 * 그 프로세스는 상시 가동이고 이 파일은 telegram-agent 프로세스에서 돈다 → 같은 JSON 을 양쪽에서
 * 쓰면 갱신 유실이 난다(tmp→rename 은 쓰기만 원자적이고 read-modify-write 구간은 보호하지 못한다).
 * 한 줄 append 는 그 구간이 없어 경합이 원리상 생기지 않는다.
 *
 * ═══ 체결가를 적지 않는 이유 ═══
 * executeBuy/executeSell 은 지정가 주문만 넣고 **체결을 기다리지 않는다**(settleOrder 폴링 없음).
 * 그래서 이 시점에 체결가를 모른다. 지정가를 체결가로 적으면 08-03 에 고친 결함
 * (매도 21건이 전부 지정가로 기록돼 수익률이 과소)을 새로 만드는 것이다.
 * → `kind:'order'` 로 명시하고 `orderId` 를 남겨 사후 대조가 가능하게만 한다.
 *
 * 기록 실패가 주문을 막으면 안 된다 — 전부 삼키고 주문 결과는 그대로 반환한다.
 */
export const MANUAL_LOG = join(__dirname, 'manual-trades.jsonl');
/**
 * export 인 이유: 실주문 없이는 이 경로가 돌지 않아 **검증할 방법이 없다.**
 * 08-04 에 forecast-llm 에서 `node --check` 통과 + 런타임 ReferenceError 를 겪었으므로
 * "구문 OK"를 동작 확인으로 쓰지 않는다. 단위 테스트로 실제 파일 쓰기를 확인한다
 * (tests/tg-order-record.test.mjs). 경로 인자는 테스트 격리용이며 운영 호출은 기본값을 쓴다.
 */
export function recordManual(rec, file = MANUAL_LOG) {
  try {
    appendFileSync(file, JSON.stringify({ ...rec, src: 'telegram', kind: 'order' }) + '\n');
    return true;
  } catch { return false; /* 기록 실패가 매매를 막으면 안 된다 */ }
}
const kstNow = () => new Date(Date.now() + 9 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);

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
  recordManual({ ts: kstNow(), code: r.code, name: r.name, side: 'BUY', limitPx: lpx, qty, cost, orderId: o?.orderId ?? o?.id ?? null });
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
  // 평단은 브로커 값을 쓴다(봇 meta 가 아니라 사실). 이게 있어야 사후에 실현손익을 계산할 수 있다.
  const entry = Number(pos.averagePurchasePrice) || null;
  recordManual({
    ts: kstNow(), code: r.code, name: r.name, side: 'SELL', limitPx: lpx, qty: sellQty,
    entry, holdQty, full: sellQty >= holdQty,
    // 지정가 기준 예상 수익률 — **체결 기준이 아니다.** 사후 대조 전까지는 근사로만 쓴다.
    retAtLimit: entry ? Number(((lpx / entry - 1) * 100).toFixed(1)) : null,
    targetOrder: !!targetPrice, orderId: o?.orderId ?? o?.id ?? null,
  });
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
