#!/usr/bin/env node
/**
 * stock-live.mjs — 주식 실계좌 단일 연속 트레이더 (토스, 2026-07-20 사용자 지시).
 *   코인 live-day를 주식용으로 이식: 08:00~20:00(NXT 포함) 연속 감시, combo-v2 신호 진입,
 *   트레일링(최대익절 지향) 청산, LIVE_SLOTS=1(전액 집중). 단일 프로세스라 이중주문 없음.
 *   ※ 기존 스케줄러 phase(PaperMorning/PaperClose)는 이중주문 방지 위해 비활성화해야 함.
 *
 *   진입: 레짐(005930 MA20/60) → UP:hi120/rsi2, NEUTRAL/DOWN:rsi2. 시총상위·유동성 필터.
 *         현금으로 살 수 있는(주당<cash) 최상위 신호 1종 MARKET 매수.
 *   청산(승자 태우기): 고점대비 트레일 -8% OR 진입대비 하드손절 -7% OR 레짐 DOWN 이탈.
 *         (MA5 조기청산 폐기 — 최대 익절가까지 트레일링)
 *   실행: node stock-live.mjs --plan   (미리보기, 주문 없음)
 *         node stock-live.mjs --go     (집행+연속감시, 백그라운드)
 */
import dotenv from 'dotenv';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAccounts, getHoldings, getBuyingPower, getPricesMap, getDailyCandles, createOrder, getOrder } from './toss-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });
const argv = process.argv.slice(2);
const POLL_MS = 30_000;
const TRAIL_PCT = 8, HARD_STOP_PCT = 7;   // 승자 태우기: 고점 -8% 트레일 / 진입 -7% 하드손절
const RSI_MAX = 10, MIN_TURNOVER = 3e9, MIN_PRICE = 2_000;
const STATE = join(__dirname, 'stock-live-state.json');
const JOURNAL = join(__dirname, 'stock-live-journal.json');
const LOG = join(__dirname, 'stock-live-log.txt');
const kst = () => new Date(Date.now() + 9 * 3_600_000);
const now = () => kst().toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => { const l = `[${now()}] ${m}`; console.log(l); appendFileSync(LOG, l + '\n'); };
const marketOpen = () => { const h = kst().getUTCHours(); return h >= 8 && h < 20; }; // 08:00~20:00 KST (NXT 포함)

const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
function rsi2(c) { const i = c.length - 1; if (i < 2) return 50; let up = 0, dn = 0; for (let j = i - 1; j <= i; j++) { const ch = c[j] - c[j - 1]; if (ch > 0) up += ch; else dn -= ch; } return up + dn === 0 ? 50 : (up / (up + dn)) * 100; }

async function regimeOf() {
  const c = (await getDailyCandles('005930', 70)).map(b => b.close);
  const i = c.length - 1; const avg = (n) => c.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n;
  const ma20 = avg(20), ma60 = avg(60), ret5 = (c[i] / c[i - 5] - 1) * 100;
  if (c[i] > ma20 && ma20 > ma60) return 'UP';
  if (c[i] < ma20 && ret5 < -3) return 'DOWN';
  return 'NEUTRAL';
}

// combo-v2 진입 후보: 레짐별 rsi2 과매도(전 레짐) + hi120 신고가돌파(UP만), 현금으로 살 수 있는 것만
async function pickCandidate(cash) {
  const regime = await regimeOf();
  const rows = await dbQuery(`SELECT stock_code,corp_name,current_price FROM stock_analysis WHERE current_price>=${MIN_PRICE} AND current_price<${Math.floor(cash)} AND avg_turnover_20d>=${MIN_TURNOVER} ORDER BY market_cap_tril DESC LIMIT 40`);
  const rsiCands = [], hiCands = [];
  for (const r of rows) {
    try {
      const cd = (await getDailyCandles(r.stock_code, 130)).reverse();
      if (cd.length < 61) continue;
      const cl = cd.map(b => b.close), px = cl[cl.length - 1];
      if (px >= cash) continue;
      const rv = rsi2(cl);
      if (rv < RSI_MAX) rsiCands.push({ code: r.stock_code, name: r.corp_name, px, rsi2: rv, sub: 'rsi2' });
      if (regime === 'UP') {
        let hh = 0; for (let j = cl.length - 121; j < cl.length - 1; j++) hh = Math.max(hh, cd[j].high);
        const brk = (px / hh - 1) * 100;
        if (px > hh && brk >= 3) hiCands.push({ code: r.stock_code, name: r.corp_name, px, breakout: brk, sub: 'hi120' });
      }
    } catch { /* skip */ }
  }
  // UP: hi120 우선(돌파폭 큰 것), 그 외: rsi2(가장 과매도)
  let pick = null;
  if (regime === 'UP' && hiCands.length) { hiCands.sort((a, b) => b.breakout - a.breakout); pick = hiCands[0]; }
  else if (rsiCands.length) { rsiCands.sort((a, b) => a.rsi2 - b.rsi2); pick = rsiCands[0]; }
  return { regime, pick, rsiCount: rsiCands.length, hiCount: hiCands.length };
}

const accounts = await getAccounts();
const seq = accounts[0]?.accountSeq;
if (seq == null) { log('토스 계좌 조회 실패 — 중단'); process.exit(1); }

// ── PLAN: 미리보기 ────────────────────────────────────────────
if (argv.includes('--plan')) {
  const cash = Number((await getBuyingPower(seq, { currency: 'KRW' }))?.cashBuyingPower ?? 0);
  const { regime, pick, rsiCount, hiCount } = await pickCandidate(cash);
  console.log(`\n=== 주식 실계좌 매수 플랜 (미리보기) ===`);
  console.log(`현금 ${cash.toLocaleString()}원 | 레짐 ${regime} | rsi2후보 ${rsiCount} / hi120후보 ${hiCount}`);
  if (pick) console.log(`→ 매수 예정: ${pick.name}(${pick.code}) ${pick.px.toLocaleString()}원 × ${Math.floor(cash * 0.999 / pick.px)}주 [${pick.sub}${pick.rsi2 != null ? ' RSI2 ' + pick.rsi2.toFixed(1) : ' 돌파 ' + pick.breakout?.toFixed(1) + '%'}]`);
  else console.log(`→ 매수 대상 없음 (현금으로 살 수 있는 신호 종목 없음 — 현금 대기)`);
  console.log(`청산 규칙: 고점대비 -${TRAIL_PCT}% 트레일 / 진입대비 -${HARD_STOP_PCT}% 하드손절 / DOWN레짐 이탈`);
  process.exit(0);
}
if (!argv.includes('--go')) { console.log('사용법: --plan 또는 --go'); process.exit(1); }

// ── 상태 ─────────────────────────────────────────────────────
let state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { meta: {}, ipAlerted: false };
const loadJournal = () => { try { return JSON.parse(readFileSync(JOURNAL, 'utf8')); } catch { return { trades: [] }; } };
function recordTrade(t) { const j = loadJournal(); j.trades.push(t); writeFileSync(JOURNAL, JSON.stringify(j, null, 1)); }

async function waitFill(orderId, tag) {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1500));
    try { const o = await getOrder(seq, orderId); if (o?.orderState === 'FILLED' || o?.status === 'FILLED' || o?.orderState === 'DONE') return o; } catch {}
  }
  log(`경고: ${tag} 체결확인 실패 (수동 확인 필요)`); return null;
}

log(`=== 주식 연속 트레이더 시작 (계좌 ${accounts[0].no}, 08:00~20:00, LIVE_SLOTS=1, 트레일-${TRAIL_PCT}%/하드-${HARD_STOP_PCT}%) ===`);
let lastSignal = 0, signalCache = null;

while (true) {
  if (!marketOpen()) { await new Promise(r => setTimeout(r, 300_000)); continue; } // 장외: 5분 슬립
  let holdings, cash;
  try {
    holdings = await getHoldings(seq);
    cash = Number((await getBuyingPower(seq, { currency: 'KRW' }))?.cashBuyingPower ?? 0);
    state.ipAlerted = false;
  } catch (e) {
    if (String(e.message).includes('no_authorization_ip') && !state.ipAlerted) { state.ipAlerted = true; log('⚠️ [IP인증실패] 토스 API IP 미등록 — 매매 불가. IP 갱신 필요! (1회 경보)'); }
    else if (!String(e.message).includes('no_authorization_ip')) log(`조회 실패(재시도): ${e.message.slice(0, 60)}`);
    await new Promise(r => setTimeout(r, POLL_MS)); continue;
  }
  const items = (holdings?.items ?? []).filter(i => i.marketCountry === 'KR' && Number(i.quantity) > 0);

  // ① 청산 판정 (트레일링 최대익절 + 하드손절)
  for (const it of items) {
    const px = Number(it.lastPrice), entry = Number(it.averagePurchasePrice), qty = Number(it.quantity);
    const m = state.meta[it.symbol] ?? (state.meta[it.symbol] = { hi: px, entry });
    m.hi = Math.max(m.hi ?? px, px);
    const ret = (px / entry - 1) * 100;
    let reason = null;
    if (px <= entry * (1 - HARD_STOP_PCT / 100)) reason = `하드손절 -${HARD_STOP_PCT}%`;
    else if (px <= m.hi * (1 - TRAIL_PCT / 100) && ret > 0) reason = `트레일링(고점대비 -${TRAIL_PCT}%, ${ret.toFixed(1)}%)`;
    else if (px <= m.hi * (1 - TRAIL_PCT / 100)) reason = `트레일손절(고점대비 -${TRAIL_PCT}%, ${ret.toFixed(1)}%)`;
    if (reason) {
      try {
        const o = await createOrder(seq, { symbol: it.symbol, side: 'SELL', orderType: 'MARKET', quantity: String(qty) });
        await waitFill(o?.orderId ?? o?.id, `매도 ${it.symbol}`);
        log(`매도 ${it.name}(${it.symbol}) ${qty}주 @${px.toLocaleString()} (${reason})`);
        recordTrade({ ts: now(), code: it.symbol, name: it.name, side: 'SELL', px, entry, ret: Number(ret.toFixed(1)), reason });
        delete state.meta[it.symbol];
      } catch (e) { log(`매도 오류 ${it.symbol}: ${e.message.slice(0, 80)}`); }
    }
  }
  writeFileSync(STATE, JSON.stringify(state, null, 1));

  // ② 진입 (슬롯 비었고 현금 있으면) — 신호는 15분 캐시(일봉 느림)
  if (items.length === 0 && cash >= MIN_PRICE) {
    if (Date.now() - lastSignal >= 900_000 || !signalCache) { signalCache = await pickCandidate(cash); lastSignal = Date.now(); }
    const { regime, pick } = signalCache;
    if (pick) {
      const qty = Math.floor(cash * 0.999 / pick.px);
      if (qty >= 1) {
        try {
          const o = await createOrder(seq, { symbol: pick.code, side: 'BUY', orderType: 'MARKET', quantity: String(qty) });
          await waitFill(o?.orderId ?? o?.id, `매수 ${pick.code}`);
          state.meta[pick.code] = { hi: pick.px, entry: pick.px, sub: pick.sub, boughtAt: now() };
          log(`매수 ${pick.name}(${pick.code}) ${qty}주 @${pick.px.toLocaleString()} [${pick.sub}, 레짐 ${regime}${pick.rsi2 != null ? ', RSI2 ' + pick.rsi2.toFixed(1) : ''}]`);
          recordTrade({ ts: now(), code: pick.code, name: pick.name, side: 'BUY', px: pick.px, qty, sub: pick.sub, regime });
          signalCache = null;
          writeFileSync(STATE, JSON.stringify(state, null, 1));
        } catch (e) { log(`매수 오류 ${pick.code}: ${e.message.slice(0, 80)}`); }
      }
    }
  }
  await new Promise(r => setTimeout(r, POLL_MS));
}
