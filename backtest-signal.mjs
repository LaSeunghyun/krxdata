#!/usr/bin/env node
/**
 * backtest-signal.mjs — 다지표 컨플루언스 신호(indicators.mjs scoreSignal) 백테스트.
 *   진입: score>=THRESH 상위 SLOTS종, 종목별 ATR손절/볼린저·RR목표, BTC>MA50 게이트.
 *   청산: 종목별 stop/target 터치(익일 시가 근사) 또는 maxHold. 비용 RT 0.3%.
 * 실행: node backtest-signal.mjs --from 20210101 --to 20241231 [--thresh 70]
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scoreSignal, sma } from './indicators.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const FROM = argOf('--from', '20210101'), TO = argOf('--to', '20241231');
const THRESH = Number(argOf('--thresh', 70));
const SLOTS = Number(argOf('--slots', 6));
const MAXHOLD = Number(argOf('--maxhold', 15));
const CAP = 10_000_000, FEE = 0.0005, SLIP = 0.0015, MIN_TURN = 1e9;
const dayOf = (t) => t.slice(0, 10).replace(/-/g, '');

const pool = new Map();
const rl = createInterface({ input: createReadStream(join(__dirname, 'candles-crypto-daily.jsonl')), crlfDelay: Infinity });
for await (const line of rl) { if (!line.trim()) continue; try { const r = JSON.parse(line); pool.set(r.market, r); } catch {} }
for (const r of pool.values()) r.byTs = new Map(r.d.map((t, i) => [t, i]));
const btc = pool.get('KRW-BTC');
const timeline = btc.d.filter(t => dayOf(t) >= FROM && dayOf(t) <= TO);
const regimeOk = (ts) => { const i = btc.byTs.get(ts); const ma = i != null ? sma(btc.c, i, 50) : null; return ma != null && btc.c[i] > ma; };
const avgTurn = (cd, i) => { if (i < 20) return 0; let s = 0; for (let j = i - 19; j <= i; j++) s += cd.q?.[j] ?? cd.c[j] * cd.v[j]; return s / 20; };

let cash = CAP; const pos = {}; const trades = []; let peak = CAP, maxDD = 0;
const bh0 = btc.c[btc.byTs.get(timeline[0])], bh1 = btc.c[btc.byTs.get(timeline[timeline.length - 1])];

for (const ts of timeline) {
  // 청산 판정 (익일 시가 근사 = 당일 종가)
  for (const [m, p] of Object.entries(pos)) {
    const cd = pool.get(m), i = cd.byTs.get(ts); if (i == null) continue;
    const px = cd.c[i]; p.held++;
    let reason = null;
    if (cd.l[i] <= p.stop) { reason = 'stop'; p.exit = Math.min(px, p.stop); }
    else if (cd.h[i] >= p.target) { reason = 'target'; p.exit = p.target; }
    else if (p.held >= MAXHOLD) { reason = 'maxhold'; p.exit = px; }
    if (reason) {
      const fill = p.exit * (1 - SLIP);
      const pnl = (fill - p.entry) * p.qty - (p.entry + fill) * p.qty * FEE;
      cash += fill * p.qty * (1 - FEE);
      trades.push({ m, pnl, reason, win: pnl > 0, held: p.held });
      delete pos[m];
    }
  }
  // 진입: 게이트 통과 시 score 상위
  if (regimeOk(ts) && Object.keys(pos).length < SLOTS) {
    const cands = [];
    for (const [m, cd] of pool) {
      const i = cd.byTs.get(ts); if (i == null || pos[m]) continue;
      if (avgTurn(cd, i) < MIN_TURN) continue;
      const s = scoreSignal(cd.c, cd.h, cd.l, cd.v, i);
      if (s && s.score >= THRESH && s.rr >= 1.5 && s.stopPct > 0) cands.push({ m, cd, i, s });
    }
    cands.sort((a, b) => b.s.score - a.s.score);
    for (const c of cands) {
      if (Object.keys(pos).length >= SLOTS) break;
      const budget = Math.floor(cash / (SLOTS - Object.keys(pos).length));
      if (budget < 5000) break;
      const entry = c.cd.c[c.i] * (1 + SLIP);
      const qty = budget * (1 - FEE) / entry;
      cash -= budget;
      pos[c.m] = { entry, qty, stop: c.s.stop, target: c.s.target, held: 0 };
    }
  }
  let eq = cash; for (const [m, p] of Object.entries(pos)) { const cd = pool.get(m), i = cd.byTs.get(ts); eq += (i != null ? cd.c[i] : p.entry) * p.qty; }
  peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak * 100);
}
// 잔여 청산
const lt = timeline[timeline.length - 1];
for (const [m, p] of Object.entries(pos)) { const cd = pool.get(m), i = cd.byTs.get(lt); const fill = (i != null ? cd.c[i] : p.entry) * (1 - SLIP); cash += fill * p.qty * (1 - FEE); trades.push({ m, pnl: (fill - p.entry) * p.qty, reason: 'eov', win: (fill - p.entry) > 0, held: p.held }); }

const wins = trades.filter(t => t.win);
const gl = -trades.filter(t => !t.win).reduce((s, t) => s + t.pnl, 0), gw = wins.reduce((s, t) => s + t.pnl, 0);
console.log(`=== 신호 백테스트 ${FROM}~${TO} thresh=${THRESH} | BTC B&H ${((bh1 / bh0 - 1) * 100).toFixed(1)}% ===`);
console.log(`체결 ${trades.length} | 승률 ${trades.length ? Math.round(wins.length / trades.length * 100) : 0}% | PF ${gl > 0 ? (gw / gl).toFixed(2) : '∞'} | 총수익 ${((cash / CAP - 1) * 100).toFixed(1)}% | MDD ${maxDD.toFixed(1)}%`);
const byReason = {};
for (const t of trades) { (byReason[t.reason] ??= { n: 0, w: 0 }); byReason[t.reason].n++; if (t.win) byReason[t.reason].w++; }
for (const [r, s] of Object.entries(byReason)) console.log(`  ${r}: ${s.n}건 승률 ${Math.round(s.w / s.n * 100)}%`);
