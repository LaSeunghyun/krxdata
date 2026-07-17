#!/usr/bin/env node
/**
 * backtest-crypto-novel.mjs — 미검증 신호 패밀리 3종: 크로스섹셔널 로테이션 / 낙폭 반전 / 그리드
 *   기존 하네스(개별 종목 절대신호)와 달리 상대강도·인벤토리 전략이라 별도 경량 시뮬레이터.
 *   데이터: candles-crypto-60m.jsonl (1시간봉, 메이저 6종, 2025-01~2026-07)
 *   비용: 수수료 5bp + 슬리피지 5bp per side (스위치 1회 = 매도+매수 = 0.2%)
 *   판정: train 2025 / valid 2026 분리, 총수익·MDD·BTC 보유(B&H) 대비. 사전 기각: train 총수익 < BTC B&H AND 절대 음수.
 *
 * 실행: node backtest-crypto-novel.mjs [--from 20250101 --to 20251231]
 */
import { existsSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const FROM = argOf('--from', '20250101');
const TO = argOf('--to', '20251231');
const CAPITAL = 10_000_000;
const FEE = 0.0005, SLIP = 0.0005; // per side
const MARKETS = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE', 'KRW-ADA'];
const dayOf = (ts) => ts.slice(0, 10).replace(/-/g, '');

// ── 데이터 로드 (마켓당 마지막 레코드 우선) ──────────────────────
const pool = new Map();
{
  const rl = createInterface({ input: createReadStream(join(__dirname, 'candles-crypto-60m.jsonl')), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); pool.set(r.market, r); } catch {}
  }
}
const btc = pool.get('KRW-BTC');
const simIdx = [];
for (let i = 0; i < btc.d.length; i++) if (dayOf(btc.d[i]) >= FROM && dayOf(btc.d[i]) <= TO) simIdx.push(i);
const byTs = new Map();
for (const m of MARKETS) {
  const cd = pool.get(m);
  byTs.set(m, new Map(cd.d.map((t, i) => [t, i])));
}
const px = (m, ts) => { const i = byTs.get(m).get(ts); return i == null ? null : pool.get(m).c[i]; };
const pxAgo = (m, ts, back) => { const i = byTs.get(m).get(ts); return i == null || i < back ? null : pool.get(m).c[i - back]; };

const bhStart = btc.c[simIdx[0]], bhEnd = btc.c[simIdx[simIdx.length - 1]];
console.log(`=== 신규 패밀리 백테스트 ${FROM}~${TO} | 1h봉 ${simIdx.length}개 | BTC B&H ${((bhEnd / bhStart - 1) * 100).toFixed(1)}% ===`);

// ── 1) 크로스섹셔널 로테이션 / 낙폭 반전 ─────────────────────────
function runRotation({ mode, lookback, rebalance, riskOff }) {
  let cash = CAPITAL, held = null, qty = 0, switches = 0;
  let peak = CAPITAL, maxDD = 0;
  const monthly = new Map();
  let lastEq = CAPITAL, lastDay = '';
  for (let k = 0; k < simIdx.length; k++) {
    const ts = btc.d[simIdx[k]];
    const day = dayOf(ts);
    const eqNow = () => cash + (held ? (px(held, ts) ?? 0) * qty : 0);
    if (k % rebalance === 0) {
      const rets = MARKETS.map(m => {
        const c = px(m, ts), p = pxAgo(m, ts, lookback);
        return { m, r: c != null && p != null ? c / p - 1 : null };
      }).filter(x => x.r != null);
      if (rets.length) {
        rets.sort((a, b) => b.r - a.r);
        const pick = mode === 'mom' ? rets[0] : rets[rets.length - 1];
        const target = (riskOff && pick.r <= 0) ? null : pick.m;
        if (target !== held) {
          if (held) { const p = px(held, ts); if (p != null) { cash += p * qty * (1 - FEE - SLIP); qty = 0; held = null; } }
          if (target) { const p = px(target, ts); if (p != null) { qty = cash * (1 - FEE - SLIP) / p; cash = 0; held = target; switches++; } }
        }
      }
    }
    const eq = eqNow();
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, (peak - eq) / peak * 100);
    if (day !== lastDay) {
      const mon = day.slice(0, 6);
      if (!monthly.has(mon)) monthly.set(mon, { start: lastEq, end: eq });
      monthly.get(mon).end = eq;
      lastEq = eq; lastDay = day;
    }
  }
  const lastTs = btc.d[simIdx[simIdx.length - 1]];
  if (held) { const p = px(held, lastTs); if (p != null) cash += p * qty * (1 - FEE - SLIP); }
  const months = [...monthly.values()];
  const monWin = months.length ? Math.round(months.filter(mm => mm.end > mm.start).length / months.length * 100) : 0;
  return { ret: (cash / CAPITAL - 1) * 100, maxDD, switches, monWin };
}

console.log('\n[1] 크로스섹셔널 로테이션 (mom=상대강자 보유 / rev=상대약자 보유, riskOff=음수면 현금)');
console.log('config                                수익률    MDD    스위치  월승률');
for (const mode of ['mom', 'rev']) {
  for (const lookback of [24, 96]) {
    for (const rebalance of [4, 24]) {
      const r = runRotation({ mode, lookback, rebalance, riskOff: mode === 'mom' });
      const tag = `${mode} L=${lookback}h R=${rebalance}h${mode === 'mom' ? ' riskOff' : ''}`;
      console.log(`ROT ${tag.padEnd(32)} ${r.ret.toFixed(1).padStart(7)}%  ${r.maxDD.toFixed(1).padStart(5)}%  ${String(r.switches).padStart(5)}  ${String(r.monWin).padStart(4)}%`);
    }
  }
}

// ── 2) 그리드 (택소노미 종결용 — 하락장 기각 예상) ────────────────
function runGrid(market, stepPct, gridN = 10) {
  const cd = pool.get(market);
  const idxs = simIdx.map(i => byTs.get(market).get(btc.d[i])).filter(i => i != null);
  const base = cd.c[idxs[0]];
  let cash = CAPITAL, inv = 0; // inv = 코인 수량
  const lotCash = CAPITAL / gridN;
  const bought = new Map(); // level → qty (하방 매수 보유)
  for (const i of idxs) {
    const c = cd.c[i];
    const lvl = Math.floor(Math.log(c / base) / Math.log(1 - stepPct / 100)); // 하방 레벨 수
    // 매수: 현재가가 새 하방 레벨 진입 & 해당 레벨 미보유 & 현금 있음
    for (let L = 1; L <= gridN; L++) {
      const levelPx = base * Math.pow(1 - stepPct / 100, L);
      if (c <= levelPx && !bought.has(L) && cash >= lotCash) {
        const q = lotCash * (1 - FEE - SLIP) / c;
        cash -= lotCash; inv += q; bought.set(L, { q, entry: c });
      }
    }
    // 매도: 보유 레벨의 entry 대비 +stepPct 도달 시 해당 랏 청산
    for (const [L, lot] of bought) {
      if (c >= lot.entry * (1 + stepPct / 100)) {
        cash += c * lot.q * (1 - FEE - SLIP); inv -= lot.q; bought.delete(L);
      }
    }
  }
  const lastC = cd.c[idxs[idxs.length - 1]];
  const eq = cash + inv * lastC * (1 - FEE - SLIP);
  return { ret: (eq / CAPITAL - 1) * 100, openLots: bought.size };
}

console.log('\n[2] 그리드 (10랏, 레벨당 자본 10%)');
for (const market of ['KRW-BTC', 'KRW-ETH']) {
  for (const step of [1, 2]) {
    const r = runGrid(market, step);
    console.log(`GRID ${market} step=${step}%  수익률 ${r.ret.toFixed(1)}%  미청산랏 ${r.openLots}/10`);
  }
}
console.log(`\n벤치마크: BTC B&H ${((bhEnd / bhStart - 1) * 100).toFixed(1)}% | 기각기준: train 절대 음수 AND B&H 이하`);
