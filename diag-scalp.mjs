/**
 * diag-scalp.mjs — 스캘핑 "전부 음수" 원인 분해 진단 (2026-07-25, 사용자 문제제기).
 *   질문: 비용 때문에 죽은 건가, 아니면 신호 자체에 예측력이 없는 건가?
 *   방법: 동일 신호·동일 청산으로 (a)비용포함 (b)비용0 (c)신호 무작위화(대조군) 비교.
 *         비용0에서도 음수면 = 신호에 엣지 없음. 비용0에서 양수면 = 비용 문제.
 */
import { readFileSync } from 'fs';
import { calcRoundTripPnl } from './execution-model.mjs';

const ema = (v, p) => { const k = 2 / (p + 1); const o = [v[0]]; for (let i = 1; i < v.length; i++) o.push(v[i] * k + o[i - 1] * (1 - k)); return o; };
const dayKey = (ts) => ts.slice(0, 10);

function prep(bars) {
  const cd = [...bars].reverse();
  const close = cd.map(b => b.close), vol = cd.map(b => b.volume);
  const e9 = ema(close, 9), e21 = ema(close, 21);
  const vwap = []; let pv = 0, v = 0, cur = null;
  for (let i = 0; i < cd.length; i++) {
    const dk = dayKey(cd[i].timestamp);
    if (dk !== cur) { cur = dk; pv = 0; v = 0; }
    const tp = (cd[i].high + cd[i].low + cd[i].close) / 3;
    pv += tp * vol[i]; v += vol[i];
    vwap.push(v > 0 ? pv / v : close[i]);
  }
  return { cd, e9, e21, vwap };
}

/** mode: 'signal' = VWAP+EMA크로스, 'random' = 같은 횟수만큼 무작위 진입(대조군) */
function run(prepped, { stopPct, targetPct, maxHold, feeBps, taxBps, mode = 'signal', seed = 1 }) {
  const { cd, e9, e21, vwap } = prepped;
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const trades = [];
  let i = 21;
  while (i < cd.length - 1) {
    const sig = mode === 'signal'
      ? (e9[i - 1] <= e21[i - 1] && e9[i] > e21[i] && cd[i].close > vwap[i])
      : (rnd() < 0.02); // 대조군: 무작위 진입(빈도 유사)
    if (sig && dayKey(cd[i].timestamp) === dayKey(cd[i + 1].timestamp)) {
      const entry = cd[i + 1].open;
      const stopPx = entry * (1 - stopPct / 100), tgtPx = entry * (1 + targetPct / 100);
      let exitPx = null, reason = null, hold = 0;
      for (let j = i + 1; j < cd.length && j <= i + 1 + maxHold; j++) {
        if (dayKey(cd[j].timestamp) !== dayKey(cd[i + 1].timestamp)) { exitPx = cd[j - 1].close; reason = 'day_end'; hold = j - 1 - i; break; }
        if (cd[j].low <= stopPx) { exitPx = stopPx; reason = 'stop'; hold = j - i; break; }
        if (cd[j].high >= tgtPx) { exitPx = tgtPx; reason = 'target'; hold = j - i; break; }
        if (j === i + 1 + maxHold) { exitPx = cd[j].close; reason = 'timeout'; hold = j - i; }
      }
      if (exitPx != null) {
        const grossPct = (exitPx / entry - 1) * 100;
        const netPct = (calcRoundTripPnl({ entry, exit: exitPx, qty: 1, feeBps, taxBps }) / entry) * 100;
        trades.push({ grossPct, netPct, reason, hold });
        i = i + 1 + hold; continue;
      }
    }
    i++;
  }
  return trades;
}

const data = JSON.parse(readFileSync('./candles-1m-smoketest.json', 'utf8')).map(d => ({ name: d.name, p: prep(d.bars) }));
const CFG = { stopPct: 0.4, targetPct: 0.7, maxHold: 10 };
const agg = (t, key) => { const v = t.map(x => x[key]); return { n: t.length, sum: v.reduce((a, b) => a + b, 0), avg: v.reduce((a, b) => a + b, 0) / (v.length || 1), win: v.filter(x => x > 0).length / (v.length || 1) * 100 }; };

console.log('=== 스캘핑 원인분해 (손절-0.4%/목표+0.7%/최대10분) ===\n');
for (const [label, fee, tax] of [['비용 포함(수수료1.5bp×2+거래세20bp)', 1.5, 20], ['비용 0 (신호 순수 예측력)', 0, 0]]) {
  let all = [];
  for (const d of data) all = all.concat(run(d.p, { ...CFG, feeBps: fee, taxBps: tax }));
  const g = agg(all, 'grossPct'), n = agg(all, 'netPct');
  console.log(`${label}`);
  console.log(`  체결 ${n.n} | 순(net) 평균 ${n.avg.toFixed(4)}%/거래 · 합계 ${n.sum.toFixed(1)}% | 승률 ${n.win.toFixed(1)}%`);
  console.log(`  총(gross) 평균 ${g.avg.toFixed(4)}%/거래 · 합계 ${g.sum.toFixed(1)}%`);
  const byR = {}; for (const t of all) byR[t.reason] = (byR[t.reason] || 0) + 1;
  console.log(`  청산: ${Object.entries(byR).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
  console.log();
}

// 대조군: 무작위 진입 (비용0). 신호가 무작위보다 나은가?
console.log('=== 대조군: 무작위 진입(비용0) — 신호가 무작위보다 나은가 ===');
for (const seed of [1, 2, 3]) {
  let all = [];
  for (const d of data) all = all.concat(run(d.p, { ...CFG, feeBps: 0, taxBps: 0, mode: 'random', seed }));
  const g = agg(all, 'grossPct');
  console.log(`  seed${seed}: 체결 ${g.n} | gross 평균 ${g.avg.toFixed(4)}%/거래 | 승률 ${g.win.toFixed(1)}%`);
}

// 이 종목군이 10분 안에 ±0.7% 움직이는 빈도 자체 (신호 무관, 시장 특성)
console.log('\n=== 시장 특성: 임의 시점에서 10분내 ±0.7% 도달 빈도 ===');
let hitT = 0, hitS = 0, none = 0, tot = 0;
for (const d of data) {
  const cd = d.p.cd;
  for (let i = 21; i < cd.length - 12; i += 7) {
    const entry = cd[i + 1].open; if (!entry) continue;
    const t = entry * 1.007, s = entry * 0.996;
    let r = 'none';
    for (let j = i + 1; j <= i + 11 && j < cd.length; j++) {
      if (dayKey(cd[j].timestamp) !== dayKey(cd[i + 1].timestamp)) break;
      if (cd[j].low <= s) { r = 'stop'; break; }
      if (cd[j].high >= t) { r = 'target'; break; }
    }
    tot++; if (r === 'target') hitT++; else if (r === 'stop') hitS++; else none++;
  }
}
console.log(`  표본 ${tot} | 목표(+0.7%) 선도달 ${(hitT/tot*100).toFixed(1)}% | 손절(-0.4%) 선도달 ${(hitS/tot*100).toFixed(1)}% | 둘다미달 ${(none/tot*100).toFixed(1)}%`);
