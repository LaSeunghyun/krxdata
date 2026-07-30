/**
 * mc-sectorcap.mjs — 섹터캡 MC + **노이즈 바닥 동시 측정** (2026-07-30)
 *
 * ═══ 왜 방식을 바꾸나 ═══
 * 오늘 혼돈 테스트 결과: 의미 없는 ±1틱 교란(12% 행)만으로 IS 10시드 MC Calmar가
 * 1.63~2.15로 흔들렸다. 스프레드 0.527 = 종가소스 차이(0.167)의 3.16배.
 * 교란은 실제 데이터 차이의 1/2.5 크기였으므로 **0.53은 측정오차의 하한**이다.
 * → 10시드 MC 하나로 |ΔCalmar| < 0.53 을 판정한 결과는 전부 노이즈 안이다.
 * → 이제부터 (1) 시드를 30으로 늘리고 (2) **같은 실행에서 교란 대조군으로 바닥을 재고**
 *    (3) ΔCalmar가 그 바닥을 넘을 때만 실질로 인정한다.
 *
 * ═══ 검정 대상 ═══
 * `--rotate` 는 오늘까지 **죽은 코드**였다(non-live-parity 분기에만 배선). 2026-07-30 배선 수정 후:
 *   off            CAGR 26.2% MDD 25.7% Calmar 1.02
 *   보수(0/3)      CAGR 31.2% MDD 22.4% Calmar 1.39   ← 양쪽 개선
 *   공격(2/1)      CAGR 15.4% MDD 30.1% Calmar 0.51   ← 사용자 제안, 단일경로 악화
 * 단일경로이므로 증거가 아니다.
 *
 * ═══ 판정 (결과 보기 전 선언) ═══
 *   NOISE = 교란 대조군 3벌 + 원본의 Calmar 스프레드 (같은 규칙 off, 데이터만 다름)
 *   어떤 규칙이든 |Calmar - off| > NOISE 여야 실질로 인정한다.
 *   그 조건을 통과한 것만 IS/OOS 분할 검증으로 올린다.
 *
 * 실행: node mc-rotate.mjs [--seeds 30] [--conc 4]
 */
import { exec } from 'child_process';
import { promisify } from 'util';
const pexec = promisify(exec);

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const NSEED = Number(argOf('--seeds', 30));
const CONC = Number(argOf('--conc', 4));
// 30시드 — 10시드는 노이즈 바닥이 너무 크다는 게 오늘 측정으로 드러났다.
const ALL_SEEDS = [101, 202, 303, 404, 505, 606, 707, 808, 909, 111,
  131, 151, 171, 191, 211, 231, 251, 271, 291, 311,
  331, 351, 371, 391, 411, 431, 451, 471, 491, 511];
const SEEDS = ALL_SEEDS.slice(0, NSEED);

const COMMON = '--no-freshness-check --from 20230102 --to 20260611';
const LIVE = '--strategies combo-v2 --live-parity --skipneutralrsi --slots 5 --trail 6 --tp1r 1 --tp2r 2 --liveuni 420 --rsivol 0';
const T = 'candles-daily-toss-clean.jsonl';

const CONFIGS = [
  // ── 규칙 축 (데이터 동일, 규칙만 다름) ──
  { key: 'off', name: 'off (섹터캡 없음)', file: T, extra: '', grp: 'rule' },
  { key: 'c1', name: '섹터캡 1 (구 기본값)', file: T, extra: '--sectorcap 1', grp: 'rule' },
  { key: 'c2', name: '섹터캡 2 ★배포후보', file: T, extra: '--sectorcap 2', grp: 'rule' },
  { key: 'c3', name: '섹터캡 3', file: T, extra: '--sectorcap 3', grp: 'rule' },
  // ── 노이즈 바닥 축 (규칙 동일 off, 데이터만 무해하게 교란) ──
  { key: 'n1', name: '[바닥] off · 교란데이터 #1', file: 'candles-pert-1.jsonl', extra: '', grp: 'noise' },
  { key: 'n2', name: '[바닥] off · 교란데이터 #2', file: 'candles-pert-2.jsonl', extra: '', grp: 'noise' },
  { key: 'n3', name: '[바닥] off · 교란데이터 #3', file: 'candles-pert-3.jsonl', extra: '', grp: 'noise' },
];

const RE = /^combo-v2\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.-]+)%\s+(\d+)%\s+([\d.]+)일/m;

async function runOne(cfg, seed) {
  const cmd = `node --max-old-space-size=6144 backtest-swing.mjs ${LIVE} --candles ${cfg.file} ${cfg.extra} ${COMMON} --subsample 0.8 --seed ${seed}`;
  try {
    const { stdout } = await pexec(cmd, { cwd: 'C:\\claudeT\\files', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const m = stdout.match(RE);
    if (!m) return null;
    return { n: +m[1], win: +m[2], pf: +m[3], cagr: +m[4], mdd: +m[5] };
  } catch (e) { console.error(`  ! ${cfg.key} seed${seed}: ${String(e.message).slice(0, 60)}`); return null; }
}
async function pool(tasks, n) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

console.log(`=== 섹터캡 ${SEEDS.length}시드 MC + 노이즈 바닥 동시측정 ===`);
console.log(`전기간 20230102~20260611 · 동일 코드집합 1,105종목 · subsample 0.8\n`);

const R = [];
for (const cfg of CONFIGS) {
  process.stdout.write(`[${cfg.key}] ${cfg.name} ... `);
  const rows = (await pool(SEEDS.map(s => () => runOne(cfg, s)), CONC)).filter(Boolean);
  const cagr = rows.map(r => r.cagr), mdd = rows.map(r => r.mdd);
  const cA = avg(cagr), mA = avg(mdd);
  R.push({ ...cfg, nSeed: rows.length, cagrs: cagr, cagrA: cA, cagrM: med(cagr), mddA: mA, calmar: mA > 0 ? cA / mA : 0, win: avg(rows.map(r => r.win)), pf: avg(rows.map(r => r.pf)), trades: avg(rows.map(r => r.n)) });
  console.log(`${rows.length}시드 · 체결 ${Math.round(avg(rows.map(r => r.n)))} · CAGR ${cA.toFixed(2)}% · MDD ${mA.toFixed(2)}% · Calmar ${(mA > 0 ? cA / mA : 0).toFixed(2)}`);
}

const off = R.find(r => r.key === 'off');
const noise = R.filter(r => r.grp === 'noise');
const floorSet = [off.calmar, ...noise.map(r => r.calmar)];
const NOISE = Math.max(...floorSet) - Math.min(...floorSet);

console.log('\n=== 결과 ===');
console.log('구성                              체결   CAGR(평균/중앙)   MDD     Calmar   Δ vs off');
console.log('─'.repeat(94));
for (const r of R) {
  const d = r.calmar - off.calmar;
  const mark = r.grp === 'noise' ? '   (바닥측정)' : (Math.abs(d) > NOISE ? (d > 0 ? '  ★실질개선' : '  ★실질악화') : '  (노이즈내)');
  console.log(`${r.name.padEnd(32)} ${String(Math.round(r.trades)).padStart(5)} ${(r.cagrA.toFixed(1) + '% / ' + r.cagrM.toFixed(1) + '%').padStart(16)} ${(r.mddA.toFixed(1) + '%').padStart(7)} ${r.calmar.toFixed(2).padStart(8)} ${((d >= 0 ? '+' : '') + d.toFixed(2)).padStart(8)}${mark}`);
}

console.log(`\n=== 노이즈 바닥 ===`);
console.log(`off + 교란 3벌 Calmar: ${floorSet.map(v => v.toFixed(2)).join(' / ')}`);
console.log(`NOISE (최대-최소) = ${NOISE.toFixed(3)}   ← ${SEEDS.length}시드 기준. 10시드에서는 0.527이었다.`);
console.log(`※ 교란 크기는 실제 데이터 차이의 약 1/2.5 → NOISE는 하한이다.`);

console.log(`\n=== 판정 ===`);
const rules = R.filter(r => r.grp === 'rule' && r.key !== 'off');
const real = rules.filter(r => Math.abs(r.calmar - off.calmar) > NOISE);
if (!real.length) console.log(`실질 효과 0건 — 모든 섹터캡 변종이 노이즈 바닥(${NOISE.toFixed(2)}) 안에 있다.`);
else for (const r of real.sort((a, b) => b.calmar - a.calmar)) {
  const w = r.cagrs.filter((v, i) => v > (off.cagrs[i] ?? Infinity)).length;
  console.log(`${r.calmar > off.calmar ? '개선' : '악화'} ${r.name}  Calmar ${off.calmar.toFixed(2)}→${r.calmar.toFixed(2)} (Δ${(r.calmar - off.calmar).toFixed(2)})  시드 CAGR ${w}승 ${r.cagrs.length - w}패`);
}
console.log(`\n※ 통과분은 IS/OOS 분할로 다시 검증해야 한다(프론티어 확인). 여기서 끝이 아니다.`);
