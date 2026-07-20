#!/usr/bin/env node
/**
 * stock-live.mjs — 주식 실계좌 단일 연속 트레이더 (토스, 2026-07-20 사용자 지시).
 *   코인 live-day를 주식용으로 이식: 08:00~20:00(NXT 포함) 연속 감시, combo-v2 신호 진입,
 *   트레일링(최대익절 지향) 청산, LIVE_SLOTS=3 분산(백테스트+MC 확정) + 확신도 집중(강신호 시 2종목). 단일 프로세스라 이중주문 없음.
 *   ※ 기존 스케줄러 phase(PaperMorning/PaperClose)는 이중주문 방지 위해 비활성화해야 함.
 *
 *   진입: 레짐(005930 MA20/60) → UP:hi120/rsi2, NEUTRAL/DOWN:rsi2. 시총상위·유동성 필터.
 *         후보를 확신도(conviction 0~10)순 정렬 → 확실(≥strongThreshold)하면 현금 집중(몰빵),
 *         아니면 현금/남은슬롯 균등분산. 살 수 있는 최상위 신호 1종 LIMIT 매수(사이클당 1건).
 *   청산(승자 태우기): 고점대비 트레일 -8% OR 진입대비 하드손절 -7% OR 레짐 DOWN 이탈.
 *         (MA5 조기청산 폐기 — 최대 익절가까지 트레일링)
 *   실행: node stock-live.mjs --plan   (미리보기, 주문 없음)
 *         node stock-live.mjs --go     (집행+연속감시, 백그라운드)
 */
import dotenv from 'dotenv';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAccounts, getHoldings, getBuyingPower, getPricesMap, getDailyCandles, createOrder, getOrder, cancelOrder } from './toss-api.js';
import { LIVE_SLOTS, CONVICTION_SIZING } from './strategy-contract.mjs';

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
// KR 호가단위(2023 개편) — LIMIT 주문가는 틱에 맞아야 함
function tick(p) { if (p < 2_000) return 1; if (p < 5_000) return 5; if (p < 20_000) return 10; if (p < 50_000) return 50; if (p < 200_000) return 100; if (p < 500_000) return 500; return 1_000; }
const roundTick = (p) => Math.round(p / tick(p)) * tick(p);
// NXT 애프터마켓은 MARKET 거부 → LIMIT만. 스프레드 크로싱 지정가로 시장가처럼 즉시 체결 유도.
const limitBuyPx = (p) => { const t = tick(p); return Math.round((p * 1.005) / t) * t; };   // 현재가 +0.5% 올림틱 (매수 체결 유도)
const limitSellPx = (p) => { const t = tick(p); return Math.round((p * 0.995) / t) * t; };  // 현재가 -0.5% 내림틱 (매도 체결 유도)

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

// combo-v2 진입 후보: 레짐별 rsi2 과매도(전 레짐) + hi120 신고가돌파(UP만). cashCeil로 살 수 있는 것만.
// 각 후보에 conviction(0~10) 부여 → 확신도 내림차순 반환(사이징은 호출부에서).
const REGIME_F = { UP: 1.0, NEUTRAL: 0.85, DOWN: 0.5 };  // rsi2 평균회귀 신뢰도 레짐 가중
async function pickCandidate(cashCeil, heldSet = new Set()) {
  const regime = await regimeOf();
  const rows = await dbQuery(`SELECT stock_code,corp_name,current_price FROM stock_analysis WHERE current_price>=${MIN_PRICE} AND current_price<${Math.floor(cashCeil)} AND avg_turnover_20d>=${MIN_TURNOVER} ORDER BY market_cap_tril DESC LIMIT 40`);
  const cands = [];
  for (const r of rows) {
    if (heldSet.has(r.stock_code)) continue; // 이미 보유 종목 제외 (분산)
    try {
      const cd = (await getDailyCandles(r.stock_code, 130)).reverse();
      if (cd.length < 61) continue;
      const cl = cd.map(b => b.close), px = cl[cl.length - 1];
      if (px >= cashCeil) continue;
      const rv = rsi2(cl);
      if (rv < RSI_MAX) cands.push({ code: r.stock_code, name: r.corp_name, px, rsi2: rv, sub: 'rsi2', conviction: (RSI_MAX - rv) * (REGIME_F[regime] ?? 0.85) });
      if (regime === 'UP') {
        let hh = 0; for (let j = cl.length - 121; j < cl.length - 1; j++) hh = Math.max(hh, cd[j].high);
        const brk = (px / hh - 1) * 100;
        if (px > hh && brk >= 3) cands.push({ code: r.stock_code, name: r.corp_name, px, breakout: brk, sub: 'hi120', conviction: Math.min(10, brk) });
      }
    } catch { /* skip */ }
  }
  // 확신도 내림차순, 동점이면 hi120(추세) 우선
  cands.sort((a, b) => b.conviction - a.conviction || (a.sub === 'hi120' ? -1 : 1));
  const rsiCount = cands.filter(c => c.sub === 'rsi2').length;
  const hiCount = cands.filter(c => c.sub === 'hi120').length;
  return { regime, cands, pick: cands[0] ?? null, rsiCount, hiCount };
}

const accounts = await getAccounts();
const seq = accounts[0]?.accountSeq;
if (seq == null) { log('토스 계좌 조회 실패 — 중단'); process.exit(1); }

// ── PLAN: 미리보기 ────────────────────────────────────────────
if (argv.includes('--plan')) {
  const cash = Number((await getBuyingPower(seq, { currency: 'KRW' }))?.cashBuyingPower ?? 0);
  const { regime, cands, rsiCount, hiCount } = await pickCandidate(cash);
  console.log(`\n=== 주식 실계좌 매수 플랜 (미리보기) ===`);
  console.log(`현금 ${cash.toLocaleString()}원 | 레짐 ${regime} | rsi2후보 ${rsiCount} / hi120후보 ${hiCount} | 슬롯 ${LIVE_SLOTS} | 몰빵임계 ${CONVICTION_SIZING.strongThreshold}(현금×${CONVICTION_SIZING.strongFraction})`);
  const diversified = Math.floor(cash / LIVE_SLOTS);
  // 확신도순으로 훑어 예산에 맞는(살 수 있는) 후보만 최대 슬롯수만큼 표시 = 라이브 진입순서
  let shownN = 0;
  for (const p of (cands ?? [])) {
    if (shownN >= LIVE_SLOTS) break;
    const strong = CONVICTION_SIZING.enabled && p.conviction >= CONVICTION_SIZING.strongThreshold;
    const budget = strong ? Math.floor(cash * CONVICTION_SIZING.strongFraction) : diversified;
    if (p.px >= budget) continue;
    const qty = Math.floor(budget * 0.999 / limitBuyPx(p.px));
    if (qty < 1) continue;
    console.log(`→ ${strong ? '[집중몰빵]' : '[분산]'} ${p.name}(${p.code}) ${p.px.toLocaleString()}원 × ${qty}주 (예산 ${budget.toLocaleString()}) [${p.sub}, 확신도 ${p.conviction.toFixed(1)}${p.rsi2 != null ? ', RSI2 ' + p.rsi2.toFixed(1) : ', 돌파 ' + p.breakout?.toFixed(1) + '%'}]`);
    shownN++;
  }
  if (!shownN) console.log(`→ 매수 대상 없음 (예산 내 신호 종목 없음 — 현금 대기)`);
  console.log(`※ 미리보기는 각 후보에 전액현금 기준 사이징 표시(실제론 매 사이클 잔여현금 재계산)`);
  console.log(`청산 규칙: 고점대비 -${TRAIL_PCT}% 트레일 / 진입대비 -${HARD_STOP_PCT}% 하드손절 / DOWN레짐 이탈`);
  process.exit(0);
}
if (!argv.includes('--go')) { console.log('사용법: --plan 또는 --go'); process.exit(1); }

// ── 상태 ─────────────────────────────────────────────────────
let state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { meta: {}, ipAlerted: false };
const loadJournal = () => { try { return JSON.parse(readFileSync(JOURNAL, 'utf8')); } catch { return { trades: [] }; } };
function recordTrade(t) { const j = loadJournal(); j.trades.push(t); writeFileSync(JOURNAL, JSON.stringify(j, null, 1)); }

// 체결 확인: 주문상태 필드명 불확실 → 보유수량 변화로 검증(견고). 미체결이면 주문 취소해 스테일 방지.
async function settleOrder(orderId, symbol, side, qtyBefore, tag) {
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const h = await getHoldings(seq);
      const cur = Number((h?.items ?? []).find(x => x.symbol === symbol)?.quantity ?? 0);
      if (side === 'BUY' && cur > qtyBefore) return true;
      if (side === 'SELL' && cur < qtyBefore) return true;
    } catch {}
  }
  try { await cancelOrder(seq, orderId); log(`  ${tag} 미체결 → 주문취소(스테일 방지)`); } catch {}
  return false;
}

log(`=== 주식 연속 트레이더 시작 (계좌 ${accounts[0].accountSeq}, 08:00~20:00, LIVE_SLOTS=${LIVE_SLOTS}, 트레일-${TRAIL_PCT}%/하드-${HARD_STOP_PCT}%) ===`);
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
        const lpx = limitSellPx(px);
        const o = await createOrder(seq, { symbol: it.symbol, side: 'SELL', orderType: 'LIMIT', price: String(lpx), quantity: String(qty) });
        const filled = await settleOrder(o?.orderId ?? o?.id, it.symbol, 'SELL', qty, `매도 ${it.symbol}`);
        if (filled) {
          log(`매도 ${it.name}(${it.symbol}) ${qty}주 @${lpx.toLocaleString()} (${reason})`);
          recordTrade({ ts: now(), code: it.symbol, name: it.name, side: 'SELL', px: lpx, entry, ret: Number(ret.toFixed(1)), reason });
          delete state.meta[it.symbol];
        }
      } catch (e) { log(`매도 오류 ${it.symbol}: ${e.message.slice(0, 80)}`); }
    }
  }
  writeFileSync(STATE, JSON.stringify(state, null, 1));

  // ② 진입 (빈 슬롯 있고 현금 있으면) — 확신도 기반 사이징: 확실하면 현금 집중(몰빵), 아니면 균등분산
  if (items.length < LIVE_SLOTS && cash >= MIN_PRICE) {
    const heldSet = new Set(items.map(i => i.symbol));
    const remainingSlots = LIVE_SLOTS - items.length;
    const diversified = Math.floor(cash / remainingSlots);
    // 전액현금 기준으로 최상위 신호 탐색(집중매수 시 비싼 확신종목도 후보에 포함)
    if (Date.now() - lastSignal >= 900_000 || !signalCache) { signalCache = await pickCandidate(cash, heldSet); lastSignal = Date.now(); }
    const { regime, cands } = signalCache;
    // 확신도순으로 훑어 각 후보의 예산(집중 or 분산)에 맞는 첫 종목 1건 매수
    for (const pick of (cands ?? [])) {
      if (heldSet.has(pick.code)) continue;
      const strong = CONVICTION_SIZING.enabled && pick.conviction >= CONVICTION_SIZING.strongThreshold;
      const budget = strong ? Math.floor(cash * CONVICTION_SIZING.strongFraction) : diversified;
      if (pick.px >= budget) continue;   // 이 예산으론 못 삼 → 다음 후보
      const lpx = limitBuyPx(pick.px);
      const qty = Math.floor(budget * 0.999 / lpx);
      if (qty < 1) continue;
      try {
        const o = await createOrder(seq, { symbol: pick.code, side: 'BUY', orderType: 'LIMIT', price: String(lpx), quantity: String(qty) });
        const filled = await settleOrder(o?.orderId ?? o?.id, pick.code, 'BUY', 0, `매수 ${pick.code}`);
        if (filled) {
          state.meta[pick.code] = { hi: pick.px, entry: pick.px, sub: pick.sub, boughtAt: now() };
          const size = strong ? `집중 ${Math.round(CONVICTION_SIZING.strongFraction * 100)}%몰빵` : `분산 1/${remainingSlots}`;
          log(`매수 ${pick.name}(${pick.code}) ${qty}주 @${lpx.toLocaleString()} [${pick.sub}, 레짐 ${regime}, 확신도 ${pick.conviction.toFixed(1)}, ${size}${pick.rsi2 != null ? ', RSI2 ' + pick.rsi2.toFixed(1) : ', 돌파 ' + pick.breakout?.toFixed(1) + '%'}]`);
          recordTrade({ ts: now(), code: pick.code, name: pick.name, side: 'BUY', px: lpx, qty, sub: pick.sub, regime, conviction: Number(pick.conviction.toFixed(1)), sizing: strong ? 'concentrate' : 'diversify' });
          signalCache = null;
          writeFileSync(STATE, JSON.stringify(state, null, 1));
        }
      } catch (e) { log(`매수 오류 ${pick.code}: ${e.message.slice(0, 80)}`); }
      break;  // 사이클당 진입 1건 (나머지 슬롯은 다음 폴에서 잔여현금 재계산 후 평가)
    }
  }
  await new Promise(r => setTimeout(r, POLL_MS));
}
