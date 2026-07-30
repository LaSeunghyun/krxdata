/**
 * mc-chaos.mjs — 경로 혼돈 민감도: 무해한 교란이 Calmar를 얼마나 흔드나 (2026-07-30)
 *
 * ═══ 검정할 질문 ═══
 * 종가소스 MC의 IS 결과(Toss 1.67 vs KRX 1.50 · 시드 3승7패)가 **실질 차이인가 노이즈인가.**
 * IS 구간 두 데이터셋은 종가 완전일치 88~91%, 전체행 평균|괴리| 0.030~0.041%로 사실상 같다
 * (NXT가 2025년부터라 IS는 거의 NXT 이전). 그래서 그 차이가 경로 혼돈일 가능성이 있다.
 *
 * ═══ 방법 ═══
 * Toss 정제본에 **의미 없는 교란**(랜덤 12% 행의 종가 ±1틱, 전체행 기준 평균 0.0156%)을
 * 서로 다른 시드로 4벌 만들어 같은 IS 10시드 MC를 돌린다.
 * 교란 크기는 실제 IS 괴리의 약 1/2.5 = **보수적으로 작다.**
 *
 * ═══ 판정 (결과 보기 전 선언) ═══
 * 교란 4벌의 Calmar 스프레드(최대-최소)를 D_chaos, |1.67-1.50| = 0.17 을 D_source 라 하면
 *   · D_chaos >= D_source  → IS 결과는 노이즈. 종가소스 IS 판정 무효.
 *                            + 이 세션 45개 변종 기각 판정들도 재검토 대상.
 *   · D_chaos < D_source/2 → IS 결과는 실질. 종가소스 IS 판정 유효.
 *   · 그 사이            → 미확정. 시드를 늘려야 한다.
 *
 * 실행: node mc-chaos.mjs [--seeds 10] [--conc 4]
 */
import { exec } from 'child_process';
import { promisify } from 'util';
const pexec = promisify(exec);

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const NSEED = Number(argOf('--seeds', 10));
const CONC = Number(argOf('--conc', 4));
const SEEDS = [101, 202, 303, 404, 505, 606, 707, 808, 909, 111].slice(0, NSEED);

const COMMON = '--no-freshness-check';
const LIVE = '--strategies combo-v2 --live-parity --skipneutralrsi --slots 5 --trail 6 --tp1r 1 --tp2r 2 --liveuni 420 --rsivol 0';
// 기본은 IS 구간(축퇴된 비교가 일어난 곳). --from/--to 로 바꿀 수 있다.
const WIN = `--from ${argOf('--from', '20230102')} --to ${argOf('--to', '20240920')}`;

const CONFIGS = [
  { key: 'base', name: 'Toss 원본(교란 없음)', file: 'candles-daily-toss-clean.jsonl' },
  { key: 'p1', name: 'Toss 교란 #1', file: 'candles-pert-1.jsonl' },
  { key: 'p2', name: 'Toss 교란 #2', file: 'candles-pert-2.jsonl' },
  { key: 'p3', name: 'Toss 교란 #3', file: 'candles-pert-3.jsonl' },
  { key: 'p4', name: 'Toss 교란 #4', file: 'candles-pert-4.jsonl' },
  { key: 'krx', name: 'KRX 정규장(참조)', file: 'candles-daily-krx-clean.jsonl' },
];

const RE = /^combo-v2\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.-]+)%\s+(\d+)%\s+([\d.]+)일/m;

async function runOne(cfg, seed) {
  const cmd = `node --max-old-space-size=6144 backtest-swing.mjs ${LIVE} --candles ${cfg.file} ${WIN} ${COMMON} --subsample 0.8 --seed ${seed}`;
  try {
    const { stdout } = await pexec(cmd, { cwd: 'C:\\claudeT\\files', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const m = stdout.match(RE);
    if (!m) { console.error(`  ! ${cfg.key} seed${seed}: 파싱 실패`); return null; }
    return { n: +m[1], win: +m[2], pf: +m[3], cagr: +m[4], mdd: +m[5] };
  } catch (e) { console.error(`  ! ${cfg.key} seed${seed}: ${String(e.message).slice(0, 70)}`); return null; }
}
async function pool(tasks, n) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

console.log(`=== 경로 혼돈 민감도 · IS구간 ${SEEDS.length}시드 MC ===`);
console.log(`교란: 랜덤 12% 행 종가 ±1틱 (전체행 평균 0.0156% — 실제 IS 괴리 0.030~0.041%의 약 1/2.5)\n`);

const R = [];
for (const cfg of CONFIGS) {
  process.stdout.write(`[${cfg.key}] ${cfg.name} ... `);
  const rows = (await pool(SEEDS.map(s => () => runOne(cfg, s)), CONC)).filter(Boolean);
  const cagr = rows.map(r => r.cagr), mdd = rows.map(r => r.mdd);
  const cA = avg(cagr), mA = avg(mdd);
  R.push({ ...cfg, nSeed: rows.length, cagrs: cagr, cagrA: cA, mddA: mA, calmar: mA > 0 ? cA / mA : 0, trades: avg(rows.map(r => r.n)) });
  console.log(`${rows.length}/${SEEDS.length}시드 · 체결 ${Math.round(avg(rows.map(r => r.n)))} · CAGR ${cA.toFixed(2)}% · MDD ${mA.toFixed(2)}% · Calmar ${(mA > 0 ? cA / mA : 0).toFixed(2)}`);
}

console.log('\n=== 결과 ===');
console.log('구성                    체결   CAGR평균   MDD평균   Calmar');
console.log('─'.repeat(60));
for (const r of R) console.log(`${r.name.padEnd(22)} ${String(Math.round(r.trades)).padStart(5)} ${(r.cagrA.toFixed(2) + '%').padStart(9)} ${(r.mddA.toFixed(2) + '%').padStart(9)} ${r.calmar.toFixed(2).padStart(8)}`);

const base = R.find(r => r.key === 'base');
const perts = R.filter(r => r.key.startsWith('p'));
const krx = R.find(r => r.key === 'krx');
const pcal = perts.map(r => r.calmar);
const allTossCal = [base.calmar, ...pcal];      // 원본+교란 = 모두 "같은 진실"의 표현
const dChaos = Math.max(...allTossCal) - Math.min(...allTossCal);
const dSource = Math.abs(base.calmar - krx.calmar);

console.log(`\n=== 판정 ===`);
console.log(`교란 Calmar: ${allTossCal.map(v => v.toFixed(2)).join(' / ')}`);
console.log(`D_chaos  (원본+교란 4벌의 Calmar 최대-최소) = ${dChaos.toFixed(3)}`);
console.log(`D_source (Toss vs KRX Calmar 차)          = ${dSource.toFixed(3)}`);
console.log(`비율 D_chaos / D_source = ${(dChaos / dSource).toFixed(2)}`);
console.log('');
if (dChaos >= dSource) {
  console.log(`★ 노이즈 확정 — 무해한 교란만으로 종가소스 차이 이상이 흔들린다.`);
  console.log(`  → 종가소스 IS 판정은 무효다. 그리고 더 중요한 것:`);
  console.log(`  → 이 세션에서 10시드 MC 하나로 기각한 변종들 중 |ΔCalmar| < ${dChaos.toFixed(2)} 인 건 전부 재검토 대상이다.`);
} else if (dChaos < dSource / 2) {
  console.log(`실질 차이 — 교란 스프레드가 소스 차이의 절반 미만이다. IS 판정 유효.`);
} else {
  console.log(`미확정 — 교란 스프레드가 소스 차이의 절반~1배 사이. 시드를 늘려야 한다.`);
}
console.log(`\n※ 교란은 실제 IS 괴리보다 2.5배 작다 → D_chaos는 실제 측정오차의 하한이다.`);
