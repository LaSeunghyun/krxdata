#!/usr/bin/env node
/**
 * backtest-exit-hedge.mjs — "매초 확인 청산" 헷지 가치 검증 (청산 감시 주기 A/B)
 *   질문: 스윙 포지션에서 일봉 1회 확인 vs 장중 연속 감시(5분봉 근사) — 꼬리 절단 이득 > whipsaw 비용?
 *   설계: 동일한 일봉 진입 신호(dip-mr / hi-break), 청산 감시만 3모드 비교
 *     daily   : 손절·트레일 판정을 일봉 종가에만 → 익일 시가 집행 (Part A와 동일)
 *     m5stop  : 손절만 5분봉 저가 터치 즉시 집행(레벨가, 보수), 나머지 규칙은 일봉
 *     m5full  : 손절+트레일 모두 5분봉 감시
 *   유니버스: 5분봉 캐시 보유 14마켓 (메이저6+알트8) | 기간: 2025-01~2026-07 (5분봉 가용 범위)
 *   whipsaw 계측: 장중 손절됐지만 당일 일봉 종가는 손절선 위로 회복한 사례 수
 *
 * 실행: node backtest-exit-hedge.mjs --strategy dip-mr --mode m5stop
 *       node backtest-exit-hedge.mjs --all   (2전략 × 3모드 일괄)
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const FROM = argOf('--from', '20250101');
const TO = argOf('--to', '20260716');
const CAPITAL = 10_000_000;
const FEE = 5 / 10_000, SLIPD = 10 / 10_000; // 수수료 5bp, 슬리피지 10bp per side
const SLOTS = 5;
const MARKETS = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE', 'KRW-ADA', 'KRW-SUI', 'KRW-PEPE', 'KRW-SHIB', 'KRW-AVAX', 'KRW-LINK', 'KRW-HBAR', 'KRW-ETC', 'KRW-XLM'];
const dayOf = (ts) => ts.slice(0, 10).replace(/-/g, '');

const STRATS = {
  'dip-mr':   { rsiMax: 10, trendMA: 200, exitMA: 5, stopPct: 10, maxHold: 10 },
  'hi-break': { lookback: 60, minBreakout: 3, trailPct: 15, maxHold: 60, stopPct: 12 },
};

// ── 데이터 로드 (일봉 신호용 + 5분봉 집행용, 마지막 레코드 우선) ────
async function loadJsonl(file, filterMarkets) {
  const map = new Map();
  const rl = createInterface({ input: createReadStream(join(__dirname, file)), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (!filterMarkets || filterMarkets.includes(r.market)) map.set(r.market, r); } catch {}
  }
  for (const r of map.values()) r.byTs = new Map(r.d.map((t, i) => [t, i]));
  return map;
}
const daily = await loadJsonl('candles-crypto-daily.jsonl', null);
const m5 = await loadJsonl('candles-crypto-5m.jsonl', MARKETS);
const btcD = daily.get('KRW-BTC');
const timeline = btcD.d.filter(t => dayOf(t) >= FROM && dayOf(t) <= TO);

function sma(c, i, n) { if (i < n - 1) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += c[j]; return s / n; }
function rsi2(c, i) {
  if (i < 2) return 50;
  let up = 0, dn = 0;
  for (let j = i - 1; j <= i; j++) { const ch = c[j] - c[j - 1]; if (ch > 0) up += ch; else dn -= ch; }
  return up + dn === 0 ? 50 : (up / (up + dn)) * 100;
}
const regimeOk = (ts) => { const i = btcD.byTs.get(ts); const ma = i != null ? sma(btcD.c, i, 50) : null; return ma != null && btcD.c[i] > ma; };
// 일봉 ts(T09:00 KST) → 그 일봉에 속하는 5분봉 인덱스 범위 [start, end)
function m5Range(market, dailyTs) {
  const cd = m5.get(market);
  if (!cd) return null;
  const s = cd.byTs.get(dailyTs); // 일봉 시작 = 09:00 KST 5분봉
  if (s == null) return null;
  let e = s;
  const endTs = dailyTs.slice(0, 10);
  while (e < cd.d.length) {
    // 다음 일봉 시작(다음날 09:00) 도달 시 종료
    if (cd.d[e].slice(11, 16) === '09:00' && cd.d[e].slice(0, 10) !== endTs) break;
    e++;
  }
  return [s, e];
}

function run(stratKey, mode) {
  const cfg = STRATS[stratKey];
  const book = { cash: CAPITAL, positions: {}, trades: [], pending: {}, peak: CAPITAL, maxDD: 0, whipsaw: 0, monthly: new Map(), lastEq: CAPITAL };
  const equity = () => { let eq = book.cash; for (const p of Object.values(book.positions)) eq += (p.lastClose ?? p.entry) * p.qty; return eq; };
  const close = (market, fill, reason, ts) => {
    const p = book.positions[market];
    if (!p) return;
    const pnl = (fill - p.entry) * p.qty - (p.entry + fill) * p.qty * FEE;
    book.cash += fill * p.qty * (1 - FEE);
    book.trades.push({ ts, market, pnl, reason });
    delete book.positions[market];
  };
  for (let t = 0; t < timeline.length; t++) {
    const ts = timeline[t];
    for (const market of MARKETS) {
      const cd = daily.get(market);
      const i = cd?.byTs.get(ts);
      if (i == null || i < 1) continue;
      const o = cd.o[i], c = cd.c[i];
      // 진입 집행 (전일 신호 → 당일 시가)
      if (book.pending[market]) {
        delete book.pending[market];
        if (!book.positions[market] && Object.keys(book.positions).length < SLOTS) {
          const budget = Math.floor(equity() / SLOTS);
          const fill = o * (1 + SLIPD);
          const qty = budget / fill;
          if (budget >= 5_000) {
            book.cash -= fill * qty * (1 + FEE);
            book.positions[market] = { qty, entry: fill, hi: fill, days: 0, lastClose: c };
          }
        }
      }
      const p = book.positions[market];
      if (p) {
        p.days++;
        if (p.exitNext) { close(market, o * (1 - SLIPD), p.exitNext, ts); continue; }
        const stopLv = p.entry * (1 - cfg.stopPct / 100);
        // ── 장중 감시 모드: 5분봉으로 당일 손절(±트레일) 체크 ──
        let intradayExited = false;
        if (mode !== 'daily') {
          const range = m5Range(market, ts);
          if (range) {
            const cd5 = m5.get(market);
            for (let j = range[0]; j < range[1]; j++) {
              const trailLv = p.hi * (1 - (cfg.trailPct ?? 99) / 100);
              if (cd5.l[j] <= stopLv) {
                close(market, Math.min(cd5.o[j], stopLv) * (1 - SLIPD), 'stop_intraday', ts);
                if (cd.c[i] > stopLv) book.whipsaw++; // 당일 종가는 회복 — 일봉 모드였다면 생존
                intradayExited = true; break;
              }
              if (mode === 'm5full' && cfg.trailPct && cd5.c[j] <= trailLv && p.days > 1) {
                close(market, cd5.c[j] * (1 - SLIPD), 'trail_intraday', ts);
                if (cd.c[i] > trailLv) book.whipsaw++;
                intradayExited = true; break;
              }
              p.hi = Math.max(p.hi, cd5.h[j]);
            }
          }
        }
        if (intradayExited) continue;
        p.lastClose = c; p.hi = Math.max(p.hi, cd.h[i]);
        // 일봉 규칙 (신호층 — 모든 모드 공통, daily 모드에선 손절·트레일도 여기서)
        if (mode === 'daily' && c <= stopLv) p.exitNext = 'stop_daily';
        else if (stratKey === 'hi-break' && (mode !== 'm5full') && c <= p.hi * (1 - cfg.trailPct / 100)) p.exitNext = 'trailing';
        else if (stratKey === 'dip-mr') {
          const ma = sma(cd.c, i, cfg.exitMA);
          if (ma != null && c > ma) p.exitNext = 'ma_exit';
          else if (p.days >= cfg.maxHold) p.exitNext = 'max_hold';
        } else if (p.days >= cfg.maxHold) p.exitNext = 'max_hold';
        continue;
      }
      // 진입 신호 (일봉 종가 판정)
      if (!regimeOk(ts) || Object.keys(book.positions).length >= SLOTS || book.pending[market]) continue;
      if (stratKey === 'hi-break') {
        if (i < cfg.lookback + 1) continue;
        let hh = 0;
        for (let j = i - cfg.lookback; j < i; j++) hh = Math.max(hh, cd.h[j]);
        if (c > hh && (c / hh - 1) * 100 >= cfg.minBreakout) book.pending[market] = true;
      } else {
        const ma200 = sma(cd.c, i, cfg.trendMA);
        if (ma200 != null && c > ma200 && rsi2(cd.c, i) < cfg.rsiMax) book.pending[market] = true;
      }
    }
    const eq = equity();
    book.peak = Math.max(book.peak, eq);
    book.maxDD = Math.max(book.maxDD, (book.peak - eq) / book.peak * 100);
    const mon = dayOf(ts).slice(0, 6);
    if (!book.monthly.has(mon)) book.monthly.set(mon, { start: book.lastEq, end: eq });
    book.monthly.get(mon).end = eq;
    book.lastEq = eq;
  }
  const lastTs = timeline[timeline.length - 1];
  for (const market of Object.keys(book.positions)) {
    const cd = daily.get(market);
    const i = cd.byTs.get(lastTs);
    close(market, (i != null ? cd.c[i] : book.positions[market].lastClose) * (1 - SLIPD), 'eov', lastTs);
  }
  const wins = book.trades.filter(x => x.pnl > 0);
  const gl = -book.trades.filter(x => x.pnl <= 0).reduce((s, x) => s + x.pnl, 0);
  const gw = wins.reduce((s, x) => s + x.pnl, 0);
  const months = [...book.monthly.values()];
  return {
    ret: (book.cash / CAPITAL - 1) * 100, maxDD: book.maxDD, n: book.trades.length,
    winRate: book.trades.length ? Math.round(wins.length / book.trades.length * 100) : 0,
    pf: gl > 0 ? (gw / gl).toFixed(2) : '∞', whipsaw: book.whipsaw,
    monWin: months.length ? Math.round(months.filter(m => m.end > m.start).length / months.length * 100) : 0,
  };
}

console.log(`=== 청산 감시주기 A/B (${FROM}~${TO}, 14마켓, 슬롯 ${SLOTS}, 레짐게이트 ON) ===`);
console.log('전략      모드     총수익    MDD     n   승률   PF    월승률  whipsaw(장중청산→당일회복)');
console.log('─'.repeat(95));
for (const stratKey of Object.keys(STRATS)) {
  for (const mode of ['daily', 'm5stop', 'm5full']) {
    const r = run(stratKey, mode);
    console.log(`${stratKey.padEnd(9)} ${mode.padEnd(7)} ${r.ret.toFixed(1).padStart(7)}%  ${r.maxDD.toFixed(1).padStart(5)}%  ${String(r.n).padStart(4)}  ${String(r.winRate).padStart(3)}%  ${String(r.pf).padStart(5)}  ${String(r.monWin).padStart(4)}%  ${r.whipsaw}`);
  }
}
console.log('\n해석: m5stop/m5full이 daily 대비 MDD를 줄이면(꼬리 절단) 헷지 가치 있음. whipsaw 수 = 장중 감시의 비용.');
