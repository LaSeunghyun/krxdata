#!/usr/bin/env node
/**
 * backtest-crypto-swing.mjs — 코인 스윙(일봉) 조건 검증: 전 KRW 마켓, 다년 train/valid
 *   전략: hi-break(신고가 돌파) / dip-mr(MA200 위 과매도 반등) / mom-rot(주간 상대모멘텀)
 *   레짐: BTC 종가 > MA50(일) 아니면 신규진입 금지(현금 대기) — --regime 0으로 해제
 *   비용: 수수료 5bp + 슬리피지 10bp per side (보수) | 유동성: 20일 평균 거래대금 10억+ (PIT)
 *   사전 기각(등록): train PF<=1.0 OR 총손익<=0 → 폐기 | 채택: valid PF>=1.2 AND 총수익>0 AND 월승률>=50%
 *   한계(명시): 상폐 코인 누락(생존편향, 유리 왜곡) / 유의종목 이력 미반영 / 체결=익일 시가+슬리피지
 *
 * 실행: node backtest-crypto-swing.mjs --from 20210101 --to 20241231 [--regime 1] [--strategies hi-break]
 */
import { existsSync, createReadStream, appendFileSync } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getKrwMarkets, getDailyCandles } from './upbit-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const FROM = argOf('--from', '20210101');
const TO = argOf('--to', '20241231');
const CAPITAL = Number(argOf('--capital', 10_000_000));
const FEE_BPS = 5, SLIP_BPS = Number(argOf('--slipbps', 10));
const SLOTS = Number(argOf('--slots', 10));
const REGIME = Number(argOf('--regime', 1));
const ONLY = argOf('--strategies', '').split(',').filter(Boolean);
const MIN_TURNOVER = Number(argOf('--minturn', 1e9)); // 20일 평균 거래대금 하한
const CACHE = join(__dirname, 'candles-crypto-daily.jsonl');
const DEPTH = 1_700; // ~2021-01 커버

const STRATEGIES = {
  // 주식 hi120 이식: N일 신고가 돌파 + 최소 돌파폭, 트레일링 청산 (코인 변동성 반영해 트레일 15%)
  'hi-break': { lookback: 60, minBreakout: 3, trailPct: 15, maxHold: 60, stopPct: 12 },
  // 주식 rsi2 이식: 장기 상승추세(MA200 위) + RSI2 과매도 → MA5 회귀 익절
  'dip-mr':   { rsiMax: 10, trendMA: 200, exitMA: 5, stopPct: 10, maxHold: 10 },
};
const ACTIVE = Object.entries(STRATEGIES).filter(([k]) => !ONLY.length || ONLY.includes(k));
const RUN_ROT = !ONLY.length || ONLY.includes('mom-rot');

const dayOf = (ts) => ts.slice(0, 10).replace(/-/g, '');
const slipBuy = (p) => p * (1 + SLIP_BPS / 10_000);
const slipSell = (p) => p * (1 - SLIP_BPS / 10_000);

// ── 데이터: 전 KRW 마켓 일봉 (디스크 캐시) ───────────────────────
const pool = new Map();
async function loadPool() {
  if (existsSync(CACHE)) {
    const rl = createInterface({ input: createReadStream(CACHE), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); pool.set(r.market, r); } catch {}
    }
    console.log(`캐시 로드: ${pool.size}마켓`);
  }
  const markets = await getKrwMarkets();
  const missing = markets.filter(m => !pool.has(m.market));
  if (missing.length) {
    console.log(`일봉 수집 ${missing.length}마켓 (~${Math.round(missing.length * 9 * 0.125 / 60)}분)...`);
    let done = 0;
    for (const m of missing) {
      try {
        const list = (await getDailyCandles(m.market, DEPTH)).reverse();
        const rec = {
          market: m.market, name: m.korean_name,
          d: list.map(b => b.timestamp), o: list.map(b => b.open), h: list.map(b => b.high),
          l: list.map(b => b.low), c: list.map(b => b.close), v: list.map(b => b.volume), q: list.map(b => b.turnover),
        };
        pool.set(m.market, rec);
        appendFileSync(CACHE, JSON.stringify(rec) + '\n');
      } catch { /* skip */ }
      if (++done % 50 === 0) console.log(`  ${done}/${missing.length}`);
    }
  }
  for (const [market, r] of pool) {
    r.byTs = new Map(r.d.map((t, i) => [t, i]));
  }
}
await loadPool();
const btc = pool.get('KRW-BTC');
const timeline = btc.d.filter(t => dayOf(t) >= FROM && dayOf(t) <= TO);
const bhStart = btc.c[btc.byTs.get(timeline[0])], bhEnd = btc.c[btc.byTs.get(timeline[timeline.length - 1])];
console.log(`\n=== 코인 스윙 검증 ${FROM}~${TO} | ${timeline.length}일 | ${pool.size}마켓 | 레짐게이트 ${REGIME ? 'ON(BTC>MA50)' : 'OFF'} | RT비용 ${(FEE_BPS + SLIP_BPS) * 2 / 100}% | BTC B&H ${((bhEnd / bhStart - 1) * 100).toFixed(1)}% ===`);

// ── 지표 ─────────────────────────────────────────────────────
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
function avgTurn20(cd, i) {
  if (i < 20) return 0;
  let s = 0;
  for (let j = i - 19; j <= i; j++) s += cd.q[j] ?? cd.c[j] * cd.v[j];
  return s / 20;
}
const btcRegimeOk = (ts) => {
  if (!REGIME) return true;
  const i = btc.byTs.get(ts);
  const ma = i != null ? sma(btc.c, i, 50) : null;
  return ma != null && btc.c[i] > ma;
};

// ── 슬롯형 시뮬 (hi-break / dip-mr) ─────────────────────────────
const books = Object.fromEntries(ACTIVE.map(([k]) => [k, { cash: CAPITAL, positions: {}, trades: [], pending: {}, peak: CAPITAL, maxDD: 0, monthly: new Map(), lastEq: CAPITAL }]));
function equity(book) {
  let eq = book.cash;
  for (const p of Object.values(book.positions)) eq += (p.lastClose ?? p.entry) * p.qty;
  return eq;
}
function closePos(book, market, fill, reason, ts) {
  const p = book.positions[market];
  if (!p) return;
  const gross = (fill - p.entry) * p.qty;
  const pnl = gross - (p.entry + fill) * p.qty * (FEE_BPS / 10_000);
  book.cash += fill * p.qty * (1 - FEE_BPS / 10_000);
  book.trades.push({ ts, market, pnl, gross, hold: p.days, reason });
  delete book.positions[market];
}

for (let t = 0; t < timeline.length; t++) {
  const ts = timeline[t];
  const day = dayOf(ts);
  for (const [k, cfg] of ACTIVE) {
    const book = books[k];
    for (const [market, cd] of pool) {
      const i = cd.byTs.get(ts);
      if (i == null || i < 1) continue;
      const o = cd.o[i], c = cd.c[i];
      // 전일 시그널 익일 시가 집행
      if (book.pending[market]) {
        delete book.pending[market];
        if (!book.positions[market] && Object.keys(book.positions).length < SLOTS) {
          const budget = Math.floor(equity(book) / SLOTS);
          const fill = slipBuy(o);
          const qty = budget / fill;
          if (budget >= 5_000 && qty > 0) {
            book.cash -= fill * qty * (1 + FEE_BPS / 10_000);
            book.positions[market] = { qty, entry: fill, hi: fill, days: 0, lastClose: c };
          }
        }
      }
      const p = book.positions[market];
      if (p) {
        p.days++; p.lastClose = c; p.hi = Math.max(p.hi, cd.h[i]);
        if (p.exitNext) { closePos(book, market, slipSell(o), p.exitNext, ts); continue; }
        if (k === 'hi-break') {
          if (c <= p.entry * (1 - cfg.stopPct / 100)) p.exitNext = 'stop_loss';
          else if (c <= p.hi * (1 - cfg.trailPct / 100)) p.exitNext = 'trailing';
          else if (p.days >= cfg.maxHold) p.exitNext = 'max_hold';
        } else {
          const ma = sma(cd.c, i, cfg.exitMA);
          if (c <= p.entry * (1 - cfg.stopPct / 100)) p.exitNext = 'stop_loss';
          else if (ma != null && c > ma) p.exitNext = 'ma_exit';
          else if (p.days >= cfg.maxHold) p.exitNext = 'max_hold';
        }
        continue;
      }
      // 진입 스크리닝 (종가 판정 → 익일 시가)
      if (!btcRegimeOk(ts) || Object.keys(book.positions).length >= SLOTS || book.pending[market]) continue;
      if (avgTurn20(cd, i) < MIN_TURNOVER || c < 1) continue;
      if (k === 'hi-break') {
        if (i < cfg.lookback + 1) continue;
        let hh = 0;
        for (let j = i - cfg.lookback; j < i; j++) hh = Math.max(hh, cd.h[j]);
        const brk = (c / hh - 1) * 100;
        if (c > hh && brk >= cfg.minBreakout) book.pending[market] = true;
      } else {
        const ma200 = sma(cd.c, i, cfg.trendMA);
        if (ma200 != null && c > ma200 && rsi2(cd.c, i) < cfg.rsiMax) book.pending[market] = true;
      }
    }
    const eq = equity(book);
    book.peak = Math.max(book.peak, eq);
    book.maxDD = Math.max(book.maxDD, (book.peak - eq) / book.peak * 100);
    const mon = day.slice(0, 6);
    if (!book.monthly.has(mon)) book.monthly.set(mon, { start: book.lastEq, end: eq });
    book.monthly.get(mon).end = eq;
    book.lastEq = eq;
  }
}
for (const [k] of ACTIVE) {
  const book = books[k];
  const lastTs = timeline[timeline.length - 1];
  for (const market of Object.keys(book.positions)) {
    const cd = pool.get(market);
    const i = cd.byTs.get(lastTs);
    closePos(book, market, slipSell(i != null ? cd.c[i] : book.positions[market].lastClose), 'eov', lastTs);
  }
}

// ── mom-rot: 주간 상대모멘텀 top-5 (양수 모멘텀만, 없으면 현금) ────
function runMomRot({ lookback = 90, topN = 5, rebalDays = 7 } = {}) {
  let cash = CAPITAL;
  const held = new Map(); // market → qty
  let peak = CAPITAL, maxDD = 0, switches = 0;
  const monthly = new Map();
  let lastEq = CAPITAL;
  for (let t = 0; t < timeline.length; t++) {
    const ts = timeline[t];
    const eqNow = () => {
      let eq = cash;
      for (const [m, q] of held) { const cd = pool.get(m); const i = cd.byTs.get(ts); if (i != null) eq += cd.c[i] * q; }
      return eq;
    };
    if (t % rebalDays === 0) {
      const cands = [];
      if (!REGIME || btcRegimeOk(ts)) {
        for (const [market, cd] of pool) {
          const i = cd.byTs.get(ts);
          if (i == null || i < lookback + 1) continue;
          if (avgTurn20(cd, i) < MIN_TURNOVER) continue;
          const r = cd.c[i] / cd.c[i - lookback] - 1;
          if (r > 0) cands.push({ market, r });
        }
        cands.sort((a, b) => b.r - a.r);
      }
      const target = new Set(cands.slice(0, topN).map(x => x.market));
      for (const [m, q] of [...held]) {
        if (!target.has(m)) {
          const cd = pool.get(m); const i = cd.byTs.get(ts);
          if (i != null) { cash += slipSell(cd.c[i]) * q * (1 - FEE_BPS / 10_000); held.delete(m); switches++; }
        }
      }
      const newOnes = [...target].filter(m => !held.has(m));
      if (newOnes.length && cash > 5_000) {
        const per = cash / newOnes.length;
        for (const m of newOnes) {
          const cd = pool.get(m); const i = cd.byTs.get(ts);
          if (i == null) continue;
          const fill = slipBuy(cd.c[i]);
          const q = per * (1 - FEE_BPS / 10_000) / fill;
          held.set(m, q); switches++;
        }
        cash = 0;
      }
    }
    const eq = eqNow();
    peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak * 100);
    const mon = dayOf(ts).slice(0, 6);
    if (!monthly.has(mon)) monthly.set(mon, { start: lastEq, end: eq });
    monthly.get(mon).end = eq;
    lastEq = eq;
  }
  const lastTs = timeline[timeline.length - 1];
  for (const [m, q] of held) { const cd = pool.get(m); const i = cd.byTs.get(lastTs); if (i != null) cash += slipSell(cd.c[i]) * q * (1 - FEE_BPS / 10_000); }
  const months = [...monthly.values()];
  const monWin = months.length ? Math.round(months.filter(mm => mm.end > mm.start).length / months.length * 100) : 0;
  return { ret: (cash / CAPITAL - 1) * 100, maxDD, switches, monWin };
}

// ── 요약 ─────────────────────────────────────────────────────
const years = timeline.length / 365;
console.log('\n전략        체결   승률   PF     총수익     CAGR     MDD    월승률  평균보유');
console.log('─'.repeat(95));
for (const [k] of ACTIVE) {
  const b = books[k];
  const wins = b.trades.filter(t => t.pnl > 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = -b.trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  const months = [...b.monthly.values()];
  const monWin = months.length ? Math.round(months.filter(m => m.end > m.start).length / months.length * 100) : 0;
  const ret = (b.cash / CAPITAL - 1) * 100;
  const cagr = (Math.pow(Math.max(0.0001, b.cash / CAPITAL), 1 / years) - 1) * 100;
  const avgHold = b.trades.length ? (b.trades.reduce((s, t) => s + t.hold, 0) / b.trades.length).toFixed(1) : '-';
  const grossSum = b.trades.reduce((s, t) => s + t.gross, 0);
  console.log(`${k.padEnd(10)} ${String(b.trades.length).padStart(5)}  ${String(b.trades.length ? Math.round(wins.length / b.trades.length * 100) : 0).padStart(4)}%  ${(gl > 0 ? (gw / gl).toFixed(2) : '∞').padStart(5)}  ${ret.toFixed(1).padStart(8)}%  ${cagr.toFixed(1).padStart(6)}%  ${b.maxDD.toFixed(1).padStart(5)}%  ${String(monWin).padStart(4)}%  ${String(avgHold).padStart(5)}일`);
  console.log(`  EXPECTANCY ${k} gross=${Math.round(grossSum).toLocaleString()}원 net합=${Math.round(b.trades.reduce((s, t) => s + t.pnl, 0)).toLocaleString()}원 n=${b.trades.length}`);
}
if (RUN_ROT) {
  const r = runMomRot({});
  console.log(`mom-rot     rebal7d top5 L90  총수익 ${r.ret.toFixed(1)}%  MDD ${r.maxDD.toFixed(1)}%  월승률 ${r.monWin}%  스위치 ${r.switches}`);
}
console.log(`\n기각(사전등록): train PF<=1.0 OR 총손익<=0 | 채택: valid PF>=1.2 AND 총수익>0 AND 월승률>=50% | 생존편향: 상폐 코인 누락(유리 왜곡) 주의`);
