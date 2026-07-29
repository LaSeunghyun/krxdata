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
import { LIVE_SLOTS, LIVE_UNIVERSE_LIMIT, CONVICTION_SIZING, FORECAST_GUARD, PARTIAL_TP, CA_GUARD, LIVE_EXCLUDE, CAPITAL_DEPLOY, SECTOR_CAP, RSI_ENTRY_FILTER, FLOW_EXIT } from './strategy-contract.mjs';
import { buildLiveCandidates } from './live-parity.mjs';
import { readBotExclude } from './bot-exclude.mjs';
import { executeBuy, executeSell } from './tg-order.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });
const argv = process.argv.slice(2);
const POLL_MS = 30_000;
const TRAIL_PCT = 6, HARD_STOP_PCT = 7;   // 승자 태우기: 고점 -6% 트레일(2026-07-24 uni420 재조정) / 진입 -7% 하드손절
const RSI_MAX = 10, MIN_TURNOVER = 3e9, MIN_PRICE = 2_000;
// rsi2 만기 (백테 combo-v2 maxHoldR과 동일). 종가판정에서 holdDays >= 이 값이면 청산 예약.
const MAX_HOLD_R = 5;
const RSI2_JUDGE_HHMM = 1535;   // 종가 판정 시각 — KRX 종가 동시호가(15:20~15:30) 종료 후
// 동일 종목 매수가 4xx로 연속 거부되면 당일 후보에서 제외 (07-28 프리마켓 31회 낭비 방지). 매도엔 미적용.
const ORDER_ERR_MAX = 3;
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
  // 2026-07-23: HMA(30) 실험 롤백 — SMA20/60 복원. HMA는 slots=10 백테선 우위였으나 진짜 live 설정
  //   (slots=3·tp+4/8) MC 5시드 재검증서 SMA가 CAGR +2.9%p 우위(4/5)·MDD 동률 → HMA 검증 실패(설정 아티팩트).
  const cd = await getDailyCandles('005930', 70);
  if (!Array.isArray(cd) || cd.length < 61) return 'NEUTRAL'; // ★ 캔들 부족 시 안전 가드
  const c = cd.reverse().map(b => b.close); // ★버그수정 2026-07-22: getDailyCandles는 newest-first → reverse 필수. 안 하면 ~70일 전(4월) 데이터로 레짐 계산했음(pickCandidate는 이미 reverse). 레짐게이트·skipNeutral 전부 영향.
  const i = c.length - 1; const avg = (n) => c.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n;
  const ma20 = avg(20), ma60 = avg(60), ret5 = (c[i] / c[i - 5] - 1) * 100;
  if (c[i] > ma20 && ma20 > ma60) return 'UP';
  if (c[i] < ma20 && ret5 < -3) return 'DOWN';
  return 'NEUTRAL';
}

// combo-v2 진입 후보: 레짐별 rsi2 과매도(전 레짐) + hi120 신고가돌파(UP만). cashCeil로 살 수 있는 것만.
// 각 후보에 conviction(0~10) 부여 → 확신도 내림차순 반환(사이징은 호출부에서).
const SCAN_CONCURRENCY = 15; // 2026-07-26 최적화: 동시배치 15개로 스캔 속도 향상
async function pickCandidate(cashCeil, heldSet = new Set()) {
  const regime = await regimeOf();
  const rows = await dbQuery(`SELECT stock_code,corp_name,current_price,sector FROM stock_analysis WHERE current_price>=${MIN_PRICE} AND current_price<${Math.floor(cashCeil)} AND avg_turnover_20d>=${MIN_TURNOVER} ORDER BY market_cap_tril DESC LIMIT ${LIVE_UNIVERSE_LIMIT}`);
  const dynExclude = readBotExclude(); // 텔레그램 수동매수 종목 = 봇 재매수 금지
  const targets = rows.filter(r => !heldSet.has(r.stock_code) && !LIVE_EXCLUDE.has(r.stock_code) && !dynExclude.has(r.stock_code)); // 보유·제외·수동관리 스킵
  const signals = [];
  for (let i = 0; i < targets.length; i += SCAN_CONCURRENCY) {
    const batch = targets.slice(i, i + SCAN_CONCURRENCY);
    const results = await Promise.all(batch.map(async (r) => {
      try {
        const cd = (await getDailyCandles(r.stock_code, 122)).reverse(); // 122일로 최적화하여 패치 지연 최소화
        if (!Array.isArray(cd) || cd.length < 61) return null;
        const cl = cd.map(b => b.close), px = cl[cl.length - 1];
        if (px >= cashCeil) return null;
        const rv = rsi2(cl);
        // 투매 확인용 거래량비: 당일 / 최근20일 평균
        const vols = cd.map(b => Number(b.volume) || 0);
        const prev20 = vols.slice(-21, -1); const avgVol = prev20.length ? prev20.reduce((a, b) => a + b, 0) / prev20.length : 0;
        const volRatio = avgVol > 0 ? vols[vols.length - 1] / avgVol : 1;
        let brk = 0;
        if (regime === 'UP') {
          let hh = 0; const startJ = Math.max(0, cl.length - 121); for (let j = startJ; j < cl.length - 1; j++) hh = Math.max(hh, cd[j]?.high ?? 0);
          brk = hh > 0 ? (px / hh - 1) * 100 : 0;
        }
        return { code: r.stock_code, name: r.corp_name, px, rsi: rv, rsi2: rv, breakoutPct: brk, breakout: brk, sector: r.sector, volRatio };
      } catch { return null; } // skip
    }));
    for (const s of results) if (s) signals.push(s);
  }
  // 캠페인 승자: rsi2 매수 시 투매 거래량 확인(rsiVolMin) + NEUTRAL 레짐 rsi2 스킵
  let cands = buildLiveCandidates(signals, { regime, rsiMax: RSI_MAX, minBreakout: 3, rsiVolMin: RSI_ENTRY_FILTER.volMin });
  if (RSI_ENTRY_FILTER.skipNeutral && regime === 'NEUTRAL') cands = cands.filter(c => c.sub !== 'rsi2');
  const rsiCount = cands.filter(c => c.sub === 'rsi2').length;
  const hiCount = cands.filter(c => c.sub === 'hi120').length;
  return { regime, cands, pick: cands[0] ?? null, rsiCount, hiCount };
}

// 시작 계좌 조회: 네트워크 블립("fetch failed")에 즉사하지 않도록 재시도(최대 10회, 지수백오프).
// keeper 5분 thrash 방지 + 시작 직후 포지션 무감시 구간 최소화.
async function getAccountsResilient() {
  for (let i = 0; i < 10; i++) {
    try { return await getAccounts(); }
    catch (e) {
      const wait = Math.min(30_000, 3_000 * (i + 1));
      log(`시작 계좌 조회 실패(${i + 1}/10, ${wait / 1000}s 후 재시도): ${String(e.message).slice(0, 60)}`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  return null;
}
const accounts = await getAccountsResilient();
const seq = accounts?.[0]?.accountSeq;
if (seq == null) { log('토스 계좌 조회 실패(10회 소진) — 중단, keeper 재기동 대기'); process.exit(1); }

// 섹터 캡용 code→sector 맵 (1회 로드, Supabase stock_analysis). 실패 시 빈 맵 = 캡 무효화(안전 기본).
let SECTOR = {};
if (SECTOR_CAP.enabled) {
  try {
    SECTOR = Object.fromEntries((await dbQuery(`SELECT stock_code, sector FROM stock_analysis`)).map(r => [r.stock_code, r.sector]));
    log(`섹터맵 로드 ${Object.keys(SECTOR).length}종목 (섹터캡 max ${SECTOR_CAP.max})`);
  } catch (e) { log(`섹터맵 로드 실패(캡 무효화): ${String(e.message).slice(0, 60)}`); }
}

// ── PLAN: 미리보기 ────────────────────────────────────────────
if (argv.includes('--plan')) {
  const cash = Number((await getBuyingPower(seq, { currency: 'KRW' }))?.cashBuyingPower ?? 0);
  const { regime, cands, rsiCount, hiCount } = await pickCandidate(cash);
  console.log(`\n=== 주식 실계좌 매수 플랜 (미리보기) ===`);
  console.log(`현금 ${cash.toLocaleString()}원 | 레짐 ${regime} | rsi2후보 ${rsiCount} / hi120후보 ${hiCount} | 슬롯 ${LIVE_SLOTS} | 몰빵임계 ${CONVICTION_SIZING.strongThreshold}(현금×${CONVICTION_SIZING.strongFraction})`);
  const diversified = Math.floor(cash / LIVE_SLOTS);
  // 확신도순으로 훑어 예산에 맞는(살 수 있는) 후보만 최대 슬롯수만큼 표시 = 라이브 진입순서
  let shownN = 0; const secSeen = {};
  for (const p of (cands ?? [])) {
    if (shownN >= LIVE_SLOTS) break;
    // 섹터 캡 미리보기 반영: 같은 섹터 max개 넘으면 표시 스킵 (라이브 진입과 일치)
    if (SECTOR_CAP.enabled && p.sector && (secSeen[p.sector] ?? 0) >= SECTOR_CAP.max) continue;
    const strong = CONVICTION_SIZING.enabled && p.conviction >= CONVICTION_SIZING.strongThreshold;
    const minRemainForSlots = MIN_PRICE * 2 * (LIVE_SLOTS - 1);
    const strongBudgetCap = Math.max(MIN_PRICE, cash - minRemainForSlots);
    const budget = strong ? Math.min(Math.floor(cash * CONVICTION_SIZING.strongFraction), strongBudgetCap) : diversified;
    if (p.px >= budget) continue;
    const qty = Math.floor(budget * 0.999 / limitBuyPx(p.px));
    if (qty < 1) continue;
    if (SECTOR_CAP.enabled && p.sector) secSeen[p.sector] = (secSeen[p.sector] ?? 0) + 1;
    console.log(`→ ${strong ? '[집중몰빵]' : '[분산]'} ${p.name}(${p.code}) ${p.px.toLocaleString()}원 × ${qty}주 (예산 ${budget.toLocaleString()}) [${p.sub}, ${p.sector ?? '섹터?'}, 확신도 ${p.conviction.toFixed(1)}${p.rsi2 != null ? ', RSI2 ' + p.rsi2.toFixed(1) : ', 돌파 ' + p.breakout?.toFixed(1) + '%'}]`);
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

// 수급붕괴 판정 (FLOW_EXIT). stock_investor_flows에서 종목별 최근 N거래일 누적 순매수 조회 → ≤ threshold면 청산대상.
//   하루 1회만 조회(수급은 장마감 후 확정). 조회 실패 시 빈 Set = 청산 안 함(안전 기본).
//   ★데이터가 N일 미확보인 종목은 제외(HAVING COUNT) — 백테의 "데이터 부족 시 룰 미적용"과 동일.
let flowCache = { day: null, breaking: new Set() };
async function flowBreaking(codes, today) {
  if (!codes.length) return new Set();
  if (flowCache.day === today) return flowCache.breaking;
  try {
    const rows = await dbQuery(`SELECT stock_code, SUM(net) AS total FROM (
        SELECT stock_code, (COALESCE(orgn_amt_mil,0) + COALESCE(frgn_amt_mil,0)) AS net,
               ROW_NUMBER() OVER (PARTITION BY stock_code ORDER BY date DESC) AS rn
        FROM stock_investor_flows WHERE stock_code IN (${codes.map(c => `'${c}'`).join(',')})
      ) t WHERE rn <= ${FLOW_EXIT.days}
      GROUP BY stock_code HAVING COUNT(*) >= ${FLOW_EXIT.days}`);
    const brk = new Set();
    for (const r of (Array.isArray(rows) ? rows : [])) {
      if (Number(r.total) / 100 <= FLOW_EXIT.threshold) brk.add(r.stock_code); // 백만원→억
    }
    flowCache = { day: today, breaking: brk };
    if (brk.size) log(`수급붕괴 감지 ${brk.size}종목: ${[...brk].join(',')}`);
    return brk;
  } catch (e) {
    log(`수급조회 실패(청산 보류): ${String(e.message).slice(0, 70)}`);
    return new Set();
  }
}

// 최신 KOSPI 프록시 시장 예측 (forecast_ledger). 실패/부재 시 null = 경보 없음(안전 기본).
// 스윙 보유(수일)엔 일간 예측(session=KRX_REGULAR, hm NULL)이 맞는 지평 → 일간 우선, 없으면 최신 아무거나.
async function marketForecast() {
  try {
    const rows = await dbQuery(`SELECT call_direction, probability_up, probability_down, confidence, forecast_median, forecast_created_at, session
      FROM forecast_ledger WHERE target_kind='market' AND sector='KOSPI_PROXY'
      ORDER BY (session='KRX_REGULAR') DESC, forecast_created_at DESC LIMIT 1`);
    if (!Array.isArray(rows) || !rows.length) return null;
    const r = rows[0];
    return { dir: r.call_direction, up: Number(r.probability_up), down: Number(r.probability_down),
             conf: Number(r.confidence), median: Number(r.forecast_median), at: r.forecast_created_at, session: r.session };
  } catch { return null; }
}
// 하락경보: call_direction=='down' 이거나 (하락확률−상승확률 ≥ probDiff AND confidence ≥ minConf)
function isBearish(f) {
  if (!f) return false;
  return f.dir === 'down' || (f.down - f.up >= FORECAST_GUARD.probDiff && f.conf >= FORECAST_GUARD.minConf);
}
// 텔레그램 경보 (CA 서킷 등 사람이 즉시 알아야 할 이벤트용). 실패해도 매매 무영향.
async function tgNotify(text) {
  try {
    const T = process.env.TELEGRAM_BOT_TOKEN, C = process.env.TELEGRAM_CHAT_ID;
    if (!T || !C) return;
    await fetch(`https://api.telegram.org/bot${T}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: C, text }) });
  } catch {}
}

log(`=== 주식 연속 트레이더 시작 (계좌 ${accounts[0].accountSeq}, 08:00~20:00, LIVE_SLOTS=${LIVE_SLOTS}, 트레일-${TRAIL_PCT}%/하드-${HARD_STOP_PCT}%, 예측가드 ${FORECAST_GUARD.enabled ? (FORECAST_GUARD.shadow ? 'SHADOW' : 'LIVE') : 'off'}) ===`);
let lastSignal = 0, signalCache = null;
let scanCash = 0, scanHeld = new Set();
// 상태 로그 스로틀: key가 바뀌거나 10분 경과 시에만 1줄 (매 사이클 도배 방지)
let gateKey = '', gateAt = 0;
function logGate(msg, key) {
  if (key === gateKey && Date.now() - gateAt < 600_000) return;
  gateKey = key; gateAt = Date.now(); log(msg);
}
// 신호스캔 독립 루프 (2026-07-24: uni420 확장 후 Toss 레이트리밋(10TPS, rateSlot)상 스캔 자체가 45초~2분 걸려
//   메인루프(30초 매도/손절 체크) 안에서 실행하면 그 체크까지 같이 지연됨 → 완전 분리, 메인루프는 항상 30초 유지.
//   scanCash/scanHeld는 메인루프가 매 사이클 최신값으로 갱신(아래), 매수 실행은 여전히 메인루프 for-loop에서
//   현재(fresh) heldSet으로 재검증하므로 이 캐시가 한 스캔주기만큼 낡아도 중복매수 위험 없음.
/**
 * 일봉 timestamp → KST YYYYMMDD.
 * Toss가 어떤 포맷을 주는지 미확인(확인엔 봇 정지 필요)이라 알려진 4가지를 모두 안전하게 처리한다.
 * 특히 **타임존 없는 ISO**("2026-07-29T15:30:00")를 그냥 new Date()에 넣으면 VM이 UTC라 날짜가 밀린다 → KST로 간주.
 */
function barDay(ts) {
  if (typeof ts === 'string') {
    const ymd = ts.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
    if (ymd && !/[TZ+]/.test(ts.slice(10))) return ymd[1] + ymd[2] + ymd[3];   // 날짜만 → 그대로
    const s = /[Z+]|-\d{2}:\d{2}$/.test(ts.slice(10)) ? ts : ts + '+09:00';     // 타임존 없으면 KST로 간주
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? '' : new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '');
  }
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date((n < 1e12 ? n * 1000 : n) + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * ★ rsi2 종가 판정 (2026-07-29 신규) — 하루 1회, 15:35 이후.
 *   검증된 combo-v2 rsi2 청산을 라이브에 이식한다: 트레일 없음 · 종가 > MA5 익절 · 진입-7% 손절 · 5거래일 만기.
 *   판정만 하고 집행은 익일(예약). 같은 날 집행되지 않도록 exitDay를 같이 박는다.
 *
 * 설계 요점
 *  - **당일 종가**: Toss 일봉의 최신 봉 날짜가 오늘이면 그 종가(권위 있음), 아니면 현재가로 대체한다.
 *    15:35엔 KRX가 이미 마감(15:30)이라 현재가 ≈ 당일 종가다. 어느 쪽을 썼는지 로그에 남겨
 *    "Toss가 15:35에 당일봉을 주는가"라는 미검증 가정을 하루만 돌려 실측으로 바꾼다.
 *  - **holdDays를 카운터로 세지 않는다**: 진입일 이후의 일봉 개수로 계산한다. 휴장일 오판이 없고,
 *    구 규칙으로 산 기존 보유분도 마이그레이션 없이 정확한 값이 나온다(무상태·자기정정).
 */
async function judgeRsi2AtClose(items, state, today) {
  for (const it of items) {
    const m = state.meta[it.symbol];
    if (!m || m.sub !== 'rsi2' || m.exitAt) continue;
    if (m.judgedDay === today) continue;                       // 하루 1회
    let cd;
    try { cd = (await getDailyCandles(it.symbol, 12)).reverse(); } catch (e) { log(`종가판정 일봉조회 실패 ${it.symbol}: ${String(e.message).slice(0, 60)}`); continue; }
    if (!Array.isArray(cd) || cd.length < 5) continue;

    const newest = cd[cd.length - 1];
    const newestDay = barDay(newest.timestamp);
    const hasToday = newestDay === today.replace(/-/g, '');
    // 첫 판정 1회만 원본 timestamp를 남긴다 — barDay 파싱이 맞는지 실측으로 확인하기 위한 것
    if (!state.tsFmtLogged) { state.tsFmtLogged = true; log(`[일봉 timestamp 포맷 확인] raw=${JSON.stringify(newest.timestamp)} → barDay=${newestDay} (오늘=${today.replace(/-/g, '')})`); }
    const livePx = Number(it.lastPrice);
    const closeToday = hasToday ? Number(newest.close) : livePx;
    if (!(closeToday > 0)) continue;
    // MA5 = 당일 종가 + 직전 4일 종가. hasToday면 최신봉이 당일이므로 그 앞 4개를 쓴다.
    const prior = (hasToday ? cd.slice(0, -1) : cd).map(b => Number(b.close)).filter(v => v > 0);
    if (prior.length < 4) continue;
    const ma5 = (closeToday + prior.slice(-4).reduce((a, b) => a + b, 0)) / 5;

    const entry = Number(m.entry ?? it.averagePurchasePrice);
    const bDay = String(m.boughtAt ?? '').slice(0, 10).replace(/-/g, '');
    const holdDays = bDay ? cd.filter(b => barDay(b.timestamp) > bDay).length : 0;
    m.judgedDay = today; m.holdDays = holdDays;

    const ret = (closeToday / entry - 1) * 100;
    let why = null;
    if (closeToday <= entry * (1 - HARD_STOP_PCT / 100)) why = `손절 -${HARD_STOP_PCT}%`;
    else if (closeToday > ma5) why = 'MA5회귀 익절';
    else if (holdDays >= MAX_HOLD_R) why = `만기 ${MAX_HOLD_R}거래일`;
    if (why) { m.exitAt = why; m.exitDay = today; }
    log(`종가판정 ${it.name}(${it.symbol}) 종가 ${closeToday.toLocaleString()}${hasToday ? '(일봉)' : '(현재가대체)'} / MA5 ${Math.round(ma5).toLocaleString()} / ${ret.toFixed(1)}% / ${holdDays}일차 → ${why ? '★예약 ' + why : '보유 유지'}`);
  }
  writeFileSync(STATE, JSON.stringify(state, null, 1));
}

async function signalScanLoop() {
  while (true) {
    try {
      if (marketOpen() && scanCash >= MIN_PRICE) {
        signalCache = await pickCandidate(scanCash, scanHeld);
        lastSignal = Date.now();
      }
    } catch (e) { log(`신호스캔 오류: ${String(e.message).slice(0, 80)}`); }
    await new Promise(r => setTimeout(r, 5_000)); // 완료 즉시 잠깐 쉬고 재스캔(실제 페이싱은 rateSlot 전역 10TPS가 담당)
  }
}
signalScanLoop();

// 매도 사인 (수동픽 보유분이 AI 목표/손절 도달 시 텔레그램 알림, 자동매도 X). 30초 루프의 holdings 재사용 = Toss 추가호출 0.
const TG_T = process.env.TELEGRAM_BOT_TOKEN, TG_C = process.env.TELEGRAM_CHAT_ID;
const tgSend = async (t) => { if (!TG_T || !TG_C) return; try { await fetch(`https://api.telegram.org/bot${TG_T}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_C, text: t }) }); } catch {} };
async function emitSellSignals(holdings, manualCodes, today) {
  const held = (holdings?.items ?? []).filter(i => i.marketCountry === 'KR' && Number(i.quantity) > 0 && manualCodes.has(i.symbol));
  if (!held.length) return;
  const sig = (state.sellSig ??= {});
  let strat = [];
  try { strat = await dbQuery(`SELECT DISTINCT ON (stock_code) stock_code,name,strategy FROM ai_shadow_decisions WHERE stock_code IN (${held.map(i => `'${i.symbol}'`).join(',')}) AND decision='buy' ORDER BY stock_code, run_at DESC`); } catch {}
  const sMap = new Map(strat.map(r => [r.stock_code, { name: r.name, s: typeof r.strategy === 'string' ? (() => { try { return JSON.parse(r.strategy); } catch { return null; } })() : r.strategy }]));
  for (const it of held) {
    const entry = Number(it.averagePurchasePrice), cur = Number(it.lastPrice);
    if (!entry || !cur) continue;
    const ret = (cur / entry - 1) * 100;
    const info = sMap.get(it.symbol); const st = info?.s; const nm = info?.name || it.name || it.symbol;
    const tgt = Number(st?.target_pct ?? 7), stp = Number(st?.stop_pct ?? 5);
    let type = null, label = null;
    if (ret >= tgt) { type = 'target'; label = `🎯 목표 +${tgt}% 도달`; }
    else if (ret <= -stp) { type = 'stop'; label = `🛑 손절선 -${stp}% 도달`; }
    if (!type) continue;
    const key = `${it.symbol}:${type}`;
    if (sig[key] === today) continue; // 종목·유형당 하루 1회
    sig[key] = today;
    await tgSend(`🔔 매도 사인: ${nm}(${it.symbol}) ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}% (${label})\n진입 ${entry.toLocaleString()} → 현재 ${cur.toLocaleString()}\n팔려면 텔레그램: 매도 ${nm}`);
    writeFileSync(STATE, JSON.stringify(state, null, 1));
  }
}

// 텔레그램 주문 큐 집행 — telegram-agent가 적재한 매수/매도를 stock-live의 단일 Toss 세션으로 집행(경합 0). 결과는 텔레그램 전송.
async function processOrderQueue(seq) {
  const e2 = (s) => String(s ?? '').replace(/'/g, "''");
  // H2: 오래된 pending 만료(장경계·지연 → 다음날 엉뚱가격 집행 방지)
  try {
    const exp = await dbQuery(`UPDATE tg_order_queue SET status='expired', done_at=NOW() WHERE status='pending' AND requested_at <= NOW() - INTERVAL '10 minutes' RETURNING name, side`);
    for (const e of (Array.isArray(exp) ? exp : [])) await tgSend(`⏰ 주문 만료(10분 미집행): ${e.side === 'buy' ? '매수' : '매도'} ${e.name} — 필요하면 다시 명령해줘.`);
  } catch {}
  let pend = [];
  try { pend = await dbQuery(`SELECT id, side, name, amount_krw, target_price FROM tg_order_queue WHERE status='pending' AND requested_at > NOW() - INTERVAL '10 minutes' ORDER BY id LIMIT 5`); } catch { return 0; }
  let executed = 0;
  for (const o of pend) {
    // C1: 실행 전 원자적 선점 — 중복 집행 방지(크래시 시 processing서 멈춤 = 재집행 안 됨 ≫ 중복매수)
    let claim;
    try { claim = await dbQuery(`UPDATE tg_order_queue SET status='processing', claimed_at=NOW() WHERE id=${o.id} AND status='pending' RETURNING id`); } catch { continue; }
    if (!Array.isArray(claim) || !claim.length) continue; // 이미 다른 사이클이 가져감
    let r, threw = false;
    try {
      if (o.side === 'ca-clear') {
        const res = await resolveStock(o.name, { dbQuery });
        if (res.status === 'ok') {
          if (state.meta[res.code]) {
            delete state.meta[res.code].caHold;
            delete state.meta[res.code].caAlertDay;
            writeFileSync(STATE, JSON.stringify(state, null, 1));
          }
          r = { ok: true, msg: `✅ [CA서킷 해제] ${res.name}(${res.code}) 봇 자동 매도/손절 정상 재개` };
        } else {
          r = { ok: false, msg: `[CA서킷 해제 실패] '${o.name}' 종목을 찾지 못함` };
        }
      } else {
        r = o.side === 'buy'
          ? await executeBuy({ name: o.name, amountKrw: Number(o.amount_krw) }, { dbQuery, seq, dryRun: false })
          : await executeSell({ name: o.name, targetPrice: o.target_price != null ? Number(o.target_price) : undefined }, { dbQuery, seq, dryRun: false });
      }
    } catch (e) { threw = true; r = { ok: false, msg: String(e.message).slice(0, 150) }; }
    executed++;
    // H1: 응답 실패(throw)면 주문이 Toss에 접수됐을 수 있음 → 'error_check'로 두고 경보(failed 단정 금지)
    const st = threw ? 'error_check' : (r.ok ? 'done' : 'failed');
    try {
      await dbQuery(`UPDATE tg_order_queue SET status='${st}', result='${e2(r.msg)}', order_id='${e2(r.orderId)}', done_at=NOW() WHERE id=${o.id}`);
    } catch {
      await tgSend(`🚨 주문 상태갱신 실패 (id ${o.id} ${o.name}) — ${r.ok ? '체결됐으나 원장 미갱신' : ''}. 큐/계좌 수동확인 필요. (processing 상태라 재집행은 안 됨)`);
      continue;
    }
    if (threw) await tgSend(`⚠️ 주문 응답 불확실: ${o.name} — Toss에 접수됐을 수 있음. 계좌·체결 직접 확인해줘. (${r.msg})`);
    else await tgSend((r.ok ? '' : '⚠️ ') + r.msg);
  }
  return executed;
}

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
  // LIVE_EXCLUDE(정적) + 동적 봇제외(텔레그램 수동매수, .bot-exclude.json)는 봇이 전혀 안 건드림 — items에서 제외(청산·슬롯계산 모두 스킵)
  const EXCLUDED = new Set([...LIVE_EXCLUDE, ...readBotExclude()]);
  const items = (holdings?.items ?? []).filter(i => i.marketCountry === 'KR' && Number(i.quantity) > 0 && !EXCLUDED.has(i.symbol));
  const today = now().slice(0, 10);
  // ★ meta 고아 정리 (2026-07-28 버그 수정): 사용자가 토스 앱에서 직접 팔면 봇은 매도를 못 봐서 meta가 남는다.
  //   그 종목을 나중에 다시 사면 372행이 **낡은 meta를 그대로 재사용**해 옛 고점으로 트레일을 계산하고
  //   (즉시 매도 위험) 옛 진입가로 하드손절을 잡고 tp1:true가 남아 부분익절을 건너뛴다.
  //   조회 실패·부분응답으로 트레일 고점을 잃지 않게 **3사이클 연속 미보유**일 때만 삭제한다.
  if (holdings?.items) {
    const heldNow = new Set((holdings.items ?? []).filter(i => Number(i.quantity) > 0).map(i => i.symbol));
    const miss = (state.metaMiss ??= {});
    let purged = 0;
    for (const code of Object.keys(state.meta)) {
      if (heldNow.has(code)) { delete miss[code]; continue; }
      miss[code] = (miss[code] ?? 0) + 1;
      if (miss[code] >= 3) { delete state.meta[code]; delete miss[code]; purged++; }
    }
    if (purged) log(`meta 고아 정리 ${purged}건 (미보유 3사이클 연속) → 남은 ${Object.keys(state.meta).length}건`);
  }
  // 당일 재진입 금지 목록은 날이 바뀌면 정리 (파일 무한 증가 방지)
  if (state.soldToday) {
    for (const [c, d] of Object.entries(state.soldToday)) if (d !== today) delete state.soldToday[c];
  }
  // ★ 주문거부 백오프 목록도 날이 바뀌면 정리 (2026-07-29)
  //   근거: 07-28 08:14~08:32 NXT 프리마켓에서 322000 매수를 35초 간격 31회 던져 31회 전부 422 거부.
  //   현금 609만·슬롯 0/5로 실탄이 충분했는데 18분을 같은 거부에 소모하고 프리마켓 매수 0건으로 끝났다.
  //   거래소가 거부하는 주문은 재시도로 뚫리지 않는다 → 동일 종목 N회 연속 거부면 당일 후보에서 제외.
  if (state.orderErr) {
    for (const [c, v] of Object.entries(state.orderErr)) if (v?.day !== today) delete state.orderErr[c];
  }
  try { await emitSellSignals(holdings, readBotExclude(), today); } catch (e) { log(`매도사인 오류: ${String(e.message).slice(0, 80)}`); } // 수동픽 목표/손절 도달 시 텔레그램 매도사인(자동매도 X)
  try { const ne = await processOrderQueue(seq); if (ne > 0) cash = Number((await getBuyingPower(seq, { currency: 'KRW' }))?.cashBuyingPower ?? cash); } catch (e) { log(`주문큐 오류: ${String(e.message).slice(0, 80)}`); } // 큐 집행 후 현금 재조회(M3)

  // 시장 예측 조회 (하락경보 판정) — forecast_ledger 최신 KOSPI 프록시
  const fc = FORECAST_GUARD.enabled ? await marketForecast() : null;
  const bear = isBearish(fc);

  // 수급붕괴 청산용 조회(하루 1회 — 수급은 장마감 후 확정이라 장중 재조회 불필요)
  const flowBrk = FLOW_EXIT.enabled ? await flowBreaking(items.filter(i => state.meta[i.symbol]?.sub === 'hi120').map(i => i.symbol), today) : new Set();

  // ① 청산 판정 (트레일링 최대익절 + 하드손절) + 예측하락 이익보호(신규) + 수급붕괴(신규)
  for (const it of items) {
    const px = Number(it.lastPrice), entry = Number(it.averagePurchasePrice), qty = Number(it.quantity);
    const m = state.meta[it.symbol] ?? (state.meta[it.symbol] = { hi: px, entry });
    const ret = (px / entry - 1) * 100;

    // ⓪-CA: 무상증자·분할 서킷브레이커 — 직전 관측 대비 급락 시 자동매도 보류(헐값 매도 방지) + 경보.
    if (CA_GUARD.enabled) {
      if (m.lastPx && px < m.lastPx * (1 - CA_GUARD.dropPct / 100)) m.caHold = true; // 급락 감지
      if (m.caHold) {
        if (ret >= CA_GUARD.clearRet) { m.caHold = false; delete m.caAlertDay; } // 조정 반영/회복 → 정상 재개
        else {
          if (m.caAlertDay !== today) {
            const msg = `⚠️ [CA서킷] ${it.name}(${it.symbol}) 급락 감지(${ret.toFixed(1)}%, 직전 ${m.lastPx?.toLocaleString()}→${px.toLocaleString()}) — 무상증자·분할 의심, 자동매도 보류. 수동 확인 필요!`;
            log(msg); tgNotify(msg); m.caAlertDay = today;
          }
          m.lastPx = px;
          writeFileSync(STATE, JSON.stringify(state, null, 1));
          continue; // 이 종목 자동매도(부분익절·손절·트레일) 전면 스킵
        }
      }
      m.lastPx = px;
    }
    m.hi = Math.max(m.hi ?? px, px);

    // ⓪-FLOW 수급붕괴 청산 (2026-07-25 배포, 사용자 결정): hi120 보유분의 최근 10거래일 누적(기관+외국인) ≤ 0 → 전량 청산.
    //   ★백테스트 우선순위와 동일하게 부분익절·트레일보다 먼저 판정(검증된 동작을 그대로 재현).
    //   MC 10시드: CAGR +0.5%p(중립) / MDD -1.8%p 개선(6/10), 최악시드 낙폭 대폭 축소(27.5→18.3 등), Calmar 1.65→1.82.
    if (flowBrk.has(it.symbol) && !m.flowSold) {
      try {
        const lpx = limitSellPx(px);
        const o = await createOrder(seq, { symbol: it.symbol, side: 'SELL', orderType: 'LIMIT', price: String(lpx), quantity: String(qty) });
        const filled = await settleOrder(o?.orderId ?? o?.id, it.symbol, 'SELL', qty, `수급청산 ${it.symbol}`);
        if (filled) {
          const rsn = `수급붕괴(기관+외국인 ${FLOW_EXIT.days}일 순매도)`;
          log(`매도 ${it.name}(${it.symbol}) ${qty}주 @${lpx.toLocaleString()} (${rsn}, ${ret.toFixed(1)}%)`);
          recordTrade({ ts: now(), code: it.symbol, name: it.name, side: 'SELL', px: lpx, entry, ret: Number(ret.toFixed(1)), reason: rsn });
          delete state.meta[it.symbol];
          (state.soldToday ??= {})[it.symbol] = today;   // 당일 재진입 금지
          writeFileSync(STATE, JSON.stringify(state, null, 1));
          continue;
        }
        m.flowSold = today; // 미체결 → 당일 재시도 안 함(다음날 재판정)
      } catch (e) { log(`수급청산 오류 ${it.symbol}: ${String(e.message).slice(0, 80)}`); }
    }

    // ⓪ 부분익절 (백테스트 검증): +tp1Pct 절반 / +tp2Pct 잔량절반. 나머지는 아래 트레일 유지.
    // ★ 2026-07-29: hi120 전용으로 제한. 백테는 부분익절을 hi120에만 적용하는데(tp1R/tp2R 블록이
    //   `if (p.sub === 'hi120')` 안에 있다) 라이브는 07-21 이식 때 sub 분기를 안 가져와 rsi2에도 걸었다.
    //   10시드 MC: rsi2 부분익절만 추가해도 Calmar 1.71 → 1.59 (단일경로), 트레일과 합치면 1승 9패.
    if (PARTIAL_TP.enabled && m.sub === 'hi120') {
      let tpTag = null;
      if (ret >= PARTIAL_TP.tp2Pct && m.tp1 && !m.tp2) tpTag = 'tp2';
      else if (ret >= PARTIAL_TP.tp1Pct && !m.tp1) tpTag = 'tp1';
      if (tpTag) {
        const tpQty = Math.floor(qty / 2);
        if (tpQty >= 1) {
          try {
            const lpx = limitSellPx(px);
            const o = await createOrder(seq, { symbol: it.symbol, side: 'SELL', orderType: 'LIMIT', price: String(lpx), quantity: String(tpQty) });
            const filled = await settleOrder(o?.orderId ?? o?.id, it.symbol, 'SELL', qty, `부분익절 ${it.symbol}`);
            if (filled) {
              m[tpTag] = true;
              const pct = tpTag === 'tp2' ? PARTIAL_TP.tp2Pct : PARTIAL_TP.tp1Pct;
              log(`부분익절 ${it.name}(${it.symbol}) ${tpQty}주 @${lpx.toLocaleString()} (+${pct}% 도달, ${ret.toFixed(1)}%)`);
              recordTrade({ ts: now(), code: it.symbol, name: it.name, side: 'SELL', px: lpx, qty: tpQty, entry, ret: Number(ret.toFixed(1)), reason: `부분익절(${tpTag}) +${pct}%` });
              writeFileSync(STATE, JSON.stringify(state, null, 1));
            }
          } catch (e) { log(`부분익절 오류 ${it.symbol}: ${e.message.slice(0, 80)}`); }
          continue; // 이번 사이클은 부분익절만 — 남은 수량은 다음 폴에서 추가익절/트레일 평가
        }
      }
    }

    let reason = null, harvest = false;
    // 기존(검증된 combo-v2) 청산 — 항상 실집행
    // ★ 2026-07-29 rsi2 청산 전면 개편 (검증 3종 통과 — 오늘 유일)
    //   ① 예약청산 집행: 전일 15:35 종가판정으로 예약된 건을 익일 개장 후 집행.
    //      "익일 시가"는 08시(NXT)다 — candles-daily 시가가 08시 첫봉과 88.9% 일치(KRX+NXT 통합 데이터).
    //      08시/09시 집행은 수익 차이 없음(782쌍 중 455건 동일, 갈리는 327건 160:167) → 시각 고정 안 하고
    //      미체결 시 settleOrder가 취소·재시도하게 둔다(프리마켓 유동성 부족이면 자연히 09시로 밀림).
    //   ② rsi2는 장중 트레일·하드손절 판정을 하지 않는다. 분봉 782쌍에서 장중 개입은 전부 악화:
    //      트레일 +0.38%→-0.31% · 실시간 -7% 손절 +0.38%→-0.11%. "작게 이기고 크게 진다"가 반복 확인됨.
    // exitDay !== today 가드: 판정한 당일에는 집행하지 않는다("종가 판정 → 익일 집행"을 순서와 무관하게 보장)
    if (m.exitAt && m.exitDay !== today) {
      reason = `예약청산(${m.exitAt}, ${m.holdDays ?? '?'}일차, ${m.exitDay} 종가판정)`;
    }
    else if (m.sub === 'rsi2') { /* 장중 무개입 — 판정은 15:35 종가에만 (judgeRsi2AtClose) */ }
    else if (px <= entry * (1 - HARD_STOP_PCT / 100)) reason = `하드손절 -${HARD_STOP_PCT}%`;
    else if (px <= m.hi * (1 - TRAIL_PCT / 100) && ret > 0) reason = `트레일링(고점대비 -${TRAIL_PCT}%, ${ret.toFixed(1)}%)`;
    else if (px <= m.hi * (1 - TRAIL_PCT / 100)) reason = `트레일손절(고점대비 -${TRAIL_PCT}%, ${ret.toFixed(1)}%)`;
    // 신규: 예측 하락경보 이익보호 — 기존 규칙 미발동 & 수익종목이 조인 트레일(bearTrailPct) 이탈 시
    else if (bear && ret >= FORECAST_GUARD.harvestRetPct && px <= m.hi * (1 - FORECAST_GUARD.bearTrailPct / 100)) {
      harvest = true;
      reason = `예측하락 이익보호(트레일-${FORECAST_GUARD.bearTrailPct}%, ${ret.toFixed(1)}%, 하락${fc.down}/상승${fc.up} conf${fc.conf})`;
    }
    if (reason) {
      // shadow 모드: 예측하락 이익보호는 실집행 없이 하루 1회 기록만 (검증 데이터 축적). 기존 청산은 그대로 실집행.
      if (harvest && FORECAST_GUARD.shadow) {
        if (m.shadowDay !== today) {
          log(`[SHADOW] 이익보호 예정: ${it.name}(${it.symbol}) ${ret.toFixed(1)}% — ${reason}`);
          recordTrade({ ts: now(), code: it.symbol, name: it.name, side: 'SHADOW_HARVEST', px, entry, ret: Number(ret.toFixed(1)), reason, forecast: fc });
          m.shadowDay = today;
        }
        continue; // 실제 매도 안 함
      }
      try {
        const lpx = limitSellPx(px);
        const o = await createOrder(seq, { symbol: it.symbol, side: 'SELL', orderType: 'LIMIT', price: String(lpx), quantity: String(qty) });
        const filled = await settleOrder(o?.orderId ?? o?.id, it.symbol, 'SELL', qty, `매도 ${it.symbol}`);
        if (filled) {
          log(`매도 ${it.name}(${it.symbol}) ${qty}주 @${lpx.toLocaleString()} (${reason})`);
          recordTrade({ ts: now(), code: it.symbol, name: it.name, side: 'SELL', px: lpx, entry, ret: Number(ret.toFixed(1)), reason, forecast: harvest ? fc : undefined });
          delete state.meta[it.symbol];
          (state.soldToday ??= {})[it.symbol] = today;   // 당일 재진입 금지(아래 진입 루프에서 스킵)
        }
        // ★ 매도는 백오프를 걸지 않는다 (2026-07-29). 청산을 막으면 손실이 무한정 열린다 —
        //   매수와 달리 재시도 낭비보다 미청산 리스크가 크다. 오류 전문만 300자로 늘린다.
      } catch (e) { log(`매도 오류 ${it.name}(${it.symbol}): ${String(e.message).slice(0, 300)}`); }
    }
  }
  writeFileSync(STATE, JSON.stringify(state, null, 1));

  // ★ rsi2 종가 판정 (2026-07-29) — 15:35 이후 하루 1회. 판정만, 집행은 익일.
  {
    const k = kst();
    const hhmm = k.getUTCHours() * 100 + k.getUTCMinutes();
    if (hhmm >= RSI2_JUDGE_HHMM && items.some(i => state.meta[i.symbol]?.sub === 'rsi2' && state.meta[i.symbol]?.judgedDay !== today)) {
      try { await judgeRsi2AtClose(items, state, today); } catch (e) { log(`종가판정 오류: ${String(e.message).slice(0, 120)}`); }
    }
  }

  // 하락경보 시 신규진입 보류 (shadow면 기록만, live면 실제 스킵)
  if (bear && items.length < LIVE_SLOTS && cash >= MIN_PRICE) {
    if (FORECAST_GUARD.shadow) {
      if (state.shadowBearDay !== today) { log(`[SHADOW] 하락경보(하락${fc.down}/상승${fc.up} conf${fc.conf}) — 신규진입 보류 대상(실제로는 진행)`); state.shadowBearDay = today; }
    }
  }

  // ② 진입 — 자본기반 게이트(CAPITAL_DEPLOY). perSlot=equity/slots, 유휴현금이 반슬롯↑이면 편입.
  //   레거시 dust(시가평가<perSlot*dustFraction)는 슬롯 카운트 제외 → 큰 현금이 dust에 막히지 않음.
  const posVal = items.reduce((s, it) => s + Number(it.quantity) * Number(it.lastPrice), 0);
  const equity = cash + posVal;
  const perSlot = Math.max(MIN_PRICE, Math.floor(equity / LIVE_SLOTS));
  const bigCount = CAPITAL_DEPLOY.enabled
    ? items.filter(it => Number(it.quantity) * Number(it.lastPrice) >= perSlot * CAPITAL_DEPLOY.dustFraction).length
    : items.length;
  const canDeploy = CAPITAL_DEPLOY.enabled
    ? (bigCount < LIVE_SLOTS && cash >= perSlot * CAPITAL_DEPLOY.minFillFraction && cash >= MIN_PRICE)
    : (items.length < LIVE_SLOTS && cash >= MIN_PRICE);
  if (canDeploy && !(bear && !FORECAST_GUARD.shadow)) {
    const heldSet = new Set(items.map(i => i.symbol));
    const remainingSlots = Math.max(1, LIVE_SLOTS - bigCount);
    const diversified = Math.min(cash, perSlot);   // 한 슬롯 예산(초과 현금은 다음 폴에서 추가 편입)
    // 전액현금 기준으로 최상위 신호 탐색(집중매수 시 비싼 확신종목도 후보에 포함). 스캔은 signalScanLoop가 독립수행.
    scanCash = cash; scanHeld = heldSet; // 다음 백그라운드 스캔부터 최신 현금·보유현황 반영
    const { regime, cands } = signalCache ?? { regime: null, cands: [] }; // 재시작 직후 첫 스캔 완료 전 = 빈 후보로 안전 대기
    // 진입대기 가시성(2026-07-27): 후보 0건이면 아무 로그도 안 남아 "왜 안 사는지"를 매번 수동확인해야 했음.
    //   레짐 변경·후보 유무 반전 시, 그리고 최소 10분마다 1줄. (5초 스캔마다 찍으면 로그 폭발)
    const blockedToday = Object.values(state.soldToday ?? {}).filter(d => d === today).length;
    logGate(`진입대기: 레짐 ${regime ?? '스캔중'} · 후보 ${cands?.length ?? 0}건 · 현금 ${Math.round(cash / 10000).toLocaleString()}만 · 슬롯 ${bigCount}/${LIVE_SLOTS}${blockedToday ? ` · 당일재진입금지 ${blockedToday}종목` : ''}`,
      `${regime ?? '스캔중'}|${(cands?.length ?? 0) > 0 ? 'cand' : 'none'}`);

    // 확신도순으로 훑어 각 후보의 예산(집중 or 분산)에 맞는 첫 종목 1건 매수
    // ★ 당일 재진입 금지 (2026-07-29 사용자 승인). 폭락장 휩소 대응.
    //   실측 근거: 07-28~29 청산 16건 중 승 3건(19%)·합계 -40.5%p인데 그 **53%가 두산퓨얼셀 단일 종목 4회 휩소**
    //   (26,200 → 24,300 → 22,950 → 20,550 계단식 하락에 매번 재진입해 매번 -3~6% 손절).
    //   일봉 백테는 하루 1회만 판정해 이 동작이 아예 없다 = "DOWN에서 rsi2 유지"(10시드 1승9패) 검증 범위 밖.
    //   비용도 실재: 청산 16회 × 왕복 0.33%p ≈ 계좌 -1.1%가 순수 마찰.
    //   진입만 막는다(청산 로직 불변). 다음 거래일부터 재진입 허용.
    const soldT = state.soldToday ?? {};
    const errT = state.orderErr ?? {};
    for (const pick of (cands ?? [])) {
      if (heldSet.has(pick.code)) continue;
      if (soldT[pick.code] === today) continue;
      if ((errT[pick.code]?.n ?? 0) >= ORDER_ERR_MAX) continue;   // 당일 주문거부 누적 → 다음 후보로
      // 섹터 캡: 후보와 같은 섹터를 이미 SECTOR_CAP.max개 보유 중이면 스킵(금융 편중 차단). sector 미상(null)은 캡 미적용.
      if (SECTOR_CAP.enabled) { const psec = SECTOR[pick.code]; if (psec && items.filter(it => SECTOR[it.symbol] === psec).length >= SECTOR_CAP.max) continue; }
      const strong = CONVICTION_SIZING.enabled && pick.conviction >= CONVICTION_SIZING.strongThreshold;
      const minRemainForSlots = MIN_PRICE * 2 * (LIVE_SLOTS - 1);
      const strongBudgetCap = Math.max(MIN_PRICE, cash - minRemainForSlots);
      const budget = strong ? Math.min(Math.floor(cash * CONVICTION_SIZING.strongFraction), strongBudgetCap) : diversified;
      if (pick.px >= budget) continue;   // 이 예산으론 못 삼 → 다음 후보
      // ★ 주문 직전 현재가 재조회 (2026-07-29 진단으로 발견한 결함 수정)
      //   pick.px는 신호스캔이 그 종목을 훑던 시점의 가격이다. uni420 스캔이 최소 44초(420×105ms rateSlot),
      //   메인루프 30초 폴링까지 겹치면 **1~2분 낡는다**. 여기에 limitBuyPx가 +0.5%를 더 얹으므로
      //   폭락장에선 지정가가 실시간 시장가보다 1%+ 위로 나가고, 크로싱 지정가라 그대로 체결된다.
      //   실측(07-29 매수 11건): 진입가가 직전 30분 구간의 **63% 지점**(무작위 시점 28%),
      //   카카오·한국항공우주는 구간 고점을 넘긴 150%·136%. 진입 후 +10분 -0.88% vs 무작위 -0.45%.
      let livePx = pick.px;
      try {
        const pm = await getPricesMap([pick.code]);          // Map(symbol → {price, timestamp})
        const fresh = Number(pm?.get?.(pick.code)?.price ?? 0);
        if (fresh > 0) {
          if (Math.abs(fresh / pick.px - 1) > 0.003) log(`가격 갱신 ${pick.name}(${pick.code}) 스캔 ${pick.px.toLocaleString()} → 현재 ${fresh.toLocaleString()} (${((fresh / pick.px - 1) * 100).toFixed(2)}%)`);
          livePx = fresh;
        }
      } catch (e) { log(`현재가 재조회 실패(스캔가 사용) ${pick.code}: ${String(e.message).slice(0, 50)}`); }
      if (livePx >= budget) continue;     // 갱신가로 예산 재확인
      const lpx = limitBuyPx(livePx);
      const qty = Math.floor(budget * 0.999 / lpx);
      if (qty < 1) continue;
      try {
        const o = await createOrder(seq, { symbol: pick.code, side: 'BUY', orderType: 'LIMIT', price: String(lpx), quantity: String(qty) });
        const filled = await settleOrder(o?.orderId ?? o?.id, pick.code, 'BUY', 0, `매수 ${pick.code}`);
        if (filled) {
          // 트레일 고점·진입가는 **실제 주문가(lpx)** 기준. 낡은 스캔가(pick.px)를 쓰면 트레일선이 어긋난다.
          state.meta[pick.code] = { hi: lpx, entry: lpx, sub: pick.sub, boughtAt: now() };
          if (state.orderErr) delete state.orderErr[pick.code];   // 체결됐으면 거부 카운트 초기화
          const size = strong ? `집중 ${Math.round(CONVICTION_SIZING.strongFraction * 100)}%몰빵` : `분산 1/${remainingSlots}`;
          log(`매수 ${pick.name}(${pick.code}) ${qty}주 @${lpx.toLocaleString()} [${pick.sub}, 레짐 ${regime}, 확신도 ${pick.conviction.toFixed(1)}, ${size}${pick.rsi2 != null ? ', RSI2 ' + pick.rsi2.toFixed(1) : ', 돌파 ' + pick.breakout?.toFixed(1) + '%'}]`);
          recordTrade({ ts: now(), code: pick.code, name: pick.name, side: 'BUY', px: lpx, qty, sub: pick.sub, regime, conviction: Number(pick.conviction.toFixed(1)), sizing: strong ? 'concentrate' : 'diversify' });
          // signalCache는 더 이상 여기서 비우지 않음(2026-07-24) — signalScanLoop가 독립적으로 계속 갱신하므로
          // 비우면 다음 백그라운드 스캔 완료까지 후보가 빈 채로 대기하게 돼 불필요하게 매수 기회를 놓침.
          writeFileSync(STATE, JSON.stringify(state, null, 1));
        }
      } catch (e) {
        // ★ 오류 전문 300자 (2026-07-29). 기존 80자는 토스 422 본문의 code 필드가 잘려
        //   07-28 프리마켓 거부 31회의 사유를 사후에 특정할 수 없었다(`"code":"mark` 까지만 남음).
        const msg = String(e.message).slice(0, 300);
        // 4xx = 거래소/서버가 이 주문을 확정 거부한 것 → 재시도로 뚫리지 않으므로 카운트.
        // 5xx·타임아웃은 일시장애라 카운트하지 않는다(멀쩡한 종목을 당일 제외하면 손해).
        const definitive = /:\s*4\d\d\s/.test(msg);
        let n = 0;
        if (definitive) {
          const rec = (state.orderErr ??= {})[pick.code] ??= { n: 0, day: today };
          rec.day = today; rec.n++; rec.msg = msg.slice(0, 120); n = rec.n;
          writeFileSync(STATE, JSON.stringify(state, null, 1));
        }
        log(`매수 오류 ${pick.name}(${pick.code})${definitive ? ` 확정거부 ${n}/${ORDER_ERR_MAX}회` : ' 일시장애(카운트 제외)'}: ${msg}`);
        if (definitive && n >= ORDER_ERR_MAX) log(`  → ${pick.name}(${pick.code}) 당일 진입 제외 — 연속 확정거부 ${n}회`);
      }
      break;  // 사이클당 진입 1건 (나머지 슬롯은 다음 폴에서 잔여현금 재계산 후 평가)
    }
  } else if (marketOpen()) {
    logGate(`진입보류: 슬롯 ${bigCount}/${LIVE_SLOTS} · 현금 ${Math.round(cash / 10000).toLocaleString()}만(슬롯예산 ${Math.round(perSlot / 10000).toLocaleString()}만)${bear && !FORECAST_GUARD.shadow ? ' · 하락경보' : ''}`,
      `blocked|${bigCount}|${cash >= perSlot * CAPITAL_DEPLOY.minFillFraction ? 'cash' : 'nocash'}`);
  }
  await new Promise(r => setTimeout(r, POLL_MS));
}
