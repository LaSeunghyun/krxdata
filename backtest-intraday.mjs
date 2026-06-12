#!/usr/bin/env node
/**
 * backtest-intraday.mjs — 인트라데이 전략 비교 시뮬레이터 (토스 1분봉)
 *   backtest-orb.mjs 후속 — 같은 비용·가드레일에서 전략 6종을 단일 데이터 패스로 비교.
 *
 *   PIT: 일자 D의 유니버스는 D-1까지의 모멘텀·거래대금만 사용 (stock_prices 커버리지: 2025-09~)
 *   보수 체결: 손절·익절 동시 충족 봉 → 손절 우선. 갭 → 시가 체결. 진입 +1틱, 청산 -1틱.
 *   비용: 수수료 0.015%×2 + 매도 거래세 0.15%.
 *
 * 실행:
 *   node backtest-intraday.mjs --from 20260316 --to 20260611 --capital 10000000
 *   node backtest-intraday.mjs --strategies orb15,gapgo --capital 30000 --max-price 10000
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getDailyCandles, getCandles1m, getStockWarnings } from './toss-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

// ── 인자 ─────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (k, dflt) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : dflt; };
const FROM = argOf('--from', '20260316');
const TO = argOf('--to', '20260611');
const CAPITAL = Number(argOf('--capital', '10000000'));
const MAX_PRICE = Number(argOf('--max-price', '0')) || Infinity; // 소자본용 가격 상한
const ONLY = argOf('--strategies', '').split(',').filter(Boolean);

const MAX_POSITIONS = 3;
const UNIVERSE_SIZE = 10;
const MIN_PRICE = 2_000;
const DAILY_LOSS_PCT = 2.0;
const MAX_CONSEC_LOSSES = 3;
const FEE_BPS = 1.5, TAX_BPS = 15;
const FLAT_TIME = '14:50';

// ── 전략 정의 ────────────────────────────────────────────────
const STRATEGIES = {
  // type:orb — 시가범위(orEnd까지) 고가 돌파 + 거래량
  'orb15':      { type: 'orb', orEnd: '09:15', entryEnd: '09:30', stopPct: 1.0, volMult: 2, tpR: 2 },
  'orb15-wide': { type: 'orb', orEnd: '09:15', entryEnd: '09:30', stopPct: 2.0, volMult: 2, tpR: 2 },
  'orb30':      { type: 'orb', orEnd: '09:30', entryEnd: '10:00', stopPct: 1.5, volMult: 2, tpR: 2 },
  // type:pdh — 전일 고가 돌파 + 거래량
  'pdh':        { type: 'pdh', entryStart: '09:05', entryEnd: '10:30', stopPct: 1.5, volMult: 2, tpR: 2 },
  // type:gapgo — 갭업 2~8% 종목, 첫 5분 고가 돌파
  'gapgo':      { type: 'gapgo', gapMin: 2, gapMax: 8, entryStart: '09:05', entryEnd: '09:30', stopPct: 1.5, volMult: 1.5, tpR: 2 },
  // type:vwap — 가격>VWAP 추세 중 VWAP 터치 후 반등 양봉
  'vwap':       { type: 'vwap', entryStart: '09:30', entryEnd: '14:00', stopPct: 1.0, volMult: 0, tpR: 2 },
};
const ACTIVE = Object.entries(STRATEGIES).filter(([k]) => !ONLY.length || ONLY.includes(k));

// ── 공통 유틸 ────────────────────────────────────────────────
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
const fmtDay = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
function netPnl(entry, exit, qty) {
  const gross = (exit - entry) * qty;
  const fees = (entry + exit) * qty * (FEE_BPS / 10_000) + exit * qty * (TAX_BPS / 10_000);
  return Math.round(gross - fees);
}

async function dbQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(data?.message ?? 'DB 쿼리 오류');
  return data;
}

// ── 캐시 ─────────────────────────────────────────────────────
const dailyCache = new Map(); // code → 일봉 320개 (최신순) — 전 기간 공유
async function dailyBars(code) {
  if (!dailyCache.has(code)) {
    try { dailyCache.set(code, await getDailyCandles(code, 320)); }
    catch { dailyCache.set(code, []); }
  }
  return dailyCache.get(code);
}
const warnCache = new Map();
async function warnings(code) {
  if (!warnCache.has(code)) {
    try { warnCache.set(code, await getStockWarnings(code)); }
    catch { warnCache.set(code, []); }
  }
  return warnCache.get(code);
}
const minuteCache = new Map(); // `${code}:${day}` → 오름차순 1분봉
async function minuteBars(code, day) {
  const key = `${code}:${day}`;
  if (!minuteCache.has(key)) {
    const dayIso = fmtDay(day);
    try {
      const all = await getCandles1m(code, 500, `${dayIso}T15:40:00+09:00`);
      minuteCache.set(key, all
        .filter(b => String(b.timestamp).startsWith(dayIso))
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))));
    } catch { minuteCache.set(key, []); }
  }
  return minuteCache.get(key);
}

// ── PIT 유니버스 ─────────────────────────────────────────────
async function buildUniverse(day, budget) {
  const candidates = await dbQuery(`
    SELECT t.stock_code, sa.corp_name,
           (MAX(CASE WHEN rn = 1 THEN close END)::NUMERIC
            / NULLIF(MAX(CASE WHEN rn = 61 THEN close END), 0) - 1) * 100 AS ret60
    FROM (
      SELECT stock_code, close, ROW_NUMBER() OVER (PARTITION BY stock_code ORDER BY date DESC) AS rn
      FROM stock_prices
      WHERE date >= TO_CHAR(TO_DATE('${day}', 'YYYYMMDD') - 180, 'YYYYMMDD') AND date < '${day}'
    ) t
    JOIN stock_analysis sa ON sa.stock_code = t.stock_code
    WHERE rn IN (1, 61) AND sa.market_cap_tril >= 0.05
    GROUP BY t.stock_code, sa.corp_name
    HAVING (MAX(CASE WHEN rn = 1 THEN close END)::NUMERIC
            / NULLIF(MAX(CASE WHEN rn = 61 THEN close END), 0) - 1) * 100 > 0
    ORDER BY ret60 DESC
    LIMIT 80
  `);
  const dayIso = fmtDay(day);
  const scored = [];
  for (const c of candidates) {
    const bars = await dailyBars(c.stock_code);
    const idx = bars.findIndex(b => String(b.timestamp).slice(0, 10) < dayIso);
    const prev = idx >= 0 ? bars[idx] : null;
    if (!prev || prev.close < MIN_PRICE || prev.close > Math.min(budget, MAX_PRICE)) continue;
    scored.push({ code: c.stock_code, name: c.corp_name, turnover: prev.close * prev.volume, prevClose: prev.close, prevHigh: prev.high });
  }
  scored.sort((a, b) => b.turnover - a.turnover);
  const universe = [];
  for (const s of scored) {
    if (universe.length >= UNIVERSE_SIZE) break;
    const active = (await warnings(s.code)).filter(w =>
      String(w.startDate) <= dayIso && (!w.endDate || String(w.endDate) >= dayIso));
    if (active.length) continue;
    universe.push(s);
  }
  return universe;
}

async function macroGateOk(day) {
  const dayIso = fmtDay(day);
  const bars = (await dailyBars('005930')).filter(b => String(b.timestamp).slice(0, 10) < dayIso);
  if (bars.length < 6) return true;
  const closes = bars.map(b => b.close);
  const ma20 = closes.slice(0, Math.min(20, closes.length)).reduce((s, v) => s + v, 0) / Math.min(20, closes.length);
  const ret5d = ((closes[0] - closes[5]) / closes[5]) * 100;
  return !(closes[0] < ma20 && ret5d < -3);
}

// ── 전략별 1일 시뮬레이션 (봉은 공유, 포트폴리오는 전략별 독립) ──
function simulateStrategyDay(stratKey, cfg, day, universe, barsBySymbol, capital) {
  const budget = Math.floor(capital / MAX_POSITIONS);
  const positions = {}, entered = new Set(), trades = [];
  let realized = 0, consecLosses = 0, halted = false;
  const ctx = {}; // code → { or, first5, vwapPV, vwapV, touched }

  const close = (code, fill, reason) => {
    const p = positions[code];
    const pnl = netPnl(p.entry, fill, p.qty);
    realized += pnl;
    consecLosses = pnl < 0 ? consecLosses + 1 : 0;
    trades.push({ day: fmtDay(day), strat: stratKey, code, name: p.name, entry: p.entry, exit: fill, qty: p.qty, pnl, reason, r: p.r ? Number(((fill - p.entry) / p.r).toFixed(2)) : null });
    delete positions[code];
  };

  // 분 타임라인
  const minutes = [...new Set([...barsBySymbol.values()].flat().map(b => String(b.timestamp).slice(11, 16)))].sort();
  const idx = new Map(universe.map(u => [u.code, 0]));

  for (const hm of minutes) {
    if (hm > '15:20') break;
    for (const u of universe) {
      const bars = barsBySymbol.get(u.code) ?? [];
      let i = idx.get(u.code);
      while (i < bars.length && String(bars[i].timestamp).slice(11, 16) < hm) i++;
      if (i >= bars.length || String(bars[i].timestamp).slice(11, 16) !== hm) { idx.set(u.code, i); continue; }
      const bar = bars[i];
      idx.set(u.code, i + 1);

      const c = ctx[u.code] ??= { or: { high: -Infinity, low: Infinity }, first5: { high: -Infinity, low: Infinity, n: 0 }, pv: 0, v: 0, touched: false };
      // 컨텍스트 누적
      const tp = (bar.high + bar.low + bar.close) / 3;
      c.pv += tp * bar.volume; c.v += bar.volume;
      const vwap = c.v > 0 ? c.pv / c.v : bar.close;
      if (cfg.type === 'orb' && hm < cfg.orEnd) { c.or.high = Math.max(c.or.high, bar.high); c.or.low = Math.min(c.or.low, bar.low); }
      if (c.first5.n < 5) { c.first5.high = Math.max(c.first5.high, bar.high); c.first5.low = Math.min(c.first5.low, bar.low); c.first5.n++; if (c.first5.n === 1) c.open = bar.open; }

      // 포지션 관리 (보수: 손절 우선)
      const p = positions[u.code];
      if (p) {
        p.highSince = Math.max(p.highSince, bar.high);
        if (hm >= FLAT_TIME) { close(u.code, roundTick(bar.close) - tickSize(bar.close), 'time_stop'); continue; }
        if (bar.low <= p.stop) { close(u.code, Math.min(p.stop, bar.open) - tickSize(bar.open), 'stop_loss'); continue; }
        if (!p.halfDone && bar.high >= p.target) {
          const half = Math.floor(p.qty / 2);
          if (half >= 1) {
            const pnl = netPnl(p.entry, p.target, half);
            realized += pnl;
            trades.push({ day: fmtDay(day), strat: stratKey, code: u.code, name: p.name, entry: p.entry, exit: p.target, qty: half, pnl, reason: 'half_exit', r: cfg.tpR });
            p.qty -= half;
          }
          p.halfDone = true; p.stop = p.entry;
        }
        if (p.halfDone && bar.close <= p.highSince * 0.99) { close(u.code, roundTick(bar.close), 'trailing'); continue; }
        continue;
      }

      // 가드
      if (!halted && (realized <= -capital * (DAILY_LOSS_PCT / 100) || consecLosses >= MAX_CONSEC_LOSSES)) halted = true;
      if (halted || entered.has(u.code) || Object.keys(positions).length >= MAX_POSITIONS) continue;

      // 진입 시그널
      const start = cfg.entryStart ?? cfg.orEnd;
      if (hm < start || hm >= cfg.entryEnd) continue;
      const prev5 = bars.slice(Math.max(0, i - 5), i);
      const avgVol = prev5.length >= 3 ? prev5.reduce((s, b) => s + b.volume, 0) / prev5.length : Infinity;
      const volOk = !cfg.volMult || bar.volume > avgVol * cfg.volMult;

      let signal = false, stopRef = null;
      if (cfg.type === 'orb') {
        signal = c.or.high > 0 && bar.close > c.or.high && volOk;
        stopRef = c.or.low;
      } else if (cfg.type === 'pdh') {
        signal = bar.close > u.prevHigh && volOk;
      } else if (cfg.type === 'gapgo') {
        const gap = c.open ? ((c.open - u.prevClose) / u.prevClose) * 100 : 0;
        signal = gap >= cfg.gapMin && gap <= cfg.gapMax && c.first5.n >= 5 && bar.close > c.first5.high && volOk;
        stopRef = c.first5.low;
      } else if (cfg.type === 'vwap') {
        if (bar.low <= vwap * 1.001 && bar.close > vwap) c.touched = true;
        signal = c.touched && bar.close > bar.open && bar.close > vwap && bar.close > u.prevClose;
        if (signal) c.touched = false;
        stopRef = vwap * 0.995;
      }
      if (!signal) continue;

      const fillPrice = roundTick(bar.close) + tickSize(bar.close);
      const qty = Math.floor(budget / fillPrice);
      if (qty < 1) continue;
      const stop = roundTick(Math.max(stopRef ?? 0, fillPrice * (1 - cfg.stopPct / 100)));
      if (stop >= fillPrice) continue;
      const r = fillPrice - stop;
      positions[u.code] = { name: u.name, qty, entry: fillPrice, stop, r, target: roundTick(fillPrice + r * cfg.tpR), halfDone: false, highSince: fillPrice };
      entered.add(u.code);
    }
  }
  for (const code of Object.keys(positions)) {
    const bars = barsBySymbol.get(code);
    const lastBar = bars[bars.length - 1];
    close(code, roundTick(lastBar.close) - tickSize(lastBar.close), 'eod');
  }
  return { trades, pnl: realized };
}

// ── 메인 ─────────────────────────────────────────────────────
console.log(`=== 인트라데이 전략 비교 ${fmtDay(FROM)} ~ ${fmtDay(TO)} | 자본 ${CAPITAL.toLocaleString()}원 | 전략 ${ACTIVE.map(([k]) => k).join(', ')} ===`);

// 영업일 목록: 005930 일봉 기준
const tradingDays = (await dailyBars('005930'))
  .map(b => String(b.timestamp).slice(0, 10).replace(/-/g, ''))
  .filter(d => d >= FROM && d <= TO)
  .sort();
console.log(`영업일 ${tradingDays.length}일`);

const results = Object.fromEntries(ACTIVE.map(([k]) => [k, { trades: [], capital: CAPITAL, gated: 0 }]));

let dayN = 0;
for (const day of tradingDays) {
  dayN++;
  const gateOk = await macroGateOk(day);
  if (!gateOk) {
    for (const [k] of ACTIVE) results[k].gated++;
    console.log(`[${dayN}/${tradingDays.length}] ${fmtDay(day)} — 매크로 게이트, 스킵`);
    continue;
  }
  // 유니버스는 budget 상한이 가장 큰 기준(자본 고정)으로 1회 산출 — 전략 간 공유
  const universe = await buildUniverse(day, Math.floor(CAPITAL / MAX_POSITIONS));
  const barsBySymbol = new Map();
  for (const u of universe) barsBySymbol.set(u.code, await minuteBars(u.code, day));

  const daySummary = [];
  for (const [k, cfg] of ACTIVE) {
    const { trades, pnl } = simulateStrategyDay(k, cfg, day, universe, barsBySymbol, results[k].capital);
    results[k].trades.push(...trades);
    results[k].capital += pnl;
    daySummary.push(`${k}:${pnl >= 0 ? '+' : ''}${(pnl / 1000).toFixed(0)}k`);
  }
  console.log(`[${dayN}/${tradingDays.length}] ${fmtDay(day)} 유니버스 ${universe.length} | ${daySummary.join(' ')}`);
}

// ── 요약 ─────────────────────────────────────────────────────
console.log(`\n=== 전략 비교 요약 (${fmtDay(FROM)}~${fmtDay(TO)}, ${tradingDays.length}영업일) ===`);
console.log('전략         체결   승률    평균R    총손익        수익률    최종자본');
console.log('─'.repeat(85));
for (const [k] of ACTIVE) {
  const r = results[k];
  const exits = r.trades.filter(t => t.reason !== 'half_exit');
  const wins = r.trades.filter(t => t.pnl > 0).length;
  const rVals = r.trades.filter(t => t.r != null).map(t => t.r);
  const avgR = rVals.length ? (rVals.reduce((s, v) => s + v, 0) / rVals.length).toFixed(2) : '-';
  const pnl = r.capital - CAPITAL;
  console.log(
    `${k.padEnd(12)} ${String(exits.length).padStart(4)}  ${String(r.trades.length ? Math.round(wins / r.trades.length * 100) : 0).padStart(4)}%  ${String(avgR).padStart(6)}  ${(pnl >= 0 ? '+' : '') + pnl.toLocaleString().padStart(11)}원  ${((r.capital / CAPITAL - 1) * 100).toFixed(2).padStart(7)}%  ${r.capital.toLocaleString()}원`
  );
}
console.log(`\n매크로 게이트 스킵: ${results[ACTIVE[0][0]].gated}일 | 비용 모델: 수수료 ${FEE_BPS}bp×2 + 거래세 ${TAX_BPS}bp + 슬리피지 2틱`);
