#!/usr/bin/env node
/**
 * backtest-crypto.mjs — 업비트 KRW 초단타 전략 비교 (5분봉 기본, 24/7 연속)
 *   스펙: docs/superpowers/specs/2026-07-17-krxdata-crypto-scalping-design.md
 *
 *   체결: 시그널 = 봉 종가 판정 → 다음 봉 시가 진입 + 슬리피지. 손절·목표 동시충족 봉은 손절 우선(보수).
 *   비용: 수수료 FEE_BPS/편도 + 슬리피지 SLIP_BPS/편도 (기본 5+5bp = 왕복 0.2%).
 *   유니버스: 고정 6종 (현재 시점 선택 → 잔존 선택편향 존재, 리포트에 명시).
 *
 * 실행:
 *   node backtest-crypto.mjs --from 20250101 --to 20251231                # train
 *   node backtest-crypto.mjs --from 20260101 --to 20260716 --strategies bb-revert
 */
import { existsSync, createReadStream, appendFileSync } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getMinuteCandles } from './upbit-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const FROM = argOf('--from', '20250101');
const TO = argOf('--to', '20260716');
const UNIT = Number(argOf('--unit', 5));
const CAPITAL = Number(argOf('--capital', 10_000_000));
const FEE_BPS = Number(argOf('--feebps', 5));
const SLIP_BPS = Number(argOf('--slipbps', 5));
const SLOTS = Number(argOf('--slots', 3));
const ONLY = argOf('--strategies', '').split(',').filter(Boolean);
const UNIVERSE = argOf('--markets', 'KRW-BTC,KRW-ETH,KRW-XRP,KRW-SOL,KRW-DOGE,KRW-ADA').split(',');
const CACHE = join(__dirname, `candles-crypto-${UNIT}m.jsonl`);
const MIN_ORDER = 5_000; // 업비트 최소 주문금액

const STRATEGIES = {
  // 24봉(2h) 신고가 돌파 + 거래량 확인 — 모멘텀 버스트
  'mom-burst':  { lookback: 24, volMult: 2, volAvg: 20, stopPct: 1.0, tpR: 2, trailPct: 1.0, maxHold: 48 },
  // RSI(2) 과매도 + 추세필터(MA200 위) — 평균회귀 (주식 rsi2 이식)
  'rsi2-mr':    { rsiMax: 10, trendMA: 200, exitMA: 5, stopPct: 1.0, maxHold: 36 },
  // 하단밴드 arm→confirm + friction gate — 주식 인트라데이 bbRevert 이식 (gate 0.3% = 왕복마찰 1.5배)
  'bb-revert':  { bbWindow: 40, bbK: 2.0, armExpiry: 5, minTargetPct: 0.3, slopeLookback: 10, stopPct: 0.8, trailPct: 0.8 },
  // 밴드폭 스퀴즈(직전봉 기준) + 상단 돌파 — 주식 인트라데이 bbSqueeze 이식
  'bb-squeeze': { bbWindow: 20, bbK: 2.0, sqzLookback: 60, sqzQuantile: 0.2, volMult: 2, minVolPct: 0.05, stopPct: 1.0, tpR: 2, trailPct: 1.0, maxHold: 48 },
};
const ACTIVE = Object.entries(STRATEGIES).filter(([k]) => !ONLY.length || ONLY.includes(k));

const dayOf = (ts) => ts.slice(0, 10).replace(/-/g, ''); // '2026-07-17T09:00:00' → '20260717'
const slipBuy = (p) => p * (1 + SLIP_BPS / 10_000);
const slipSell = (p) => p * (1 - SLIP_BPS / 10_000);
function netPnl(entry, exit, qty) {
  const gross = (exit - entry) * qty;
  const fees = (entry + exit) * qty * (FEE_BPS / 10_000);
  return gross - fees;
}
const grossPnl = (entry, exit, qty) => (exit - entry) * qty;

// ── 데이터: 디스크 캐시 우선, 누락 마켓만 API ─────────────────
// 레코드: { market, unit, d:[kst iso 오름차순], o,h,l,c,v:[...] }
const pool = new Map();
async function loadPool() {
  if (existsSync(CACHE)) {
    const rl = createInterface({ input: createReadStream(CACHE), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.unit === UNIT) pool.set(r.market, r); } catch {}
    }
    console.log(`캐시 로드: ${pool.size}마켓 (${CACHE})`);
  }
  const fromIso = `${FROM.slice(0, 4)}-${FROM.slice(4, 6)}-${FROM.slice(6, 8)}`;
  const toIso = `${TO.slice(0, 4)}-${TO.slice(4, 6)}-${TO.slice(6, 8)}`;
  for (const market of UNIVERSE) {
    const cached = pool.get(market);
    if (cached && cached.d[0] <= `${fromIso}T00:10:00` && cached.d[cached.d.length - 1] >= `${toIso}T23:00:00`) continue;
    const days = Math.ceil((new Date(toIso) - new Date(fromIso)) / 86_400_000) + 2;
    const total = Math.ceil(days * (1_440 / UNIT) * 1.05);
    console.log(`${market} ${UNIT}분봉 수집 ~${total.toLocaleString()}봉 (~${Math.round(total / 200 * 0.125 / 60 * 10) / 10}분)...`);
    const list = (await getMinuteCandles(market, UNIT, total, `${toIso}T23:59:59+09:00`)).reverse(); // 오름차순
    const rec = {
      market, unit: UNIT,
      d: list.map(b => b.timestamp),
      o: list.map(b => b.open), h: list.map(b => b.high),
      l: list.map(b => b.low), c: list.map(b => b.close), v: list.map(b => b.volume),
    };
    pool.set(market, rec);
    appendFileSync(CACHE, JSON.stringify(rec) + '\n');
  }
  // 범위 슬라이스 + 인덱스
  for (const [market, r] of pool) {
    if (!UNIVERSE.includes(market)) { pool.delete(market); continue; }
    let s = r.d.findIndex(t => dayOf(t) >= FROM);
    let e = r.d.length - 1;
    while (e >= 0 && dayOf(r.d[e]) > TO) e--;
    if (s < 0 || e < s) { console.log(`${market}: 범위 내 데이터 없음 — 제외`); pool.delete(market); continue; }
    // 룩백 웜업용으로 앞 300봉 여유 포함
    const w = Math.max(0, s - 300);
    const cut = (arr) => arr.slice(w, e + 1);
    const rec = { market, d: cut(r.d), o: cut(r.o), h: cut(r.h), l: cut(r.l), c: cut(r.c), v: cut(r.v), simStart: s - w };
    rec.byTs = new Map(rec.d.map((t, i) => [t, i]));
    pool.set(market, rec);
    console.log(`${market}: ${rec.d.length.toLocaleString()}봉 (${rec.d[rec.simStart]} ~ ${rec.d[rec.d.length - 1]})`);
  }
}

// ── 지표 (인덱스 i까지의 데이터만 사용 — PIT) ──────────────────
function sma(c, i, n) {
  if (i < n - 1) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += c[j];
  return s / n;
}
function rsi2(c, i) {
  if (i < 2) return 50;
  let up = 0, dn = 0;
  for (let j = i - 1; j <= i; j++) {
    const ch = c[j] - c[j - 1];
    if (ch > 0) up += ch; else dn -= ch;
  }
  return up + dn === 0 ? 50 : (up / (up + dn)) * 100;
}
function bb(c, i, n, k) {
  if (i < n - 1) return null;
  let s = 0, sq = 0;
  for (let j = i - n + 1; j <= i; j++) { s += c[j]; sq += c[j] * c[j]; }
  const m = s / n;
  const sd = Math.sqrt(Math.max(0, sq / n - m * m));
  return { mid: m, sd, upper: m + k * sd, lower: m - k * sd };
}

// ── 시뮬레이션 ─────────────────────────────────────────────────
await loadPool();
const clock = pool.get('KRW-BTC');
if (!clock) { console.error('KRW-BTC 데이터 없음 — 중단'); process.exit(1); }
const timeline = clock.d.slice(clock.simStart);
console.log(`\n=== 코인 초단타 백테스트 ${FROM}~${TO} | ${UNIT}분봉 ${timeline.length.toLocaleString()}봉 | 자본 ${CAPITAL.toLocaleString()}원 | 왕복비용 ${(FEE_BPS * 2 + SLIP_BPS * 2) / 100}% | ${ACTIVE.map(([k]) => k).join(', ')} ===`);

const books = Object.fromEntries(ACTIVE.map(([k]) => [k, {
  cash: CAPITAL, positions: {}, trades: [], pending: {}, peak: CAPITAL, maxDD: 0, monthly: new Map(), lastEq: CAPITAL,
  ctx: Object.fromEntries(UNIVERSE.map(m => [m, { armed: null, bwHist: [] }])),
}]));

function equity(book) {
  let eq = book.cash;
  for (const [m, p] of Object.entries(book.positions)) {
    const cd = pool.get(m);
    eq += (p.lastClose ?? p.entry) * p.qty;
  }
  return eq;
}
function closePos(book, strat, market, fill, reason, ts, qtyArg) {
  const p = book.positions[market];
  if (!p) return;
  const qty = qtyArg ?? p.qty;
  const pnl = netPnl(p.entry, fill, qty);
  book.cash += fill * qty * (1 - FEE_BPS / 10_000);
  book.trades.push({ ts, market, entry: p.entry, exit: fill, qty, pnl, gross: grossPnl(p.entry, fill, qty), hold: p.bars, reason });
  p.qty -= qty;
  if (p.qty * fill < MIN_ORDER) { // 잔량이 최소주문 미만이면 전량 처리로 간주
    if (p.qty > 0) book.cash += fill * p.qty * (1 - FEE_BPS / 10_000);
    delete book.positions[market];
  }
}

let lastDay = '';
for (let t = 0; t < timeline.length; t++) {
  const ts = timeline[t];
  const day = dayOf(ts);
  for (const [k, cfg] of ACTIVE) {
    const book = books[k];
    for (const market of UNIVERSE) {
      const cd = pool.get(market);
      if (!cd) continue;
      const i = cd.byTs.get(ts);
      if (i == null || i < 1) continue;
      const o = cd.o[i], h = cd.h[i], l = cd.l[i], c = cd.c[i];
      const ctx = book.ctx[market];

      // ① 전 봉 시그널 집행 (진입은 이번 봉 시가)
      const pend = book.pending[market];
      if (pend) {
        delete book.pending[market];
        if (!book.positions[market] && Object.keys(book.positions).length < SLOTS) {
          const budget = Math.floor(equity(book) / SLOTS);
          const fill = slipBuy(o);
          const qty = budget / fill;
          if (budget >= MIN_ORDER && qty > 0) {
            book.cash -= fill * qty * (1 + FEE_BPS / 10_000);
            book.positions[market] = { qty, entry: fill, stop: pend.stop ?? fill * (1 - cfg.stopPct / 100), target: pend.target, r: fill - (pend.stop ?? fill * (1 - cfg.stopPct / 100)), hi: fill, bars: 0, halfDone: false, sub: pend.sub };
          }
        }
      }

      // ② 보유 관리
      const p = book.positions[market];
      if (p) {
        p.bars++; p.lastClose = c;
        if (p.exitNext) { closePos(book, k, market, slipSell(o), p.exitNext, ts); continue; }
        // 손절 우선 (보수적)
        if (l <= p.stop) { closePos(book, k, market, slipSell(Math.min(p.stop, o)), p.halfDone ? 'be_stop' : 'stop_loss', ts); continue; }
        // 절반익절 (target 도달)
        if (!p.halfDone && p.target && h >= p.target) {
          closePos(book, k, market, slipSell(p.target), 'half_exit', ts, p.qty / 2);
          const pp = book.positions[market];
          if (pp) { pp.halfDone = true; pp.stop = pp.entry; } // BE 이동
        }
        const p2 = book.positions[market];
        if (p2) {
          p2.hi = Math.max(p2.hi, h);
          if (p2.halfDone && cfg.trailPct && c <= p2.hi * (1 - cfg.trailPct / 100)) { closePos(book, k, market, slipSell(c), 'trailing', ts); continue; }
          if (k === 'rsi2-mr') {
            const ma = sma(cd.c, i, cfg.exitMA);
            if (ma != null && c > ma) { p2.exitNext = 'ma_exit'; continue; }
          }
          if (cfg.maxHold && p2.bars >= cfg.maxHold) p2.exitNext = 'max_hold';
        }
        continue;
      }

      // ③ 진입 시그널 (봉 종가 판정 → pending)
      if (Object.keys(book.positions).length >= SLOTS || book.pending[market]) continue;
      if (k === 'mom-burst') {
        if (i < cfg.lookback + 1) continue;
        let hh = 0;
        for (let j = i - cfg.lookback; j < i; j++) hh = Math.max(hh, cd.h[j]);
        let av = 0;
        for (let j = i - cfg.volAvg; j < i; j++) av += cd.v[j];
        av /= cfg.volAvg;
        if (c > hh && cd.v[i] > av * cfg.volMult) {
          const stop = c * (1 - cfg.stopPct / 100);
          book.pending[market] = { sub: 'mom', stop, target: c + (c - stop) * cfg.tpR };
        }
      } else if (k === 'rsi2-mr') {
        const ma200 = sma(cd.c, i, cfg.trendMA);
        if (ma200 == null || c <= ma200) continue;
        if (rsi2(cd.c, i) < cfg.rsiMax) book.pending[market] = { sub: 'rsi2' };
      } else if (k === 'bb-revert') {
        const b = bb(cd.c, i, cfg.bbWindow, cfg.bbK);
        if (!b) continue;
        if (!ctx.armed) {
          if (l <= b.lower && c < b.mid) ctx.armed = { low: l, expires: i + cfg.armExpiry };
        } else {
          if (l < ctx.armed.low) { ctx.armed.low = l; ctx.armed.expires = i + cfg.armExpiry; }
          if (i > ctx.armed.expires) ctx.armed = null;
        }
        if (ctx.armed && c > b.lower && c > o && c > cd.c[i - 1]) {
          const maPrev = sma(cd.c, i - cfg.slopeLookback, cfg.bbWindow);
          const slopeOk = maPrev == null || b.mid >= maPrev;
          const targetPct = ((b.mid - c) / c) * 100;
          if (slopeOk && targetPct >= cfg.minTargetPct) {
            book.pending[market] = { sub: 'bbr', stop: Math.min(ctx.armed.low, b.lower - 0.25 * b.sd), target: b.mid };
            ctx.armed = null;
          }
        }
      } else if (k === 'bb-squeeze') {
        const bPrev = bb(cd.c, i - 1, cfg.bbWindow, cfg.bbK);
        if (!bPrev || bPrev.mid <= 0) continue;
        const bwPrev = (bPrev.upper - bPrev.lower) / bPrev.mid;
        ctx.bwHist.push(bwPrev);
        if (ctx.bwHist.length > cfg.sqzLookback) ctx.bwHist.shift();
        if (ctx.bwHist.length < cfg.sqzLookback * 0.8) continue;
        const sorted = [...ctx.bwHist].sort((a, b2) => a - b2);
        const thr = sorted[Math.floor(sorted.length * cfg.sqzQuantile)];
        let av = 0;
        for (let j = Math.max(0, i - 20); j < i; j++) av += cd.v[j];
        av /= Math.min(20, i);
        const volOk = cd.v[i] > av * cfg.volMult;
        const minVolOk = (bPrev.sd / bPrev.mid) * 100 >= cfg.minVolPct;
        if (bwPrev <= thr && c > bPrev.upper && volOk && minVolOk) {
          const stop = Math.max(bPrev.mid, c * (1 - cfg.stopPct / 100));
          if (stop < c) book.pending[market] = { sub: 'sqz', stop, target: c + (c - stop) * cfg.tpR };
        }
      }
    }

    // ④ 자산 추적 (일 단위 샘플)
    if (day !== lastDay) {
      const eq = equity(book);
      book.peak = Math.max(book.peak, eq);
      book.maxDD = Math.max(book.maxDD, (book.peak - eq) / book.peak * 100);
      const mon = day.slice(0, 6);
      if (!book.monthly.has(mon)) book.monthly.set(mon, { start: book.lastEq, end: eq });
      book.monthly.get(mon).end = eq;
      book.lastEq = eq;
    }
  }
  if (day !== lastDay) lastDay = day;
}

// 잔여 포지션 청산 (기간 말 종가)
for (const [k] of ACTIVE) {
  const book = books[k];
  for (const market of Object.keys(book.positions)) {
    const cd = pool.get(market);
    closePos(book, k, market, slipSell(cd.c[cd.c.length - 1]), 'eov', timeline[timeline.length - 1]);
  }
}

// ── 요약 ─────────────────────────────────────────────────────
const days = new Set(timeline.map(dayOf)).size;
console.log(`\n=== 결과 (${FROM}~${TO}, ${days}일) ===`);
console.log('전략         체결    승률   PF     순손익        MDD    월승률   평균보유    최종자본');
console.log('─'.repeat(100));
for (const [k] of ACTIVE) {
  const b = books[k];
  const wins = b.trades.filter(t => t.pnl > 0);
  const losses = b.trades.filter(t => t.pnl <= 0);
  const grossW = wins.reduce((s, t) => s + t.pnl, 0);
  const grossL = -losses.reduce((s, t) => s + t.pnl, 0);
  const pf = grossL > 0 ? (grossW / grossL).toFixed(2) : '∞';
  const months = [...b.monthly.values()];
  const monWin = months.length ? Math.round(months.filter(m => m.end > m.start).length / months.length * 100) : 0;
  const pnlSum = b.cash - CAPITAL;
  const avgHold = b.trades.length ? (b.trades.reduce((s, t) => s + t.hold, 0) / b.trades.length * UNIT / 60).toFixed(1) : '-';
  console.log(`${k.padEnd(12)} ${String(b.trades.length).padStart(4)}  ${String(b.trades.length ? Math.round(wins.length / b.trades.length * 100) : 0).padStart(4)}%  ${String(pf).padStart(5)}  ${(pnlSum >= 0 ? '+' : '') + Math.round(pnlSum).toLocaleString().padStart(11)}원  ${b.maxDD.toFixed(1).padStart(5)}%  ${String(monWin).padStart(4)}%  ${String(avgHold).padStart(6)}시간  ${Math.round(b.cash).toLocaleString()}원`);
}
console.log('\n손익 분해 (gross=비용 전, net=비용 반영, %/건 = 슬롯예산 대비):');
const perBudget = CAPITAL / SLOTS;
for (const [k] of ACTIVE) {
  const b = books[k];
  const n = b.trades.length;
  const grossSum = b.trades.reduce((s, t) => s + t.gross, 0);
  const netSum = b.trades.reduce((s, t) => s + t.pnl, 0);
  console.log(`EXPECTANCY ${k.padEnd(12)} gross=${Math.round(grossSum).toLocaleString()}원(${n ? (grossSum / n / perBudget * 100).toFixed(3) : 0}%/건) net=${Math.round(netSum).toLocaleString()}원(${n ? (netSum / n / perBudget * 100).toFixed(3) : 0}%/건) n=${n}`);
}
console.log(`\nKill 기준(사전등록): train gross<=0 OR net<+0.05%/건 → 폐기 | 채택: valid net>=+0.05% AND PF>=1.2 AND n>=100 AND 월승률>=50%`);
console.log(`유니버스: ${UNIVERSE.join(',')} (현재 시점 선택 — 잔존 선택편향 존재)`);
