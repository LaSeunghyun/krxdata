/**
 * scen-matrix.mjs — 시나리오×구성 행렬 집계 (2026-07-29)
 *
 * backtest-swing.mjs --scendump 산출물(per-trade JSON)을 읽어
 * 진입일 시나리오(scenario-def.mjs 5×4)별 포지션 수익률을 구성 간 비교한다.
 *
 * 단위: **포지션**(code+진입일). 부분익절(tp_half 등)로 쪼개진 행을 합산해
 *   ret = Σpnl / Σ(entry×qty) 로 계산 — 행 단위 이중계산 방지.
 * 구간: IS = 진입일 ≤ --split (기본 20240920) / OOS = 그 이후. 임계·가설은 IS만으로 세운다.
 *
 * usage: node scen-matrix.mjs DIR [--split 20240920] [--scens T2V4,T3V1,...] [--base C1-base]
 */
import { readFileSync, readdirSync } from 'fs';

const argv = process.argv.slice(2);
const dir = argv[0];
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SPLIT = argOf('--split', '20240920');
const BASE = argOf('--base', 'C1-base');
const ONLY_SCENS = argOf('--scens', '').split(',').filter(Boolean);

function positionsOf(trades) {
  const map = new Map();
  for (const t of trades) {
    const k = `${t.code}|${t.eday}`;
    if (!map.has(k)) map.set(k, { scen: t.scen, sub: t.sub, eday: t.eday, cost: 0, pnl: 0, hold: 0 });
    const p = map.get(k);
    p.cost += t.entry * t.qty; p.pnl += t.pnl; p.hold = Math.max(p.hold, t.hold);
  }
  return [...map.values()].map(p => ({ ...p, ret: p.cost > 0 ? p.pnl / p.cost : 0 }));
}
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const variance = (a) => { if (a.length < 2) return NaN; const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); };
// Welch t (두 구성의 같은 시나리오 포지션 수익률 비교 — 표본은 다른 거래라 독립 2표본)
function welch(a, b) {
  if (a.length < 5 || b.length < 5) return null;
  const va = variance(a) / a.length, vb = variance(b) / b.length;
  if (!(va + vb > 0)) return null;
  const t = (mean(a) - mean(b)) / Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  return { t, df };
}

const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
const configs = {};
for (const f of files) {
  const d = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
  configs[f.replace('.json', '')] = positionsOf(d.trades['combo-v2']);
}
const names = Object.keys(configs);
if (!configs[BASE]) { console.error(`기준 구성 ${BASE} 없음`); process.exit(1); }

const allScens = [...new Set(Object.values(configs).flatMap(ps => ps.map(p => p.scen)))].filter(Boolean).sort();
const scens = ONLY_SCENS.length ? ONLY_SCENS : allScens;

const seg = (ps, scen, isOOS) => ps.filter(p => p.scen === scen && (isOOS ? p.eday > SPLIT : p.eday <= SPLIT));
const fmt = (v, w = 6) => (Number.isFinite(v) ? (v * 100).toFixed(2) : '-').padStart(w);

for (const period of ['IS', 'OOS']) {
  const isOOS = period === 'OOS';
  console.log(`\n=== ${period} (진입일 ${isOOS ? '>' : '≤'} ${SPLIT}) — 셀: 평균수익률%(n) ===`);
  console.log('scen  ' + names.map(n => n.replace(/^C\d+-/, '').padStart(13)).join(''));
  for (const scen of scens) {
    let row = scen.padEnd(6);
    for (const n of names) {
      const s = seg(configs[n], scen, isOOS);
      row += `${fmt(mean(s.map(p => p.ret)))}(${String(s.length).padStart(3)}) `.padStart(13);
    }
    console.log(row);
  }
}

// 기준 대비 Welch t (IS): |t|≥2 표시 — 다중비교(시나리오×구성) 보정 전 원값이므로 스크리닝 용도만
console.log(`\n=== IS Welch t vs ${BASE} (|t|≥2 → *) — 다중비교 보정 전, 스크리닝 전용 ===`);
console.log('scen  ' + names.filter(n => n !== BASE).map(n => n.replace(/^C\d+-/, '').padStart(12)).join(''));
for (const scen of scens) {
  const b = seg(configs[BASE], scen, false).map(p => p.ret);
  let row = scen.padEnd(6);
  for (const n of names) {
    if (n === BASE) continue;
    const a = seg(configs[n], scen, false).map(p => p.ret);
    const w = welch(a, b);
    row += (w ? `${w.t.toFixed(2)}${Math.abs(w.t) >= 2 ? '*' : ' '}` : '-').padStart(12);
  }
  console.log(row);
}

// 서브전략(hi120/rsi2) 분해 — 기준 구성만
console.log(`\n=== ${BASE} 서브전략 분해 (IS | OOS): 평균수익률%(n) ===`);
for (const scen of scens) {
  const parts = [];
  for (const sub of ['hi120', 'rsi2']) {
    const i = seg(configs[BASE], scen, false).filter(p => p.sub === sub);
    const o = seg(configs[BASE], scen, true).filter(p => p.sub === sub);
    parts.push(`${sub} ${fmt(mean(i.map(p => p.ret)))}(${String(i.length).padStart(3)}) | ${fmt(mean(o.map(p => p.ret)))}(${String(o.length).padStart(3)})`);
  }
  console.log(`${scen}  ${parts.join('   ')}`);
}
