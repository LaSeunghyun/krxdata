#!/usr/bin/env node
/**
 * mc-noise-floor.mjs — 노이즈 바닥 전용 측정 (2026-08-21)
 *
 * ═══ 왜 전용 스크립트인가 ═══
 * 기존 mc-*.mjs 는 규칙 arm 을 재면서 바닥을 **부수적으로** 같이 잰다(grp:'noise' 3벌).
 * autoresearch 루프는 규칙과 무관하게 **구간·시드수별 바닥값 자체**가 필요하다
 * (`autoresearch-floor.json` 이 pin 되기 전에는 --verify 가 어떤 keep 도 통과시키지 않는다).
 * 규칙 arm 을 같이 돌리면 필요 없는 계산에 시간의 절반 이상을 쓴다.
 *
 * ═══ 바닥 정의 (방법론 §1, mc-atrmax.mjs:88-90 과 동일) ═══
 *   교란본 = 랜덤 12% 행의 종가 ±1틱 (전체 행 기준 평균 |변화| 0.0156%) — 의미상 무해한 크기.
 *   floorSet = [원본 Calmar, 교란본 Calmar ...]
 *   NOISE    = max(floorSet) - min(floorSet)
 *   → |ΔCalmar| < NOISE 이면 판정 불가. 채택도 기각도 하지 않는다.
 *   교란 크기가 실제 데이터 차이의 약 1/2.5 라 이 값은 **하한**이다.
 *
 * ═══ 설정은 라이브 계약을 따른다 ═══
 * mc-volthrottle.mjs:117 · mc-concentration.mjs:63 과 동일한 LIVE 인자를 쓴다.
 * 갭정책(--gapaxis --scenpolicy)을 반드시 포함한다 — 라이브 stock-live.mjs gapPolicyToday() 가
 * 매일 trail 6→10 · tp 6/12→10/20 을 오버라이드하므로, 빼면 라이브가 아닌 전략을 기준선으로 삼는다.
 *
 * ⚠️ 방법론 §1-F: 이 스크립트 실행 중 다른 무거운 작업을 겹치지 말 것.
 *    arm 이 0시드로 죽으면 바닥이 쓰레기값(과거 실측 1.575)이 된다. 판정 전 시드 충원을 확인한다.
 *
 * 실행:
 *   node mc-noise-floor.mjs                          # 30시드 · 교란 3벌
 *   node mc-noise-floor.mjs --seeds 60 --perts 5     # 더 촘촘히
 *   node mc-noise-floor.mjs --write                  # autoresearch-floor.json 에 기록
 */
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const NSEED = Number(argOf('--seeds', '30'));
const NPERT = Number(argOf('--perts', '3'));
const CONC = Number(argOf('--conc', '2'));   // §1-F: 과거 사고가 conc3 + 병행작업이었다. 단독 conc2 가 처방.
const HEAP = Number(argOf('--heap', '4096'));
const FROM = argOf('--from', '20230102');
const TO = argOf('--to', '20260724');        // 방법론 §1-B: 폭락 포함 구간
const WRITE = argv.includes('--write');

// 시드 집합은 mc-volthrottle.mjs:92 과 동일 — 스크립트마다 달라지면 바닥값이 비교 불가해진다.
const ALL = [101, 202, 303, 404, 505, 606, 707, 808, 909, 111,
  131, 151, 171, 191, 211, 231, 251, 271, 291, 311,
  331, 351, 371, 391, 411, 431, 451, 471, 491, 511,
  531, 551, 571, 591, 611, 631, 651, 671, 691, 711,
  731, 751, 771, 791, 811, 831, 851, 871, 891, 911,
  931, 951, 971, 991, 1011, 1031, 1051, 1071, 1091, 1111];
if (NSEED > ALL.length) { console.error(`시드는 최대 ${ALL.length} 까지다`); process.exit(2); }
const SEEDS = ALL.slice(0, NSEED);

const T = 'candles-daily-toss-clean.jsonl';
const COMMON = ['--no-freshness-check', '--from', FROM, '--to', TO];
const GAPPOL = ['--gapaxis', '--scenpolicy', 'gap-pol.json'];
const LIVE = ['--strategies', 'combo-v2', '--live-parity', '--skipneutralrsi',
  '--slots', '5', '--trail', '6', '--tp1r', '1', '--tp2r', '2', '--liveuni', '420', '--rsivol', '0',
  ...GAPPOL];

// ★ --pertstart 로 다른 교란본 집합을 골라 **독립 복제**를 만든다.
//   backtest-swing 은 (파일, 시드) 결정론이라 같은 교란본으로 재실행하면 값이 글자 그대로 같다.
//   그건 복제가 아니다 — 0.268 이 "3회 독립 실행에서 재현" 이라고 기록된 것은 교란본을 바꿔 잰 것이다.
const PSTART = Number(argOf('--pertstart', '1'));
const ARMS = [
  { key: 'orig', name: '원본 (정제본)', file: T },
  ...Array.from({ length: NPERT }, (_, i) => ({
    key: `pert${PSTART + i}`, name: `교란 #${PSTART + i}`, file: `candles-pert-${PSTART + i}.jsonl`,
  })),
];

for (const arm of ARMS) {
  if (!existsSync(join(__dirname, arm.file))) {
    console.error(`파일 없음: ${arm.file}`);
    console.error(`  교란본 생성: node --max-old-space-size=4096 perturb-candles.mjs ${T} ${arm.file} <seed>`);
    process.exit(2);
  }
}

const RE = /^combo-v2\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.-]+)%\s+(\d+)%\s+([\d.]+)일/m;

function runOne(arm, seed) {
  return new Promise((resolve) => {
    const args = [`--max-old-space-size=${HEAP}`, 'backtest-swing.mjs',
      ...LIVE, '--candles', arm.file, ...COMMON, '--subsample', '0.8', '--seed', String(seed)];
    const p = spawn('node', args, { cwd: __dirname });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', () => { /* 진행로그는 버린다 */ });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const m = out.match(RE);
      resolve(m ? { n: +m[1], win: +m[2], pf: +m[3], cagr: +m[4], mdd: +m[5] } : null);
    });
  });
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); }
  }));
  return out;
}

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

console.log(`=== 노이즈 바닥 측정 ===`);
console.log(`구간 ${FROM}~${TO} · ${NSEED}시드 · subsample 0.8 · 교란 ${NPERT}벌 · conc ${CONC}`);
console.log(`설정 ${LIVE.join(' ')}`);
console.log(`※ 실행 중 다른 무거운 작업을 겹치지 말 것 (방법론 §1-F)\n`);

const R = [];
for (const arm of ARMS) {
  process.stdout.write(`[${arm.key}] ${arm.name.padEnd(14)} ... `);
  const rows = (await pool(SEEDS.map(s => () => runOne(arm, s)), CONC)).filter(Boolean);
  const cagrs = rows.map(r => r.cagr), mdds = rows.map(r => r.mdd);
  const cA = avg(cagrs), mA = avg(mdds);
  const calmar = mA > 0 ? cA / mA : 0;
  R.push({ ...arm, nSeed: rows.length, cagrs, mdds, cagrA: cA, mddA: mA, calmar });
  console.log(`${rows.length}/${NSEED}시드 · CAGR ${cA.toFixed(2)}% · MDD ${mA.toFixed(2)}% · Calmar ${calmar.toFixed(3)}`);
}

// ★ 시드 충원 확인 — mcMedianFinal 계열은 죽은 시드를 조용히 건너뛴다. 미달이면 바닥은 쓰레기값이다.
const short = R.filter(r => r.nSeed < NSEED);
if (short.length) {
  console.log('');
  console.log(`✗ 시드 미충원: ${short.map(r => `${r.key} ${r.nSeed}/${NSEED}`).join(' · ')}`);
  console.log('  바닥값을 신뢰할 수 없다. 다른 작업을 멈추고 재실행한다(방법론 §1-F).');
  process.exit(1);
}

const calmars = R.map(r => r.calmar);
const NOISE = Math.max(...calmars) - Math.min(...calmars);
const orig = R.find(r => r.key === 'orig');

console.log('');
console.log('=== 결과 ===');
console.log('arm            시드   CAGR      MDD      Calmar   Δ vs 원본');
console.log('─'.repeat(64));
for (const r of R) {
  const d = r.calmar - orig.calmar;
  console.log(`${r.name.padEnd(14)} ${String(r.nSeed).padStart(4)} ${(r.cagrA.toFixed(2) + '%').padStart(8)} ${(r.mddA.toFixed(2) + '%').padStart(8)} ${r.calmar.toFixed(3).padStart(8)} ${((d >= 0 ? '+' : '') + d.toFixed(3)).padStart(10)}`);
}
console.log('');
console.log(`노이즈 바닥 (Calmar 스프레드) = ${NOISE.toFixed(3)}`);
console.log(`  → |ΔCalmar| < ${NOISE.toFixed(3)} 이면 판정 불가. 채택도 기각도 하지 않는다.`);
console.log(`  → 교란 크기가 실제 데이터 차이의 약 1/2.5 라 이 값은 하한이다.`);

if (WRITE) {
  const floorFile = join(__dirname, 'autoresearch-floor.json');
  const floor = existsSync(floorFile) ? JSON.parse(readFileSync(floorFile, 'utf8')) : {};
  const key = `${FROM}_${TO}`;
  floor[key] = {
    [`calmar${NSEED}`]: Number(NOISE.toFixed(3)),
    measuredAt: argOf('--stamp', 'unstamped'),
    seeds: NSEED,
    perts: NPERT,
    origCalmar: Number(orig.calmar.toFixed(3)),
    armCalmars: Object.fromEntries(R.map(r => [r.key, Number(r.calmar.toFixed(3))])),
    config: LIVE.join(' '),
    candles: T,
  };
  writeFileSync(floorFile, JSON.stringify(floor, null, 2) + '\n');
  console.log(`\nautoresearch-floor.json 갱신: ${key}.calmar${NSEED} = ${NOISE.toFixed(3)}`);
}
