#!/usr/bin/env node
/**
 * trader.js — ORB(시가 범위 돌파) 인트라데이 트레이더 (토스증권 Open API)
 *
 *   기본 = PAPER 모드: 실데이터로 시그널·가상체결·손익을 기록하되 주문은 안 나감.
 *   실주문은 --live 플래그 + 계좌 확인이 모두 충족될 때만.
 *
 * 전략 (1분봉, 당일 청산):
 *   유니버스  전일 거래대금 상위 ∩ 60일 모멘텀 양수 ∩ 가격 2,000원↑ ∩ 경고 없음 (10종목)
 *   진입      09:15~09:30, 1분봉 종가가 09:00~09:15 시가범위(OR) 고가 돌파
 *             + 돌파봉 거래량 > 직전 5봉 평균 ×2
 *   손절      OR 저가 또는 -1.0% 중 가까운 쪽
 *   익절      +2R 도달 시 절반, 나머지 트레일링(직전 5봉 최저가)
 *   타임스탑  14:50 전량 청산 — 오버나이트 금지
 *
 * 가드레일:
 *   일일 손실 -2% 또는 연속 3패 → 신규 진입 정지
 *   매크로 게이트(005930 20MA + 5일 -3%) warn → 미가동
 *   kill switch: 같은 폴더에 trader.stop 파일 생성 시 전량 청산 후 종료
 *
 * 실행:
 *   node trader.js                  # paper (기본)
 *   node trader.js --universe-only  # 유니버스 선정만 출력하고 종료
 *   node trader.js --live           # 실주문 (소액 검증 후에만!)
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import {
  isTossConfigured, getPricesMap, getDailyCandles, getCandles1m,
  getStockWarnings, getKrMarketCalendar, getAccounts, createOrder, getOrder, cancelOrder,
} from './toss-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

// ── 설정 ──────────────────────────────────────────────────────
const LIVE          = process.argv.includes('--live');
const UNIVERSE_ONLY = process.argv.includes('--universe-only');
const CAPITAL       = Number(process.env.TRADER_CAPITAL ?? 10_000_000); // paper 가상 자본(원)
const POSITION_PCT  = 0.12;   // 종목당 자본 비중
const MAX_POSITIONS = 3;
const UNIVERSE_SIZE = 10;
const MIN_PRICE     = 2_000;
const VOL_MULT      = 2;      // 돌파봉 거래량 > 직전 5봉 평균 × N
const STOP_PCT      = 1.0;    // 최대 손절폭 %
const TP_R          = 2;      // 익절 트리거 (R 배수)
const DAILY_LOSS_PCT    = 2.0;
const MAX_CONSEC_LOSSES = 3;
const FEE_BPS  = Number(process.env.TRADER_FEE_BPS ?? 1.5);   // 편도 수수료 0.015%
const TAX_BPS  = Number(process.env.TRADER_TAX_BPS ?? 15);    // 매도 거래세 0.15%
const OR_END    = '09:15';
const ENTRY_END = '09:30';
const FLAT_TIME = '14:50';
const POLL_MS   = 25_000;
const KILL_FILE = join(__dirname, 'trader.stop');

// ── 시간 유틸 (KST) ───────────────────────────────────────────
const kst = () => new Date(Date.now() + 9 * 3600 * 1000);
const kstDate = () => kst().toISOString().slice(0, 10);
const kstHM = () => kst().toISOString().slice(11, 16);
const log = (...a) => console.log(`[${kstHM()}]`, ...a);

// ── KRX 호가단위 ──────────────────────────────────────────────
function tickSize(p) {
  if (p < 2_000) return 1;
  if (p < 5_000) return 5;
  if (p < 20_000) return 10;
  if (p < 50_000) return 50;
  if (p < 200_000) return 100;
  if (p < 500_000) return 500;
  return 1_000;
}
const roundTick = (p) => Math.round(p / tickSize(p)) * tickSize(p);

// ── DB (Supabase Management API — daily-ranking.js와 동일 패턴) ──
async function dbQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(data?.message ?? 'DB 쿼리 오류');
  return data;
}

// ── 상태 영속화 (재시작 시 중복 진입 방지) ─────────────────────
const STATE_FILE = join(__dirname, `trader-state-${kstDate()}.json`);
const TRADES_FILE = join(__dirname, `trades-${LIVE ? 'live' : 'paper'}-${kstDate()}.jsonl`);
function loadState() {
  try { if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch {}
  return { positions: {}, closed: [], realizedPnl: 0, consecLosses: 0, halted: false, entriesDone: [] };
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf-8'); }
function recordTrade(t) { appendFileSync(TRADES_FILE, JSON.stringify({ ts: kst().toISOString(), ...t }) + '\n'); }

// ── 매크로 게이트 (daily-ranking checkMarketRegime와 동일 로직) ──
async function macroGateOk() {
  const today = kstDate();
  const candles = (await getDailyCandles('005930', 22)).filter(c => !String(c.timestamp).startsWith(today));
  if (candles.length < 6) return true; // 판단 불가 시 통과 (보수적으로 막고 싶으면 false)
  const closes = candles.map(c => c.close);
  const ma20 = closes.slice(0, Math.min(20, closes.length)).reduce((s, v) => s + v, 0) / Math.min(20, closes.length);
  const ret5d = ((closes[0] - closes[5]) / closes[5]) * 100;
  const warn = closes[0] < ma20 && ret5d < -3;
  if (warn) log(`매크로 경고 — 005930 ${closes[0].toLocaleString()} < 20MA ${Math.round(ma20).toLocaleString()}, 5일 ${ret5d.toFixed(1)}%`);
  return !warn;
}

// ── 유니버스 선정 (장 전 1회, 파일 캐시) ──────────────────────
async function buildUniverse() {
  const cacheFile = join(__dirname, `universe-${kstDate()}.json`);
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf-8'));

  log('유니버스 선정: 60일 모멘텀 양수 후보 조회...');
  const candidates = await dbQuery(`
    SELECT t.stock_code, sa.corp_name,
           (MAX(CASE WHEN rn = 1 THEN close END)::NUMERIC
            / NULLIF(MAX(CASE WHEN rn = 61 THEN close END), 0) - 1) * 100 AS ret60
    FROM (
      SELECT stock_code, close, ROW_NUMBER() OVER (PARTITION BY stock_code ORDER BY date DESC) AS rn
      FROM stock_prices WHERE date >= TO_CHAR(CURRENT_DATE - 180, 'YYYYMMDD')
    ) t
    JOIN stock_analysis sa ON sa.stock_code = t.stock_code
    WHERE rn IN (1, 61) AND sa.current_price >= ${MIN_PRICE} AND sa.market_cap_tril >= 0.1
    GROUP BY t.stock_code, sa.corp_name
    HAVING (MAX(CASE WHEN rn = 1 THEN close END)::NUMERIC
            / NULLIF(MAX(CASE WHEN rn = 61 THEN close END), 0) - 1) * 100 > 0
    ORDER BY ret60 DESC
    LIMIT 60
  `);
  log(`모멘텀 후보 ${candidates.length}종목 — 전일 거래대금 조회 중...`);

  const scored = [];
  for (const c of candidates) {
    try {
      const [d] = await getDailyCandles(c.stock_code, 1);
      if (!d || !(d.close >= MIN_PRICE)) continue;
      scored.push({ ...c, turnover: d.close * d.volume, prevClose: d.close });
    } catch { /* 미커버 종목 스킵 */ }
  }
  scored.sort((a, b) => b.turnover - a.turnover);

  const universe = [];
  for (const s of scored) {
    if (universe.length >= UNIVERSE_SIZE) break;
    try {
      const warnings = await getStockWarnings(s.stock_code);
      const active = warnings.filter(w => !w.endDate || w.endDate >= kstDate());
      if (active.length) { log(`  제외 ${s.corp_name}(${s.stock_code}): ${active.map(w => w.warningType).join(',')}`); continue; }
    } catch { /* 경고 조회 실패는 통과 */ }
    universe.push({ code: s.stock_code, name: s.corp_name, ret60: Number(s.ret60), turnover: s.turnover, prevClose: s.prevClose });
  }
  writeFileSync(cacheFile, JSON.stringify(universe, null, 2), 'utf-8');
  return universe;
}

// ── 주문 실행 (paper / live 공통 인터페이스) ──────────────────
let ACCOUNT_SEQ = null;
async function execBuy(code, qty, refPrice) {
  if (!LIVE) return { fillPrice: roundTick(refPrice) + tickSize(refPrice), qty }; // paper: +1틱 슬리피지 가정
  const order = await createOrder(ACCOUNT_SEQ, {
    symbol: code, side: 'BUY', orderType: 'LIMIT',
    quantity: String(qty), price: String(roundTick(refPrice) + tickSize(refPrice)),
  });
  return waitFill(order.orderId, qty);
}
async function execSell(code, qty, refPrice, urgent = false) {
  if (!LIVE) return { fillPrice: roundTick(refPrice) - tickSize(refPrice), qty }; // paper: -1틱 슬리피지
  const order = await createOrder(ACCOUNT_SEQ, urgent
    ? { symbol: code, side: 'SELL', orderType: 'MARKET', quantity: String(qty) }
    : { symbol: code, side: 'SELL', orderType: 'LIMIT', quantity: String(qty), price: String(roundTick(refPrice) - tickSize(refPrice)) });
  return waitFill(order.orderId, qty);
}
async function waitFill(orderId, qty, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const o = await getOrder(ACCOUNT_SEQ, orderId);
    if (o?.status === 'FILLED') return { fillPrice: Number(o.filledPrice ?? o.price), qty };
    if (['REJECTED', 'CANCELED'].includes(o?.status)) return null;
    await new Promise(r => setTimeout(r, 3_000));
  }
  try { await cancelOrder(ACCOUNT_SEQ, orderId); } catch {}
  return null; // 미체결 — 호출부에서 재평가
}

// 비용 차감 손익 (수수료 양편 + 매도 거래세)
function netPnl(entry, exit, qty) {
  const gross = (exit - entry) * qty;
  const fees = (entry + exit) * qty * (FEE_BPS / 10_000) + exit * qty * (TAX_BPS / 10_000);
  return Math.round(gross - fees);
}

// ── 메인 엔진 ────────────────────────────────────────────────
async function main() {
  if (!isTossConfigured()) throw new Error('TOSS_CLIENT_ID/SECRET 미설정');
  log(`=== ORB 트레이더 시작 — ${LIVE ? '🔴 LIVE' : '📝 PAPER'} 모드, 자본 ${CAPITAL.toLocaleString()}원 ===`);

  // 휴장 체크
  const cal = await getKrMarketCalendar();
  const todayCal = Array.isArray(cal) ? cal.find(d => d.date === kstDate()) : cal;
  const session = todayCal?.integrated ?? todayCal;
  if (todayCal && !todayCal.integrated && !todayCal.regularMarket) { log('오늘 휴장 — 종료'); return; }

  const universe = await buildUniverse();
  console.table(universe.map(u => ({ 종목: u.name, 코드: u.code, '60일%': u.ret60.toFixed(1), '전일거래대금(억)': Math.round(u.turnover / 1e8) })));
  if (UNIVERSE_ONLY) return;

  if (!(await macroGateOk())) { log('매크로 게이트 발동 — 오늘 미가동'); return; }

  if (LIVE) {
    const accounts = await getAccounts();
    if (!accounts.length) throw new Error('계좌 조회 실패');
    ACCOUNT_SEQ = process.env.TOSS_ACCOUNT_SEQ ?? accounts[0].accountSeq;
    log(`LIVE 계좌: ${accounts[0].accountNo} (seq=${ACCOUNT_SEQ})`);
  }

  const state = loadState();
  const or = {}; // code → { high, low, done }

  // 09:00 이전이면 대기
  while (kstHM() < '09:00') {
    log(`개장 대기 중 (${kstHM()})...`);
    await new Promise(r => setTimeout(r, 60_000));
  }

  log('엔진 가동 — OR 형성 구간');
  while (true) {
    const hm = kstHM();

    // kill switch
    if (existsSync(KILL_FILE)) {
      log('kill switch 감지 — 전량 청산 후 종료');
      await flatAll(state, 'kill_switch');
      unlinkSync(KILL_FILE);
      break;
    }

    // 타임스탑: 전량 청산 후 종료
    if (hm >= FLAT_TIME) {
      await flatAll(state, 'time_stop');
      break;
    }

    try {
      // 보유 포지션 관리 (현재가 1 요청)
      const held = Object.keys(state.positions);
      if (held.length) {
        const prices = await getPricesMap(held);
        for (const code of held) {
          const px = prices.get(code)?.price;
          if (px > 0) await managePosition(state, code, px);
        }
      }

      // 손실 한도 / 연패 가드
      const lossLimit = -CAPITAL * (DAILY_LOSS_PCT / 100);
      if (!state.halted && (state.realizedPnl <= lossLimit || state.consecLosses >= MAX_CONSEC_LOSSES)) {
        state.halted = true;
        log(`⛔ 가드 발동 (손익 ${state.realizedPnl.toLocaleString()}원, 연패 ${state.consecLosses}) — 신규 진입 정지`);
      }

      // OR 형성 + 진입 시그널 (09:30까지만 봉 폴링)
      if (hm < ENTRY_END) {
        for (const u of universe) {
          const bars = (await getCandles1m(u.code, 30)).filter(b => String(b.timestamp).slice(11, 16) < hm); // 완성봉만
          if (!bars.length) continue;
          const orBars = bars.filter(b => String(b.timestamp).slice(11, 16) < OR_END);
          if (orBars.length) {
            or[u.code] = { high: Math.max(...orBars.map(b => b.high)), low: Math.min(...orBars.map(b => b.low)) };
          }
          // 진입: 09:15 이후, OR 확정 + 미보유 + 미진입 이력 + 슬롯 여유 + 가드 미발동
          if (hm >= OR_END && !state.halted && or[u.code]
              && !state.positions[u.code] && !state.entriesDone.includes(u.code)
              && Object.keys(state.positions).length < MAX_POSITIONS) {
            const last = bars[0]; // 최신 완성봉
            const prev5 = bars.slice(1, 6);
            const avgVol = prev5.length ? prev5.reduce((s, b) => s + b.volume, 0) / prev5.length : Infinity;
            if (last.close > or[u.code].high && last.volume > avgVol * VOL_MULT) {
              await enter(state, u, last.close, or[u.code]);
            }
          }
        }
      }
    } catch (e) {
      log(`루프 오류 (계속): ${e.message}`);
    }

    saveState(state);
    if (hm >= ENTRY_END && !Object.keys(state.positions).length) {
      log('진입 구간 종료 + 포지션 없음 — 오늘 마감');
      break;
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }

  // 일일 요약
  const trades = state.closed;
  const wins = trades.filter(t => t.pnl > 0).length;
  log(`=== 마감 — 체결 ${trades.length}건, 승 ${wins}, 패 ${trades.length - wins}, 실현손익 ${state.realizedPnl.toLocaleString()}원 (${(state.realizedPnl / CAPITAL * 100).toFixed(2)}%) ===`);
  saveState(state);
}

async function enter(state, u, breakPrice, orRange) {
  const stopByOr = orRange.low;
  const stopByPct = breakPrice * (1 - STOP_PCT / 100);
  const stop = roundTick(Math.max(stopByOr, stopByPct)); // 가까운(높은) 쪽
  const qty = Math.floor((CAPITAL * POSITION_PCT) / breakPrice);
  if (qty < 1) return;
  const fill = await execBuy(u.code, qty, breakPrice);
  if (!fill) { log(`진입 미체결 — ${u.name} 패스`); state.entriesDone.push(u.code); return; }
  const r = fill.fillPrice - stop;
  state.positions[u.code] = {
    name: u.name, qty: fill.qty, entry: fill.fillPrice, stop,
    target: roundTick(fill.fillPrice + r * TP_R), halfDone: false, highSince: fill.fillPrice,
  };
  state.entriesDone.push(u.code);
  recordTrade({ type: 'entry', code: u.code, name: u.name, qty: fill.qty, price: fill.fillPrice, stop, target: state.positions[u.code].target });
  log(`🟢 진입 ${u.name}(${u.code}) ${fill.qty}주 @${fill.fillPrice.toLocaleString()} | 손절 ${stop.toLocaleString()} 목표 ${state.positions[u.code].target.toLocaleString()}`);
}

async function managePosition(state, code, px) {
  const p = state.positions[code];
  if (!p) return;
  p.highSince = Math.max(p.highSince, px);

  if (px <= p.stop) return closePosition(state, code, px, 'stop_loss', true);

  if (!p.halfDone && px >= p.target) {
    const half = Math.floor(p.qty / 2);
    if (half >= 1) {
      const fill = await execSell(code, half, px);
      if (fill) {
        const pnl = netPnl(p.entry, fill.fillPrice, fill.qty);
        state.realizedPnl += pnl;
        p.qty -= fill.qty;
        p.halfDone = true;
        p.stop = p.entry; // 본전 스톱으로 상향
        recordTrade({ type: 'half_exit', code, qty: fill.qty, price: fill.fillPrice, pnl });
        log(`🟡 절반익절 ${p.name} ${fill.qty}주 @${fill.fillPrice.toLocaleString()} (+${pnl.toLocaleString()}원) — 스톱 본전 이동`);
      }
    } else { p.halfDone = true; }
  }

  // 트레일링: 절반익절 후 고점 대비 -1% 이탈 시 잔량 청산
  if (p.halfDone && px <= p.highSince * 0.99) {
    return closePosition(state, code, px, 'trailing', false);
  }
}

async function closePosition(state, code, px, reason, urgent) {
  const p = state.positions[code];
  if (!p || p.qty < 1) { delete state.positions[code]; return; }
  const fill = await execSell(code, p.qty, px, urgent);
  if (!fill) { log(`청산 미체결 — ${p.name} 다음 루프 재시도`); return; }
  const pnl = netPnl(p.entry, fill.fillPrice, fill.qty);
  state.realizedPnl += pnl;
  state.consecLosses = pnl < 0 ? state.consecLosses + 1 : 0;
  state.closed.push({ code, name: p.name, entry: p.entry, exit: fill.fillPrice, qty: fill.qty, pnl, reason });
  recordTrade({ type: 'exit', code, qty: fill.qty, price: fill.fillPrice, pnl, reason });
  log(`${pnl >= 0 ? '🔵' : '🔴'} 청산 ${p.name} ${fill.qty}주 @${fill.fillPrice.toLocaleString()} (${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}원, ${reason})`);
  delete state.positions[code];
}

async function flatAll(state, reason) {
  for (const code of Object.keys(state.positions)) {
    const prices = await getPricesMap([code]);
    const px = prices.get(code)?.price ?? state.positions[code].entry;
    await closePosition(state, code, px, reason, true);
  }
}

main().catch(e => { console.error('[치명적 오류]', e); process.exit(1); });
