/**
 * scen-interaction.mjs — 시나리오 특이 효과(상호작용) 분리 + MC 시드별 델타 집계 (2026-07-29)
 *
 * 질문: 구성 X의 시나리오 S 우위가 **시나리오 특이**인가, 전역 주효과의 희석인가?
 *   interaction I(X,S) = [mean(X,S) - mean(base,S)] - [mean(X,¬S) - mean(base,¬S)]
 *   I > 0 이어야 "시나리오별 차별화"의 근거가 된다. 전역 주효과는 이미 기각된 축이다.
 *
 * 모드1 (행렬 덤프 디렉터리): node scen-interaction.mjs DIR --base C1-base --pairs "C7-trail10:T3V1,C5-vol125:T2V4"
 * 모드2 (MC 디렉터리):        node scen-interaction.mjs MCDIR --mc --pairs "trail10:T3V1,vol125:T2V4" --seeds 10
 *   MC 파일명 규약: <config>-s<seed>.json / 기준은 base-s<seed>.json
 */
import { readFileSync } from 'fs';

const argv = process.argv.slice(2);
const dir = argv[0];
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SPLIT = argOf('--split', '20240920');
const PAIRS = argOf('--pairs', '').split(',').filter(Boolean).map(s => { const [c, scen] = s.split(':'); return { c, scen }; });
const MC = argv.includes('--mc');
const SEEDS = Number(argOf('--seeds', 10));

function positionsOf(trades) {
  const map = new Map();
  for (const t of trades) {
    const k = `${t.code}|${t.eday}`;
    if (!map.has(k)) map.set(k, { scen: t.scen, sub: t.sub, eday: t.eday, cost: 0, pnl: 0 });
    const p = map.get(k);
    p.cost += t.entry * t.qty; p.pnl += t.pnl;
  }
  return [...map.values()].map(p => ({ ...p, ret: p.cost > 0 ? p.pnl / p.cost : 0 }));
}
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const load = (f) => positionsOf(JSON.parse(readFileSync(`${dir}/${f}.json`, 'utf8')).trades['combo-v2']);
const segRet = (ps, scen, isOOS, inScen = true) =>
  ps.filter(p => (inScen ? p.scen === scen : p.scen !== scen) && (isOOS ? p.eday > SPLIT : p.eday <= SPLIT)).map(p => p.ret);

function deltas(cfgPs, basePs, scen, isOOS) {
  const dIn = mean(segRet(cfgPs, scen, isOOS)) - mean(segRet(basePs, scen, isOOS));
  const dOut = mean(segRet(cfgPs, scen, isOOS, false)) - mean(segRet(basePs, scen, isOOS, false));
  return { dIn, dOut, inter: dIn - dOut };
}
const f = (v) => (Number.isFinite(v) ? ((v >= 0 ? '+' : '') + (v * 100).toFixed(2)) : '  -').padStart(7);

if (!MC) {
  const base = load(argOf('--base', 'C1-base'));
  console.log('구성:시나리오       구간   시나리오내Δ  시나리오외Δ  상호작용(내-외)');
  for (const { c, scen } of PAIRS) {
    const ps = load(c);
    for (const period of ['IS', 'OOS']) {
      const { dIn, dOut, inter } = deltas(ps, base, scen, period === 'OOS');
      console.log(`${(c + ':' + scen).padEnd(20)} ${period.padEnd(4)} ${f(dIn)}pp    ${f(dOut)}pp    ${f(inter)}pp`);
    }
  }
} else {
  // MC: 시드별 시나리오내 델타·상호작용 → 부호 일관성 카운트 (사전 등록 기준: IS·OOS 각각 ≥8/10 시드 델타 양수)
  for (const { c, scen } of PAIRS) {
    console.log(`\n=== ${c} @ ${scen} — 10시드 MC (subsample 0.8) ===`);
    console.log('seed   IS 시나리오내Δ   IS상호작용   OOS 시나리오내Δ   OOS상호작용');
    const cnt = { isIn: 0, isInter: 0, oosIn: 0, oosInter: 0 };
    let n = 0;
    for (let s = 1; s <= SEEDS; s++) {
      let ps, base;
      try { ps = load(`${c}-s${s}`); base = load(`base-s${s}`); } catch { continue; }
      n++;
      const i = deltas(ps, base, scen, false), o = deltas(ps, base, scen, true);
      if (i.dIn > 0) cnt.isIn++; if (i.inter > 0) cnt.isInter++;
      if (o.dIn > 0) cnt.oosIn++; if (o.inter > 0) cnt.oosInter++;
      console.log(`s${String(s).padEnd(4)} ${f(i.dIn)}pp      ${f(i.inter)}pp    ${f(o.dIn)}pp       ${f(o.inter)}pp`);
    }
    console.log(`부호 양성: IS내 ${cnt.isIn}/${n} · IS상호 ${cnt.isInter}/${n} · OOS내 ${cnt.oosIn}/${n} · OOS상호 ${cnt.oosInter}/${n}  (통과 기준: IS내·OOS내 각 ≥8/10)`);
  }
}
