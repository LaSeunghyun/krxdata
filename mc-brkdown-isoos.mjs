/**
 * mc-brkdown-isoos.mjs — NEUTRAL hi120(J·K) 의 **IS/OOS 분할 검증** (2026-08-04)
 *
 * ═══ 왜 이게 관문인가 ═══
 * 전기간 60시드 MC 에서 J·K 가 노이즈 바닥을 명확히 넘었다:
 *   J(NEUTRAL 2) ΔCalmar +0.63 · 58승 2패 · CAGR 45.6→74.5%
 *   K(NEUTRAL 4) ΔCalmar +0.61 · **60승 0패** · CAGR 45.6→76.5%
 * 이 프로젝트에서 룰 축이 바닥을 넘은 건 위험축소 3건 외에 처음이다.
 *
 * 그런데 자체 기록에 일반 법칙이 있다(2026-07-29 목표수색 종결):
 *   **"OOS 에서 크게 이기는 값은 예외 없이 IS 에서 진다. 파라미터 공간에 양쪽에서 이기는 값은 없다."**
 *   실례 — rsiVol 1.5: OOS 5.20 / IS 0.31 · uni800: OOS 5.92 / IS 0.54 · caps C: 4.98 / 0.61
 * 전기간 단일 측정은 그 함정을 못 걸러낸다. **두 구간에서 모두 이겨야** 과최적화가 아니다.
 *
 * ═══ 분할 (임의성을 줄이려 사전에 선언하고 고정) ═══
 *   IS  = 20230102 ~ 20241231  (2년 · 횡보·조정 구간 포함)
 *   OOS = 20250102 ~ 20260724  (약 1.6년 · 최근 강세 + 07월 급락 포함)
 * 경계는 **연도 경계**로 잡는다 — 성과가 좋은 지점을 골라 자르면 그 자체가 과최적화다.
 * ※ 07-29 커밋의 IS/OOS 수치(IS Calmar ~0.93 / OOS ~3.81)와 구간이 다르므로 **절대값은 비교 불가**,
 *   비교 가능한 것은 "같은 구간 안에서 A 대비 J·K 가 이기는가" 뿐이다.
 *
 * ═══ 판정 (결과 보기 전 선언) ═══
 *   · IS·OOS **양쪽에서** ΔCalmar > 각 구간의 노이즈 바닥 → 과최적화 아님. 후보 확정.
 *   · 한쪽만 이기면 → **기각**(일반 법칙이 예측한 그대로다).
 *   · 바닥은 구간별로 새로 측정한다. 전기간 바닥 0.309 를 짧은 구간에 그대로 쓰면 안 된다
 *     (구간이 짧으면 시드 분산이 커져 바닥도 커진다).
 *   · 낙폭 꼬리(최대 MDD)는 별도로 보고만 한다 — 채택 여부는 사용자의 MDD 감수 범위 결정이다.
 *
 * 실행: node mc-brkdown-isoos.mjs [--seeds 30] [--conc 1]
 */
import { exec } from 'child_process';
import { promisify } from 'util';
const pexec = promisify(exec);

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const NSEED = Number(argOf('--seeds', 30));
const CONC = Number(argOf('--conc', 1));
const ALL_SEEDS = Array.from({ length: 90 }, (_, i) => 101 + i * 37);
const SEEDS = ALL_SEEDS.slice(0, NSEED);

const LIVE = '--strategies combo-v2 --live-parity --skipneutralrsi --slots 5 --trail 6 --tp1r 1 --tp2r 2 --liveuni 420 --rsivol 0 --stoppct 15';
const T = 'candles-daily-toss-clean.jsonl';
const FLOW = '--flowexit 0 --flowexitdays 10';

const WINDOWS = [
  { key: 'IS', span: '--from 20230102 --to 20241231' },
  { key: 'OOS', span: '--from 20250102 --to 20260724' },
];
const ARMS = [
  { key: 'A', name: '현행 A', extra: `${FLOW} --caps A`, grp: 'rule' },
  { key: 'J', name: 'J · NEUTRAL 2', extra: `${FLOW} --caps J --brkreg UP,NEUTRAL`, grp: 'rule' },
  { key: 'K', name: 'K · NEUTRAL 4', extra: `${FLOW} --caps K --brkreg UP,NEUTRAL`, grp: 'rule' },
  // 구간별 노이즈 바닥 — 현행 A 를 교란 캔들 3벌로 돌린 Calmar 스프레드
  { key: 'n1', name: '[바닥]#1', extra: `${FLOW} --caps A`, file: 'candles-pert-1.jsonl', grp: 'noise' },
  { key: 'n2', name: '[바닥]#2', extra: `${FLOW} --caps A`, file: 'candles-pert-2.jsonl', grp: 'noise' },
  { key: 'n3', name: '[바닥]#3', extra: `${FLOW} --caps A`, file: 'candles-pert-3.jsonl', grp: 'noise' },
];

const RE = /combo-v2\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.]+)%/;
const errBrief = (e) => {
  const se = String(e?.stderr ?? '').trim();
  if (se) return se.slice(0, 160);
  const m = String(e?.message ?? '').split(String.fromCharCode(10)).slice(1).join(' ').trim();
  return m ? m.slice(0, 160) : `code=${e?.code ?? '?'}`;
};
async function runOne(win, arm, seed, attempt = 0) {
  const cmd = `node --max-old-space-size=2048 backtest-swing.mjs ${LIVE} --candles ${arm.file ?? T} ${arm.extra} ${win.span} --no-freshness-check --subsample 0.8 --seed ${seed}`;
  try {
    const { stdout } = await pexec(cmd, { cwd: 'C:\\claudeT\\files', encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    const m = stdout.match(RE);
    if (!m) {
      if (attempt < 1) return runOne(win, arm, seed, attempt + 1);
      console.error(`  ! ${win.key}/${arm.key} seed${seed} 파싱실패`); return null;
    }
    return { n: +m[1], win: +m[2], cagr: +m[4], mdd: +m[5] };
  } catch (e) {
    if (attempt < 1) return runOne(win, arm, seed, attempt + 1);
    console.error(`  ! ${win.key}/${arm.key} seed${seed}: ${errBrief(e)}`); return null;
  }
}
async function pool(tasks, n) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

console.log(`=== NEUTRAL hi120 IS/OOS 분할 검증 · ${SEEDS.length}시드 ===`);
console.log(`IS  20230102~20241231 · OOS 20250102~20260724 · subsample 0.8`);
console.log(`판정: **양쪽 구간 모두** ΔCalmar > 구간별 바닥 이어야 채택 후보\n`);

const RES = {};
for (const win of WINDOWS) {
  RES[win.key] = [];
  console.log(`── ${win.key} (${win.span.replace(/--from |--to /g, '')}) ──`);
  for (const arm of ARMS) {
    process.stdout.write(`  [${arm.key}] ${arm.name.padEnd(14)} ... `);
    const rows = (await pool(SEEDS.map(s => () => runOne(win, arm, s)), CONC)).filter(Boolean);
    const cagr = rows.map(r => r.cagr), mdd = rows.map(r => r.mdd);
    const cA = avg(cagr), mA = avg(mdd);
    RES[win.key].push({ ...arm, nSeed: rows.length, cagrs: cagr, mdds: mdd, cagrA: cA, mddA: mA, calmar: mA > 0 ? cA / mA : 0, trades: avg(rows.map(r => r.n)) });
    console.log(`${rows.length}시드 · 체결 ${Math.round(avg(rows.map(r => r.n)))} · CAGR ${cA.toFixed(1)}% · MDD ${mA.toFixed(1)}% · Calmar ${(mA > 0 ? cA / mA : 0).toFixed(2)}`);
  }
  console.log('');
}

console.log('=== 구간별 판정 ===');
const verdict = {};
for (const win of WINDOWS) {
  const R = RES[win.key];
  const short = R.filter(r => r.nSeed < SEEDS.length);
  if (short.length) { console.log(`${win.key}: 🚨 시드 미충족 ${short.map(r => r.key + '(' + r.nSeed + ')').join(' ')} — 판정 불가`); verdict[win.key] = null; continue; }
  const base = R.find(r => r.key === 'A');
  const floor = R.filter(r => r.grp === 'noise').map(r => r.calmar).concat(base.calmar);
  const NOISE = Math.max(...floor) - Math.min(...floor);
  console.log(`\n${win.key} · 노이즈 바닥 ${NOISE.toFixed(3)} (현행+교란3: ${floor.map(v => v.toFixed(2)).join(' / ')})`);
  console.log(`  구성            체결   CAGR    MDD    Calmar   Δ        시드승패   최악CAGR  최대MDD`);
  console.log('  ' + '─'.repeat(86));
  verdict[win.key] = {};
  for (const r of R) {
    if (r.grp !== 'rule') continue;
    const d = r.calmar - base.calmar;
    const w = r.cagrs.filter((v, i) => v > (base.cagrs[i] ?? Infinity)).length;
    const pass = r.key !== 'A' && d > NOISE;
    verdict[win.key][r.key] = { d, pass, w };
    console.log(`  ${r.name.padEnd(15)} ${String(Math.round(r.trades)).padStart(5)} ${(r.cagrA.toFixed(1) + '%').padStart(7)} ${(r.mddA.toFixed(1) + '%').padStart(6)} ${r.calmar.toFixed(2).padStart(8)} ${((d >= 0 ? '+' : '') + d.toFixed(2)).padStart(8)} ${(r.key === 'A' ? '-' : w + '승 ' + (SEEDS.length - w) + '패').padStart(10)} ${(Math.min(...r.cagrs).toFixed(1) + '%').padStart(9)} ${(Math.max(...r.mdds).toFixed(1) + '%').padStart(8)}${r.key === 'A' ? '  (기준)' : pass ? '  ★통과' : '  미달'}`);
  }
}

console.log('\n=== 최종 판정 ===');
for (const k of ['J', 'K']) {
  const is = verdict.IS?.[k], oos = verdict.OOS?.[k];
  if (!is || !oos) { console.log(`  ${k}: 판정 불가(시드 미충족)`); continue; }
  const both = is.pass && oos.pass;
  console.log(`  ${k}: IS Δ${(is.d >= 0 ? '+' : '') + is.d.toFixed(2)}(${is.pass ? '통과' : '미달'}) · OOS Δ${(oos.d >= 0 ? '+' : '') + oos.d.toFixed(2)}(${oos.pass ? '통과' : '미달'}) → ${both ? '⭕ 양쪽 통과 — 과최적화 아님' : '❌ 한쪽만 — 일반법칙대로 기각'}`);
}
console.log(`\n※ 통과해도 라이브 이식은 3곳 변경(LIVE_COMBO_CAPS · live-parity breakRegimes 기본값 ·`);
console.log(`   stock-live 의 regime==='UP' 돌파계산 블록)이라 별도 리뷰 필수. 최대 MDD 확대는 사용자 결정 사항.`);
