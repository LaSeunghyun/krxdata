#!/usr/bin/env node
/**
 * backtest-swing.mjs — 일봉 기반 스윙·단기 전략 비교 시뮬레이터 (토스 일봉, 멀티 레짐)
 *
 *   v2: 유니버스를 토스 일봉에서 직접 PIT 계산 (stock_prices 의존 제거) →
 *       2023 약세~2024 횡보~2025-26 멜트업·조정 전 레짐 커버.
 *       전 종목 일봉은 candles-daily.jsonl 디스크 캐시 (첫 실행 ~25분, 이후 수 초).
 *       평가지표: 승률·Profit Factor·월별 일관성·MDD 중심 (복리 안정성 관점).
 *
 *   PIT: 일자 D 시그널은 D까지의 봉만 사용. 단 종목 풀 = 현재 상장 종목(생존 편향 존재) 주의.
 *   체결: 종가 매수 +1틱 / 시가 매도 -1틱, 스톱·익절은 종가 판정 → 익일 시가 집행.
 *   비용: 수수료 0.015%×2 + 매도 거래세 0.15%.
 *
 * 실행:
 *   node backtest-swing.mjs --from 20230102 --to 20260611 --capital 10000000
 *   node backtest-swing.mjs --strategies rsi2,hi120 --from 20240102 --to 20241230
 */
import dotenv from 'dotenv';
import { createReadStream, existsSync, appendFileSync } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getDailyCandles } from './toss-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const argv = process.argv.slice(2);
const argOf = (k, dflt) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : dflt; };
const FROM = argOf('--from', '20230102');
const TO = argOf('--to', '20260611');
const CAPITAL = Number(argOf('--capital', '10000000'));
const BARS_DEPTH = Number(argOf('--bars', '1150')); // 2022-01~ (FROM 이전 룩백 130일 포함)
const ONLY = argOf('--strategies', '').split(',').filter(Boolean);
const CACHE_FILE = join(__dirname, 'candles-daily.jsonl');

const FEE_BPS = 1.5, TAX_BPS = 15;
const MIN_PRICE = 2_000;
const MIN_TURNOVER = 5e8; // 20일 평균 거래대금 5억 미만 제외 (유동성)

const STRATEGIES = {
  'swing-mom':  { slots: 10 },                                        // ret60 top10 주간 리밸 + 스톱-25%/+100% 절반
  'swing-rank': { slots: 10 },                                        // 실제 daily_rankings (데이터 있는 날만)
  'vb':         { slots: 5, k: 0.5 },                                 // 변동성 돌파, 익일 시가 청산
  'overnight':  { slots: 5 },                                         // 종가 매수 → 익일 시가
  'hi120':      { slots: 10, lookback: 120, trailPct: 10, maxHold: 60 }, // 120일 신고가 + 트레일링
  'rsi2':       { slots: 5, rsiMax: 10, stopPct: 7, maxHold: 10 },    // 과매도 반등 (현재 시총 상위 — lookahead 주의)
  'rsi2-pit':   { slots: 5, rsiMax: 10, stopPct: 7, maxHold: 10 },    // 과매도 반등 (PIT 20일 거래대금 상위 — 테마주 포함)
  'rsi2-mcap':  { slots: 5, rsiMax: 10, stopPct: 7, maxHold: 10 },    // 과매도 반등 (PIT 시총 상위 = 당시 가격×발행주식수)
  // combo: 레짐 적응형 — 상승장 hi120 비중↑, 중립 rsi2 비중↑, 하락장 rsi2 소량+현금
  'combo':      { slots: 10, rsiMax: 10, stopPct: 7, maxHoldR: 10, lookback: 120, trailPct: 10, maxHoldH: 60 },
  // combo-v2: 사유 기록 분석 반영 — hi120 돌파폭 3%+만, rsi2 최대보유 5일, NEUTRAL hi120 슬롯 2
  'combo-v2':   { slots: 10, rsiMax: 10, stopPct: 7, maxHoldR: 5, lookback: 120, trailPct: 8, maxHoldH: 60, minBreakout: 3, rsiDays: 2, tp1R: 1, rsiMa: 3, v2: true },
};
// combo-v2 파라미터 오버라이드 (스윕용): --trail 8 --minbreak 5 --maxholdr 3 --stoppct 5
// 가설 플래그: --volx N (hi120 돌파일 거래량 > 20일평균 ×N), --rsidays N (rsi2 N일 연속 과매도),
//             --downsize 0.5 (DOWN 레짐 rsi2 사이즈 배수), --tp1r 1 (1R 도달 시 절반 익절)
for (const [flag, key] of [['--trail', 'trailPct'], ['--minbreak', 'minBreakout'], ['--maxholdr', 'maxHoldR'], ['--stoppct', 'stopPct'],
  ['--volx', 'volX'], ['--rsidays', 'rsiDays'], ['--downsize', 'downSize'], ['--tp1r', 'tp1R'], ['--intraday', 'intradayExit'], ['--maxholdh', 'maxHoldH'], ['--rsiuni', 'rsiUni'], ['--entryopen', 'entryOpen'], ['--downflat', 'downFlat'], ['--rsima', 'rsiMa']]) {
  const v = argOf(flag, null);
  if (v != null) STRATEGIES['combo-v2'][key] = Number(v);
}
const DUMP = argOf('--dump', null);
const ACTIVE = Object.entries(STRATEGIES).filter(([k]) => !ONLY.length || ONLY.includes(k));

function tickSize(p) {
  if (p < 2_000) return 1;
  if (p < 5_000) return 5;
  if (p < 20_000) return 10;
  if (p < 50_000) return 50;
  if (p < 200_000) return 100;
  if (p < 500_000) return 500;
  return 1_000;
}
const tickUp = (p) => Math.round(p / tickSize(p)) * tickSize(p) + tickSize(p);
const tickDn = (p) => Math.round(p / tickSize(p)) * tickSize(p) - tickSize(p);
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

// ── 일봉 풀: 디스크 캐시 우선, 누락분만 API ───────────────────
// 구조: code → { d:[yyyymmdd...오름차순], o,h,l,c,v:[...], byDate:Map }
const candles = new Map();
function indexOfDate(cd, day) { return cd.byDate.get(day); }
function lastIndexBefore(cd, day) {
  // 이진 탐색: d[i] < day 인 최대 i
  let lo = 0, hi = cd.d.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cd.d[m] < day) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function addToPool(code, rec) {
  rec.byDate = new Map(rec.d.map((dt, i) => [dt, i]));
  candles.set(code, rec);
}
async function loadPool(codes) {
  if (existsSync(CACHE_FILE)) {
    console.log('캐시 로드:', CACHE_FILE);
    const rl = createInterface({ input: createReadStream(CACHE_FILE), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { const rec = JSON.parse(line); addToPool(rec.code, rec); } catch {}
    }
    console.log(`캐시 ${candles.size}종목`);
  }
  const missing = codes.filter(c => !candles.has(c));
  if (missing.length) {
    console.log(`일봉 신규 수집 ${missing.length}종목 (~${Math.round(missing.length * 6 * 0.105 / 60)}분)...`);
    let done = 0;
    for (const code of missing) {
      try {
        const list = (await getDailyCandles(code, BARS_DEPTH)).reverse();
        const rec = {
          code,
          d: list.map(b => String(b.timestamp).slice(0, 10).replace(/-/g, '')),
          o: list.map(b => b.open), h: list.map(b => b.high),
          l: list.map(b => b.low), c: list.map(b => b.close), v: list.map(b => b.volume),
        };
        addToPool(code, rec);
        const { byDate, ...persist } = rec;
        appendFileSync(CACHE_FILE, JSON.stringify(persist) + '\n');
      } catch { /* 미커버 스킵 */ }
      if (++done % 200 === 0) console.log(`  ${done}/${missing.length}`);
    }
  }
}

// ── PIT 모멘텀 유니버스 (주간, 일봉 로컬 계산) ─────────────────
const universeCache = new Map();
function weekKey(day) {
  const d = new Date(`${fmtDay(day)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
function momUniverse(day) {
  const wk = weekKey(day);
  if (universeCache.has(wk)) return universeCache.get(wk);
  const scored = [];
  for (const [code, cd] of candles) {
    const i = lastIndexBefore(cd, day);
    if (i < 61) continue;
    const price = cd.c[i];
    if (price < MIN_PRICE) continue;
    let turnover = 0;
    for (let j = i - 19; j <= i; j++) turnover += cd.c[j] * cd.v[j];
    turnover /= 20;
    if (turnover < MIN_TURNOVER) continue;
    const ret60 = (price / cd.c[i - 61] - 1) * 100;
    if (ret60 <= 0) continue;
    scored.push({ code, ret60, turnover });
  }
  scored.sort((a, b) => b.ret60 - a.ret60);
  universeCache.set(wk, scored.slice(0, 30).map(s => s.code));
  return universeCache.get(wk);
}

// PIT 유동성 상위 30 (20일 평균 거래대금) — rsi2-pit용, 시총 lookahead 제거
const liqCache = new Map();
function liqUniverse(day) {
  const wk = weekKey(day);
  if (liqCache.has(wk)) return liqCache.get(wk);
  const scored = [];
  for (const [code, cd] of candles) {
    const i = lastIndexBefore(cd, day);
    if (i < 20) continue;
    if (cd.c[i] < MIN_PRICE) continue;
    let turnover = 0;
    for (let j = i - 19; j <= i; j++) turnover += cd.c[j] * cd.v[j];
    scored.push({ code, turnover: turnover / 20 });
  }
  scored.sort((a, b) => b.turnover - a.turnover);
  liqCache.set(wk, scored.slice(0, 30).map(s => s.code));
  return liqCache.get(wk);
}

// PIT 시총 상위 30 — 발행주식수(현재값 근사) × 당시 종가. 주식수 변동은 가격 대비 미미
const sharesEst = new Map(); // code → 추정 발행주식수
const mcapCache = new Map();
function mcapUniverse(day) {
  const wk = weekKey(day);
  if (mcapCache.has(wk)) return mcapCache.get(wk);
  const scored = [];
  for (const [code, cd] of candles) {
    const sh = sharesEst.get(code);
    if (!sh) continue;
    const i = lastIndexBefore(cd, day);
    if (i < 3 || cd.c[i] < MIN_PRICE) continue;
    scored.push({ code, mcap: sh * cd.c[i] });
  }
  scored.sort((a, b) => b.mcap - a.mcap);
  mcapCache.set(wk, scored.slice(0, MCAP_TOP).map(s => s.code));
  return mcapCache.get(wk);
}

// 시장 레짐 (005930 프록시, 당일 종가 기준): UP / NEUTRAL / DOWN
function marketRegime(day) {
  const cd = candles.get('005930');
  const i = cd ? indexOfDate(cd, day) ?? lastIndexBefore(cd, day) : null;
  const [fast, slow] = REGIME_MAS;
  if (i == null || i < slow) return 'NEUTRAL';
  let maF = 0, maS = 0;
  for (let j = i - fast + 1; j <= i; j++) maF += cd.c[j];
  for (let j = i - slow + 1; j <= i; j++) maS += cd.c[j];
  maF /= fast; maS /= slow;
  const ret5 = (cd.c[i] / cd.c[i - 5] - 1) * 100;
  if (cd.c[i] > maF && maF > maS) return 'UP';
  if (cd.c[i] < maF && ret5 < -3) return 'DOWN';
  return 'NEUTRAL';
}
const COMBO_CAPS = { UP: { hi120: 6, rsi2: 4 }, NEUTRAL: { hi120: 3, rsi2: 5 }, DOWN: { hi120: 0, rsi2: 4 } };
const COMBO_CAPS_V2 = { UP: { hi120: 6, rsi2: 4 }, NEUTRAL: { hi120: 2, rsi2: 6 }, DOWN: { hi120: 0, rsi2: 4 } };
// 슬롯 배분 프리셋 (--caps A|B|C): A=현행, B=추세 공격형, C=역추세 수비형
const CAPS_PRESETS = {
  A: COMBO_CAPS_V2,
  B: { UP: { hi120: 8, rsi2: 2 }, NEUTRAL: { hi120: 3, rsi2: 7 }, DOWN: { hi120: 0, rsi2: 5 } },
  C: { UP: { hi120: 5, rsi2: 5 }, NEUTRAL: { hi120: 2, rsi2: 8 }, DOWN: { hi120: 0, rsi2: 6 } },
};
const CAPS_SEL = argOf('--caps', 'A');
// 레짐 MA 페어 (--regimema "20,60"): 빠른 스위치 vs 느린 스위치
const REGIME_MAS = argOf('--regimema', '20,60').split(',').map(Number);
const MCAP_TOP = Number(argOf('--rsiuni', '30'));

// ── 포트폴리오 ───────────────────────────────────────────────
function makeBook() { return { cash: CAPITAL, positions: {}, trades: [], peak: CAPITAL, maxDD: 0, monthly: new Map(), lastEq: CAPITAL }; }
function equity(book, day) {
  let eq = book.cash;
  for (const [code, p] of Object.entries(book.positions)) {
    const cd = candles.get(code);
    const i = cd ? indexOfDate(cd, day) ?? lastIndexBefore(cd, day) : null;
    eq += (i != null && i >= 0 ? cd.c[i] : p.entry) * p.qty;
  }
  return eq;
}
function buy(book, day, code, price, budget, meta = {}) {
  const fill = tickUp(price);
  const qty = Math.floor(Math.min(budget, book.cash) / fill);
  if (qty < 1) return false;
  book.cash -= fill * qty;
  book.positions[code] = { qty, entry: fill, entryDay: day, hi: fill, holdDays: 0, ...meta };
  return true;
}
function sell(book, day, code, price, reason, qtyArg) {
  const p = book.positions[code];
  if (!p) return;
  const qty = qtyArg ?? p.qty;
  const fill = tickDn(price);
  const pnl = netPnl(p.entry, fill, qty);
  book.cash += fill * qty;
  book.trades.push({ day: fmtDay(day), code, entry: p.entry, exit: fill, qty, pnl, hold: p.holdDays, reason, ctx: p.ctx });
  p.qty -= qty;
  if (p.qty < 1) delete book.positions[code];
}
function rsi2(cd, i) {
  if (i < 2) return 50;
  let up = 0, dn = 0;
  for (let j = i - 1; j <= i; j++) {
    const ch = cd.c[j] - cd.c[j - 1];
    if (ch > 0) up += ch; else dn -= ch;
  }
  return up + dn === 0 ? 50 : (up / (up + dn)) * 100;
}

// ── 메인 ─────────────────────────────────────────────────────
console.log(`=== 스윙 전략 비교 v2 ${fmtDay(FROM)} ~ ${fmtDay(TO)} | 자본 ${CAPITAL.toLocaleString()}원 | ${ACTIVE.map(([k]) => k).join(', ')} ===`);

const allRows = await dbQuery(`SELECT stock_code, current_price, market_cap_tril FROM stock_analysis WHERE current_price > 0`);
const allCodes = allRows.map(r => r.stock_code);
for (const r of allRows) {
  const sh = (Number(r.market_cap_tril) * 1e12) / Number(r.current_price);
  if (Number.isFinite(sh) && sh > 0) sharesEst.set(r.stock_code, sh);
}
const largeCaps = (await dbQuery(`SELECT stock_code FROM stock_analysis WHERE current_price >= ${MIN_PRICE} ORDER BY market_cap_tril DESC LIMIT 30`)).map(r => r.stock_code);
await loadPool(allCodes);

const krx = candles.get('005930');
const tradingDays = krx.d.filter(d => d >= FROM && d <= TO);
console.log(`영업일 ${tradingDays.length}일 | 풀 ${candles.size}종목 (※ 현재 상장 기준 — 생존 편향 존재)`);

const rankRows = await dbQuery(`SELECT rank_date, stock_code, rank FROM daily_rankings WHERE rank <= 20 ORDER BY rank_date, rank`);
const rankByDay = new Map();
for (const r of rankRows) {
  const d = String(r.rank_date).replace(/-/g, '');
  if (!rankByDay.has(d)) rankByDay.set(d, []);
  rankByDay.get(d).push(r);
}

const books = Object.fromEntries(ACTIVE.map(([k]) => [k, makeBook()]));
let weekMark = '';

for (let di = 0; di < tradingDays.length; di++) {
  const day = tradingDays[di];
  const wk = weekKey(day);
  const isNewWeek = wk !== weekMark; weekMark = wk;
  const mom = momUniverse(day);

  for (const [k, cfg] of ACTIVE) {
    const book = books[k];
    const budget = () => Math.floor(equity(book, day) / cfg.slots);

    // ① 시가 집행 큐 + 보유일
    for (const [code, p] of Object.entries(book.positions)) {
      p.holdDays++;
      const cd = candles.get(code);
      const i = cd ? indexOfDate(cd, day) : null;
      if (i == null) continue;
      if (p.exitAtOpen) { sell(book, day, code, cd.o[i], p.exitAtOpen, p.exitQty); delete p.exitAtOpen; delete p.exitQty; continue; }
      p.hiPrev = p.hi; // 전일까지의 고점 (장중 트레일링 레벨용 — 당일 고가 lookahead 방지)
      p.hi = Math.max(p.hi, cd.h[i]);
    }

    // ② 전략 로직 (종가 판정)
    if (k === 'swing-mom' || k === 'swing-rank') {
      const top = k === 'swing-mom' ? mom.slice(0, 10)
        : (rankByDay.get(day) ?? []).filter(r => r.rank <= 10).map(r => r.stock_code);
      const keep = k === 'swing-mom' ? new Set(mom.slice(0, 20))
        : new Set((rankByDay.get(day) ?? []).map(r => r.stock_code));
      if (k === 'swing-rank' && !rankByDay.has(day)) { /* 랭킹 없는 날 보유만 유지 */ }
      else {
        for (const [code, p] of Object.entries(book.positions)) {
          const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
          if (i == null) continue;
          if (cd.c[i] <= p.entry * 0.75) { p.exitAtOpen = 'stop_loss'; continue; }
          if (!p.halfDone && cd.c[i] >= p.entry * 2) { p.exitAtOpen = 'half_profit'; p.exitQty = Math.floor(p.qty / 2); p.halfDone = true; continue; }
          if (isNewWeek && !keep.has(code)) p.exitAtOpen = 'rebalance';
        }
        if (isNewWeek || k === 'swing-rank') {
          for (const code of top) {
            if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
            const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
            if (i == null) continue;
            buy(book, day, code, cd.c[i], budget());
          }
        }
      }
    } else if (k === 'vb') {
      for (const code of mom.slice(0, 10)) {
        if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null || i < 1) continue;
        const target = cd.o[i] + cfg.k * (cd.h[i - 1] - cd.l[i - 1]);
        if (cd.h[i] >= target && target > 0) {
          if (buy(book, day, code, Math.max(target, cd.o[i]), budget()))
            book.positions[code].exitAtOpen = 'vb_exit';
        }
      }
    } else if (k === 'overnight') {
      for (const code of mom.slice(0, 5)) {
        if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null) continue;
        if (buy(book, day, code, cd.c[i], budget()))
          book.positions[code].exitAtOpen = 'overnight_exit';
      }
    } else if (k === 'hi120') {
      for (const [code, p] of Object.entries(book.positions)) {
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null) continue;
        if (cd.c[i] <= p.hi * (1 - cfg.trailPct / 100)) p.exitAtOpen = 'trailing';
        else if (p.holdDays >= cfg.maxHold) p.exitAtOpen = 'max_hold';
      }
      for (const code of mom) {
        if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null || i < cfg.lookback + 1) continue;
        let prevHigh = 0;
        for (let j = i - cfg.lookback; j < i; j++) prevHigh = Math.max(prevHigh, cd.h[j]);
        if (cd.c[i] > prevHigh) buy(book, day, code, cd.c[i], budget());
      }
    } else if (k === 'combo' || k === 'combo-v2') {
      const regime = marketRegime(day);
      const caps = (cfg.v2 ? (CAPS_PRESETS[CAPS_SEL] ?? COMBO_CAPS_V2) : COMBO_CAPS)[regime];
      // H9 (--entryopen): 전일 돌파 시그널을 당일 시가에 진입
      if (cfg.entryOpen && book.pendingBuys?.length) {
        const pend = book.pendingBuys; book.pendingBuys = [];
        for (const pb of pend) {
          if (book.positions[pb.code]) continue;
          const cd2 = candles.get(pb.code); const i2 = cd2 ? indexOfDate(cd2, day) : null;
          if (i2 == null) continue;
          buy(book, day, pb.code, cd2.o[i2], budget(), { sub: 'hi120', ctx: pb.ctx });
        }
      }
      // 보유 관리: 서브 전략별 청산 규칙
      for (const [code, p] of Object.entries(book.positions)) {
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null) continue;
        // H1/H4 (--intraday 1): 당일 장중 레벨 터치 시 즉시 청산 (level 또는 갭 시 시가, 전일 기준 레벨)
        if (cfg.intradayExit && !p.exitAtOpen && (cfg.intradayExit === 1 || p.sub === 'rsi2')) { // 2=rsi2 스톱만
          const level = p.sub === 'hi120'
            ? (p.hiPrev ?? p.hi) * (1 - cfg.trailPct / 100) // 전일 고점 기준 (당일 고가 lookahead 방지)
            : p.entry * (1 - cfg.stopPct / 100);
          if (cd.l[i] <= level && p.holdDays >= 1) {     // 진입 당일 제외
            sell(book, day, code, Math.min(level, cd.o[i]), p.sub === 'hi120' ? 'trailing_intraday' : 'stop_intraday');
            continue;
          }
        }
        if (p.sub === 'hi120') {
          if (cfg.downFlat && regime === 'DOWN' && !p.exitAtOpen) { p.exitAtOpen = 'regime_flat'; continue; }
          // H6 (--tp1r N): 진입가 +trailPct×N 도달 시 절반 익절 (잔량은 트레일링 지속)
          if (cfg.tp1R > 0 && !p.halfDone && cd.c[i] >= p.entry * (1 + cfg.trailPct / 100 * cfg.tp1R) && Math.floor(p.qty / 2) >= 1) {
            p.exitAtOpen = 'tp_half'; p.exitQty = Math.floor(p.qty / 2); p.halfDone = true;
          }
          else if (cd.c[i] <= p.hi * (1 - cfg.trailPct / 100)) p.exitAtOpen = 'trailing';
          else if (p.holdDays >= cfg.maxHoldH) p.exitAtOpen = 'max_hold';
        } else {
          const maN = cfg.rsiMa || 5;
          let ma5 = 0; const n = Math.min(maN, i + 1);
          for (let j = i - n + 1; j <= i; j++) ma5 += cd.c[j];
          ma5 /= n;
          if (cd.c[i] <= p.entry * (1 - cfg.stopPct / 100)) p.exitAtOpen = 'stop_loss';
          else if (cd.c[i] > ma5) p.exitAtOpen = 'ma5_exit';
          else if (p.holdDays >= cfg.maxHoldR) p.exitAtOpen = 'max_hold';
        }
      }
      const countSub = (sub) => Object.values(book.positions).filter(p => p.sub === sub).length;
      // hi120 서브 진입 (모멘텀 유니버스 신고가 돌파)
      for (const code of mom) {
        if (countSub('hi120') >= caps.hi120 || book.positions[code]) continue;
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null || i < cfg.lookback + 1) continue;
        let prevHigh = 0;
        for (let j = i - cfg.lookback; j < i; j++) prevHigh = Math.max(prevHigh, cd.h[j]);
        const breakoutPct = (cd.c[i] / prevHigh - 1) * 100;
        // H3: 돌파일 거래량 필터 (--volx N) — 거래량 미동반 돌파 제외
        let volOk = true;
        if (cfg.volX > 0 && i >= 21) {
          let av = 0;
          for (let j = i - 20; j < i; j++) av += cd.v[j];
          volOk = cd.v[i] > (av / 20) * cfg.volX;
        }
        if (cd.c[i] > prevHigh && breakoutPct >= (cfg.minBreakout ?? 0) && volOk) {
          const ctxE = { sub: 'hi120', regime, breakoutPct: breakoutPct.toFixed(1) };
          if (cfg.entryOpen) (book.pendingBuys ??= []).push({ code, ctx: ctxE });
          else buy(book, day, code, cd.c[i], budget(), { sub: 'hi120', ctx: ctxE });
        }
      }
      // rsi2 서브 진입 (PIT 시총 상위 과매도)
      for (const code of mcapUniverse(day)) {
        if (countSub('rsi2') >= caps.rsi2 || book.positions[code]) continue;
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null || i < 4) continue;
        const r = rsi2(cd, i);
        // H7: N일 연속 과매도 요구 (--rsidays 2)
        const daysOk = !(cfg.rsiDays > 1) || rsi2(cd, i - 1) < cfg.rsiMax;
        if (r < cfg.rsiMax && daysOk) {
          // H2: DOWN 레짐 사이즈 축소 (--downsize 0.5)
          const sizeMult = (regime === 'DOWN' && cfg.downSize > 0) ? cfg.downSize : 1;
          buy(book, day, code, cd.c[i], Math.floor(budget() * sizeMult), { sub: 'rsi2', ctx: { sub: 'rsi2', regime, rsi: r.toFixed(0) } });
        }
      }
    } else if (k === 'rsi2' || k === 'rsi2-pit' || k === 'rsi2-mcap') {
      const uni = k === 'rsi2' ? largeCaps : k === 'rsi2-pit' ? liqUniverse(day) : mcapUniverse(day);
      for (const [code, p] of Object.entries(book.positions)) {
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null) continue;
        let ma5 = 0; const n = Math.min(5, i + 1);
        for (let j = i - n + 1; j <= i; j++) ma5 += cd.c[j];
        ma5 /= n;
        if (cd.c[i] <= p.entry * (1 - cfg.stopPct / 100)) p.exitAtOpen = 'stop_loss';
        else if (cd.c[i] > ma5) p.exitAtOpen = 'ma5_exit';
        else if (p.holdDays >= cfg.maxHold) p.exitAtOpen = 'max_hold';
      }
      for (const code of uni) {
        if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null || i < 3) continue;
        if (rsi2(cd, i) < cfg.rsiMax) buy(book, day, code, cd.c[i], budget());
      }
    }

    // ③ 자산·MDD·월별 수익 추적
    const eq = equity(book, day);
    book.peak = Math.max(book.peak, eq);
    book.maxDD = Math.max(book.maxDD, (book.peak - eq) / book.peak * 100);
    const mon = day.slice(0, 6);
    if (!book.monthly.has(mon)) book.monthly.set(mon, { start: book.lastEq, end: eq });
    book.monthly.get(mon).end = eq;
    book.lastEq = eq;
  }
  if ((di + 1) % 60 === 0) console.log(`[${di + 1}/${tradingDays.length}] ${fmtDay(day)} | ` + ACTIVE.map(([k]) => `${k}:${((equity(books[k], day) / CAPITAL - 1) * 100).toFixed(0)}%`).join(' '));
}

const lastDay = tradingDays[tradingDays.length - 1];
for (const [k] of ACTIVE) {
  const book = books[k];
  for (const code of Object.keys(book.positions)) {
    const cd = candles.get(code);
    const i = cd ? indexOfDate(cd, lastDay) ?? lastIndexBefore(cd, lastDay) : null;
    sell(book, lastDay, code, i != null && i >= 0 ? cd.c[i] : book.positions[code].entry, 'eov');
  }
}

// ── 요약: 복리 안정성 관점 ────────────────────────────────────
const years = tradingDays.length / 248;
console.log(`\n=== 전략 비교 (${fmtDay(FROM)}~${fmtDay(TO)}, ${tradingDays.length}영업일 ≈ ${years.toFixed(1)}년) ===`);
console.log('전략         체결    승률   PF     CAGR     MDD    월승률   평균보유  최종자본');
console.log('─'.repeat(95));
for (const [k] of ACTIVE) {
  const b = books[k];
  const wins = b.trades.filter(t => t.pnl > 0);
  const losses = b.trades.filter(t => t.pnl <= 0);
  const grossW = wins.reduce((s, t) => s + t.pnl, 0);
  const grossL = -losses.reduce((s, t) => s + t.pnl, 0);
  const pf = grossL > 0 ? (grossW / grossL).toFixed(2) : '∞';
  const months = [...b.monthly.values()];
  const monWin = months.length ? Math.round(months.filter(m => m.end > m.start).length / months.length * 100) : 0;
  const cagr = (Math.pow(b.cash / CAPITAL, 1 / years) - 1) * 100;
  const avgHold = b.trades.length ? (b.trades.reduce((s, t) => s + t.hold, 0) / b.trades.length).toFixed(1) : '-';
  console.log(
    `${k.padEnd(12)} ${String(b.trades.length).padStart(4)}  ${String(b.trades.length ? Math.round(wins.length / b.trades.length * 100) : 0).padStart(4)}%  ${String(pf).padStart(5)}  ${cagr.toFixed(1).padStart(6)}%  ${b.maxDD.toFixed(1).padStart(5)}%  ${String(monWin).padStart(4)}%  ${String(avgHold).padStart(6)}일  ${b.cash.toLocaleString()}원`
  );
}

// 연도별 수익률 분해 (레짐별 일관성)
console.log('\n연도별 수익률:');
const yearsList = [...new Set(tradingDays.map(d => d.slice(0, 4)))];
for (const [k] of ACTIVE) {
  const b = books[k];
  const byYear = yearsList.map(y => {
    const months = [...b.monthly.entries()].filter(([m]) => m.startsWith(y)).map(([, v]) => v);
    if (!months.length) return `${y}: -`;
    const ret = (months[months.length - 1].end / months[0].start - 1) * 100;
    return `${y}: ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%`;
  });
  console.log(`  ${k.padEnd(12)} ${byYear.join('  ')}`);
}
// ── combo 조건별 분석: 해야할 것 / 하지말아야할 것 ─────────────
for (const comboKey of ['combo', 'combo-v2']) {
  if (!books[comboKey]) continue;
  const ct = books[comboKey].trades.filter(t => t.ctx);
  const groups = new Map();
  for (const t of ct) {
    for (const key of [
      `${t.ctx.sub} × 레짐 ${t.ctx.regime}`,
      `${t.ctx.sub} × 청산 ${t.reason}`,
      t.ctx.sub === 'rsi2' ? `rsi2 × RSI ${t.ctx.rsi <= 5 ? '0~5(극단)' : '5~10'}` : `hi120 × 돌파폭 ${Number(t.ctx.breakoutPct) >= 3 ? '3%+(갭성)' : '0~3%'}`,
      `${t.ctx.sub} × 보유 ${t.hold <= 3 ? '1~3일' : t.hold <= 10 ? '4~10일' : '11일+'}`,
    ]) {
      if (!groups.has(key)) groups.set(key, { n: 0, w: 0, pnl: 0 });
      const g = groups.get(key);
      g.n++; if (t.pnl > 0) g.w++; g.pnl += t.pnl;
    }
  }
  console.log(`\n=== ${comboKey} 조건별 성적 (매매 사유 기록 기반) ===`);
  const rows = [...groups.entries()].filter(([, g]) => g.n >= 15).sort((a, b) => b[1].w / b[1].n - a[1].w / a[1].n);
  for (const [key, g] of rows) {
    console.log(`  ${key.padEnd(28)} n=${String(g.n).padStart(4)} 승률 ${String(Math.round(g.w / g.n * 100)).padStart(3)}% 누적 ${(g.pnl >= 0 ? '+' : '') + Math.round(g.pnl / 1000).toLocaleString()}k`);
  }
  const dos = rows.filter(([, g]) => g.w / g.n >= 0.55 && g.pnl > 0).map(([k]) => k);
  const donts = rows.filter(([, g]) => g.w / g.n < 0.40 || g.pnl < 0).map(([k]) => k);
  console.log('\n  ✅ 해야할 것: ' + (dos.join(' / ') || '(표본 부족)'));
  console.log('  ⛔ 하지말아야할 것: ' + (donts.join(' / ') || '(표본 부족)'));
}
console.log(`\n비용: 수수료 ${FEE_BPS}bp×2 + 거래세 ${TAX_BPS}bp + 슬리피지 ±1틱 | 풀: 현재 상장 ${candles.size}종목 (생존 편향) | swing-rank: 랭킹 ${rankByDay.size}일치`);

// 매매 내역 덤프 (--dump path) — 사이클 분석용
if (DUMP) {
  const { writeFileSync } = await import('fs');
  const out = {};
  for (const [k] of ACTIVE) out[k] = { cash: books[k].cash, maxDD: books[k].maxDD, trades: books[k].trades };
  writeFileSync(DUMP, JSON.stringify({ from: FROM, to: TO, params: STRATEGIES['combo-v2'], books: out }));
  console.log(`덤프 저장: ${DUMP}`);
}
