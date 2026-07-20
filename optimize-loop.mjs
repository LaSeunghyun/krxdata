#!/usr/bin/env node
/**
 * optimize-loop.mjs — 재귀 자가개선 사이클 (백테스트 기반, train/valid 검증).
 *   현재 라이브 규칙(신호점수 게이트·RSI veto·손절·보유기간)의 파라미터 공간을 그리드 탐색.
 *   각 조합을 train(2021~2024)에서 평가 → 상위만 valid(2025~2026) 재검증 → 통과분만 findings에 기록.
 *   철학: 되는 걸 찾거나 안 된다고 확정. 과최적화 방지 위해 valid PF>=1.2 AND 총수익>0 만 "승격후보".
 *   결과 누적: optimize-findings.jsonl (사이클마다 append) — 다음 사이클이 읽어 유망 구간 좁힘.
 *
 * 실행: node optimize-loop.mjs   (candles-crypto-daily.jsonl 캐시 필요)
 */
import { createReadStream, appendFileSync, existsSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scoreSignal, sma } from './indicators.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FINDINGS = join(__dirname, 'optimize-findings.jsonl');
const CAP = 10_000_000, FEE = 0.0005, SLIP = 0.0015, MIN_TURN = 1e9, SLOTS = 6;
const dayOf = (t) => t.slice(0, 10).replace(/-/g, '');

// 데이터 로드
const pool = new Map();
const rl = createInterface({ input: createReadStream(join(__dirname, 'candles-crypto-daily.jsonl')), crlfDelay: Infinity });
for await (const line of rl) { if (!line.trim()) continue; try { const r = JSON.parse(line); pool.set(r.market, r); } catch {} }
for (const r of pool.values()) r.byTs = new Map(r.d.map((t, i) => [t, i]));
const btc = pool.get('KRW-BTC');
const regimeOk = (ts, ma) => { const i = btc.byTs.get(ts); const m = i != null ? sma(btc.c, i, ma) : null; return m != null && btc.c[i] > m; };
const avgTurn = (cd, i) => { if (i < 20) return 0; let s = 0; for (let j = i - 19; j <= i; j++) s += cd.q?.[j] ?? cd.c[j] * cd.v[j]; return s / 20; };

function backtest({ from, to, minScore, maxRsi, stopCapPct, maxHold, regimeMA }) {
  const timeline = btc.d.filter(t => dayOf(t) >= from && dayOf(t) <= to);
  let cash = CAP; const pos = {}; const trades = [];
  for (const ts of timeline) {
    for (const [m, p] of Object.entries(pos)) {
      const cd = pool.get(m), i = cd.byTs.get(ts); if (i == null) continue;
      const px = cd.c[i]; p.held++;
      let reason = null, exit = px;
      const capStop = Math.max(p.stop, p.entry * (1 - stopCapPct / 100));
      if (cd.l[i] <= capStop) { reason = 'stop'; exit = Math.min(px, capStop); }
      else if (cd.h[i] >= p.target) { reason = 'target'; exit = p.target; }
      else if (p.held >= maxHold) { reason = 'maxhold'; exit = px; }
      if (reason) { const fill = exit * (1 - SLIP); cash += fill * p.qty * (1 - FEE); trades.push({ pnl: (fill - p.entry) * p.qty - (p.entry + fill) * p.qty * FEE }); delete pos[m]; }
    }
    if (regimeOk(ts, regimeMA) && Object.keys(pos).length < SLOTS) {
      const cands = [];
      for (const [m, cd] of pool) {
        const i = cd.byTs.get(ts); if (i == null || pos[m]) continue;
        if (avgTurn(cd, i) < MIN_TURN) continue;
        const s = scoreSignal(cd.c, cd.h, cd.l, cd.v, i);
        if (s && s.score >= minScore && s.rsi <= maxRsi && s.rr >= 1.5 && s.stopPct > 0) cands.push({ m, cd, i, s });
      }
      cands.sort((a, b) => b.s.score - a.s.score);
      for (const c of cands) { if (Object.keys(pos).length >= SLOTS) break; const budget = Math.floor(cash / (SLOTS - Object.keys(pos).length)); if (budget < 5000) break; const entry = c.cd.c[c.i] * (1 + SLIP); pos[c.m] = { entry, qty: budget * (1 - FEE) / entry, stop: c.s.stop, target: c.s.target, held: 0 }; cash -= budget; }
    }
  }
  const lt = timeline[timeline.length - 1];
  for (const [m, p] of Object.entries(pos)) { const cd = pool.get(m), i = cd.byTs.get(lt); const fill = (i != null ? cd.c[i] : p.entry) * (1 - SLIP); cash += fill * p.qty * (1 - FEE); trades.push({ pnl: (fill - p.entry) * p.qty }); }
  const wins = trades.filter(t => t.pnl > 0), gl = -trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0), gw = wins.reduce((s, t) => s + t.pnl, 0);
  return { n: trades.length, winRate: trades.length ? wins.length / trades.length : 0, pf: gl > 0 ? gw / gl : 99, ret: (cash / CAP - 1) * 100 };
}

// 그리드 (이번 사이클 탐색공간)
const GRID = [];
for (const minScore of [60, 70, 80])
  for (const maxRsi of [60, 70])
    for (const stopCapPct of [7, 10])
      for (const maxHold of [10, 20])
        for (const regimeMA of [50, 100])
          GRID.push({ minScore, maxRsi, stopCapPct, maxHold, regimeMA });

const cycle = existsSync(FINDINGS) ? readFileSync(FINDINGS, 'utf8').trim().split('\n').filter(Boolean).length + 1 : 1;
console.log(`=== 재귀 개선 사이클 #${cycle} — ${GRID.length}조합 train/valid 탐색 ===`);
const results = [];
for (const g of GRID) {
  const tr = backtest({ from: '20210101', to: '20241231', ...g });
  if (tr.pf <= 1.0 || tr.ret <= 0) continue; // train 미달 → 폐기
  const va = backtest({ from: '20250101', to: '20260718', ...g });
  results.push({ g, tr, va });
  console.log(`train PF ${tr.pf.toFixed(2)} ${tr.ret.toFixed(0)}% → valid PF ${va.pf.toFixed(2)} ${va.ret.toFixed(0)}% n${va.n} | ${JSON.stringify(g)}`);
}
const adopted = results.filter(r => r.va.pf >= 1.2 && r.va.ret > 0 && r.va.n >= 30);
console.log(`\ntrain통과 ${results.length} / valid승격후보 ${adopted.length}`);
if (adopted.length) { adopted.sort((a, b) => b.va.pf - a.va.pf); console.log('최우수:', JSON.stringify(adopted[0].g), 'valid PF', adopted[0].va.pf.toFixed(2), adopted[0].va.ret.toFixed(0) + '%'); }
else console.log('이번 사이클 승격후보 없음 — 현행 유지가 정답(과최적화 노이즈 배제)');
appendFileSync(FINDINGS, JSON.stringify({ cycle, ts: new Date().toISOString().slice(0, 16), grid: GRID.length, trainPass: results.length, adopted: adopted.length, best: adopted[0]?.g ?? null, bestValidPf: adopted[0]?.va.pf ?? null }) + '\n');
console.log('findings 기록:', FINDINGS);
