/**
 * backtest-scalp-sweep.mjs — 스캘핑 스모크테스트 손절/목표/보유시간 스윕 (2026-07-24).
 *   표본 극소(토스 1분봉 실측 가용 ~3~4거래일, 9종목) — 방향성 참고용, 실배포 근거 아님.
 */
import { readFileSync } from 'fs';
import { calcRoundTripPnl, DEFAULT_FEE_BPS, getSellTaxBps } from './execution-model.mjs';

const FEE_BPS = DEFAULT_FEE_BPS, TAX_BPS = getSellTaxBps('KOSPI');

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
function dayKey(ts) { return ts.slice(0, 10); }

function prep(bars) {
  const cd = [...bars].reverse();
  const close = cd.map(b => b.close), vol = cd.map(b => b.volume);
  const ema9 = ema(close, 9), ema21 = ema(close, 21);
  const vwap = new Array(cd.length).fill(null);
  let cumPV = 0, cumV = 0, curDay = null;
  for (let i = 0; i < cd.length; i++) {
    const dk = dayKey(cd[i].timestamp);
    if (dk !== curDay) { curDay = dk; cumPV = 0; cumV = 0; }
    const typical = (cd[i].high + cd[i].low + cd[i].close) / 3;
    cumPV += typical * vol[i]; cumV += vol[i];
    vwap[i] = cumV > 0 ? cumPV / cumV : close[i];
  }
  return { cd, ema9, ema21, vwap };
}

function simulateStock(name, prepped, { stopPct, targetPct, maxHold }) {
  const { cd, ema9, ema21, vwap } = prepped;
  const trades = [];
  let i = 21;
  while (i < cd.length - 1) {
    const crossUp = ema9[i - 1] <= ema21[i - 1] && ema9[i] > ema21[i];
    const aboveVwap = cd[i].close > vwap[i];
    if (crossUp && aboveVwap && dayKey(cd[i].timestamp) === dayKey(cd[i + 1].timestamp)) {
      const entry = cd[i + 1].open;
      const stopPx = entry * (1 - stopPct / 100);
      const tgtPx = entry * (1 + targetPct / 100);
      let exitPx = null, reason = null, holdMin = 0;
      for (let j = i + 1; j < cd.length && j <= i + 1 + maxHold; j++) {
        if (dayKey(cd[j].timestamp) !== dayKey(cd[i + 1].timestamp)) { exitPx = cd[j - 1].close; reason = 'day_end'; holdMin = j - 1 - i; break; }
        if (cd[j].low <= stopPx) { exitPx = stopPx; reason = 'stop'; holdMin = j - i; break; }
        if (cd[j].high >= tgtPx) { exitPx = tgtPx; reason = 'target'; holdMin = j - i; break; }
        if (j === i + 1 + maxHold) { exitPx = cd[j].close; reason = 'timeout'; holdMin = j - i; }
      }
      if (exitPx != null) {
        const pnl = calcRoundTripPnl({ entry, exit: exitPx, qty: 1, feeBps: FEE_BPS, taxBps: TAX_BPS });
        trades.push({ name, reason, holdMin, retPct: (pnl / entry) * 100 });
        i = i + 1 + holdMin;
        continue;
      }
    }
    i++;
  }
  return trades;
}

function stats(all) {
  if (!all.length) return null;
  const wins = all.filter(t => t.retPct > 0);
  const losses = all.filter(t => t.retPct <= 0);
  const winRate = wins.length / all.length;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.retPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.retPct, 0) / losses.length : 0;
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  const pf = losses.length ? Math.abs(wins.reduce((s, t) => s + t.retPct, 0) / losses.reduce((s, t) => s + t.retPct, 0)) : Infinity;
  const posStocks = new Set(all.map(t => t.name)).size;
  const netPosStocks = [...new Set(all.map(t => t.name))].filter(nm => all.filter(t => t.name === nm).reduce((s, t) => s + t.retPct, 0) > 0).length;
  return { n: all.length, winRate, pf, expectancy, avgWin, avgLoss, netPosStocks, posStocks };
}

const data = JSON.parse(readFileSync('./candles-1m-smoketest.json', 'utf8'));
const prepped = data.map(({ name, bars }) => ({ name, p: prep(bars) }));

const STOPS = [0.15, 0.2, 0.3, 0.4, 0.6];
const RRS = [1, 1.5, 2, 2.5];
const HOLDS = [5, 10, 15, 20, 30];

const results = [];
for (const stopPct of STOPS) {
  for (const rr of RRS) {
    for (const maxHold of HOLDS) {
      const targetPct = stopPct * rr;
      let all = [];
      for (const { name, p } of prepped) all = all.concat(simulateStock(name, p, { stopPct, targetPct, maxHold }));
      const s = stats(all);
      if (s) results.push({ stopPct, rr, targetPct, maxHold, ...s });
    }
  }
}

results.sort((a, b) => b.expectancy - a.expectancy);
console.log(`=== 스캘핑 파라미터 스윕 (${STOPS.length}×${RRS.length}×${HOLDS.length}=${STOPS.length*RRS.length*HOLDS.length}개 조합, 상위/하위 15개) ===\n`);
console.log('손절% | RR | 목표% | 최대보유(분) | 체결 | 승률 | PF   | 기댓값/거래% | 순양전종목');
for (const r of results.slice(0, 15)) {
  console.log(`${r.stopPct.toFixed(2).padStart(5)} | ${r.rr.toFixed(1).padStart(3)} | ${r.targetPct.toFixed(2).padStart(5)} | ${String(r.maxHold).padStart(10)} | ${String(r.n).padStart(4)} | ${(r.winRate*100).toFixed(1).padStart(5)}% | ${r.pf.toFixed(2).padStart(4)} | ${r.expectancy >= 0 ? '+' : ''}${r.expectancy.toFixed(3).padStart(7)} | ${r.netPosStocks}/${r.posStocks}`);
}
console.log('\n--- 하위 5개(참고) ---');
for (const r of results.slice(-5)) {
  console.log(`${r.stopPct.toFixed(2).padStart(5)} | ${r.rr.toFixed(1).padStart(3)} | ${r.targetPct.toFixed(2).padStart(5)} | ${String(r.maxHold).padStart(10)} | ${String(r.n).padStart(4)} | ${(r.winRate*100).toFixed(1).padStart(5)}% | ${r.pf.toFixed(2).padStart(4)} | ${r.expectancy >= 0 ? '+' : ''}${r.expectancy.toFixed(3).padStart(7)} | ${r.netPosStocks}/${r.posStocks}`);
}
const posCount = results.filter(r => r.expectancy > 0).length;
console.log(`\n전체 ${results.length}개 조합 중 기댓값 양수: ${posCount}개 (${(posCount/results.length*100).toFixed(1)}%)`);
