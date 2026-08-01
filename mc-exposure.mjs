/**
 * mc-exposure.mjs — 2026-07-30 세션 노출축 검정 (30시드 MC + 노이즈 바닥 동시측정)
 *
 * ★ 구간을 20260724 까지 쓴다. commit 1965233 의 헤드라인 발견 =
 *   "--to 20260611 은 폭락이 없어 방어·노출 장치의 검정이 성립하지 않는다".
 *   노출 축은 폭락에서만 의미가 있으므로 필수.
 *
 * 검정 대상
 *   B-4 동점 랭킹 : 확신도 동률(폭락일엔 RSI2=0 이 수십 종목) 내 재정렬.
 *                   현행 tie-break 은 우연히 **시가총액 순서**다(stock_analysis ORDER BY market_cap DESC).
 *   B-5 일일 상한 : 하루 신규진입 건수 상한 (--maxnew, 이 세션 신규 구현)
 *   B-3 확인사격  : --rsimaxdd20 50 이 정말 전 시드에서 기준선과 동일한가
 *
 * 판정: |ΔCalmar| > 노이즈바닥 이어야 실질. 아니면 "미통과"로 적는다.
 *
 * ⚠️ 2026-07-30 실측 함정 2건 (둘 다 이 파일에서 당했다)
 *   ① promisify(exec) 는 셸(cmd.exe) 경유라 ComSpec 없는 환경에서 300회 전량 ENOENT.
 *      → execFile 로 node 직접 실행.
 *   ② 그런데도 하네스가 0 으로 채운 결과표를 정상처럼 출력했다.
 *      → 아래 0시드 가드로 하드 중단. **표가 나왔다 = 데이터가 있었다** 가 아니다.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
const pexecFile = promisify(execFile);

const CWD = String.raw`C:\claudeT\files`;
const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const NSEED = Number(argOf('--seeds', 30));
const CONC = Number(argOf('--conc', 4));
const ALL = [101, 202, 303, 404, 505, 606, 707, 808, 909, 111,
  131, 151, 171, 191, 211, 231, 251, 271, 291, 311,
  331, 351, 371, 391, 411, 431, 451, 471, 491, 511];
const SEEDS = ALL.slice(0, NSEED);

const COMMON = ['--no-freshness-check', '--from', '20230102', '--to', '20260724'];
const LIVE = ['--strategies', 'combo-v2', '--live-parity', '--skipneutralrsi',
  '--slots', '5', '--trail', '6', '--tp1r', '1', '--tp2r', '2', '--liveuni', '420', '--rsivol', '0'];
const T = 'candles-daily-toss-clean.jsonl';

const CONFIGS = [
  { key: 'base',    name: '현행(동점=시총순·상한없음)',   file: T, extra: [],                      grp: 'rule' },
  { key: 'mr_asc',  name: 'B4 동점: MA거리 작은것 우선',  file: T, extra: ['--rsimarank', 'asc'],  grp: 'rule' },
  { key: 'mr_desc', name: 'B4 동점: MA거리 큰것 우선',    file: T, extra: ['--rsimarank', 'desc'], grp: 'rule' },
  { key: 'new1',    name: 'B5 일일 신규진입 1건',        file: T, extra: ['--maxnew', '1'],       grp: 'rule' },
  { key: 'new2',    name: 'B5 일일 신규진입 2건',        file: T, extra: ['--maxnew', '2'],       grp: 'rule' },
  { key: 'new3',    name: 'B5 일일 신규진입 3건',        file: T, extra: ['--maxnew', '3'],       grp: 'rule' },
  { key: 'dd50',    name: 'B3 20일낙폭 -50% 초과 배제',  file: T, extra: ['--rsimaxdd20', '50'],  grp: 'rule' },
  { key: 'n1',      name: '[바닥] 현행 · 교란 #1',       file: 'candles-pert-1.jsonl', extra: [], grp: 'noise' },
  { key: 'n2',      name: '[바닥] 현행 · 교란 #2',       file: 'candles-pert-2.jsonl', extra: [], grp: 'noise' },
  { key: 'n3',      name: '[바닥] 현행 · 교란 #3',       file: 'candles-pert-3.jsonl', extra: [], grp: 'noise' },
];

const RE = /^combo-v2\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.-]+)%\s+(\d+)%\s+([\d.]+)일/m;

async function runOne(cfg, seed) {
  const args = ['--max-old-space-size=6144', 'backtest-swing.mjs',
    ...LIVE, '--candles', cfg.file, ...cfg.extra, ...COMMON,
    '--subsample', '0.8', '--seed', String(seed)];
  try {
    const { stdout } = await pexecFile(process.execPath, args,
      { cwd: CWD, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const m = stdout.match(RE);
    if (!m) { console.error(`  ! ${cfg.key} s${seed}: 결과행 파싱 실패`); return null; }
    return { n: +m[1], win: +m[2], pf: +m[3], cagr: +m[4], mdd: +m[5], seed };
  } catch (e) { console.error(`  ! ${cfg.key} s${seed}: ${String(e.message).slice(0, 90)}`); return null; }
}
async function pool(tasks, n) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) },
    async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

console.log(`=== 노출축 검정 ${SEEDS.length}시드 MC (폭락 포함 ~20260724) ===\n`);

const R = [];
for (const cfg of CONFIGS) {
  process.stdout.write(`[${cfg.key}] ${cfg.name} ... `);
  const rows = (await pool(SEEDS.map(s => () => runOne(cfg, s)), CONC)).filter(Boolean);
  // ★ 0시드 가드: 실행이 전부 죽었는데 표를 그리면 없는 근거를 만든다.
  if (rows.length < Math.ceil(SEEDS.length * 0.8)) {
    console.log(`\n\n⛔ 중단: ${cfg.key} 유효시드 ${rows.length}/${SEEDS.length} (80% 미달). 결과표 생성 안 함.`);
    process.exit(1);
  }
  const cg = rows.map(r => r.cagr), md = rows.map(r => r.mdd);
  const cA = avg(cg), mA = avg(md);
  R.push({ ...cfg, nSeed: rows.length, cg, md, cagrA: cA, cagrM: med(cg), mddA: mA,
    mddMax: Math.max(...md), cagrMin: Math.min(...cg), mdd40: md.filter(v => v > 40).length,
    calmar: mA > 0 ? cA / mA : 0, win: avg(rows.map(r => r.win)), trades: avg(rows.map(r => r.n)) });
  console.log(`${rows.length}시드 · 체결 ${Math.round(avg(rows.map(r => r.n)))} · CAGR ${cA.toFixed(2)}% · MDD ${mA.toFixed(2)}% · Calmar ${(mA > 0 ? cA / mA : 0).toFixed(2)}`);
}

const off = R.find(r => r.key === 'base');
const noise = R.filter(r => r.grp === 'noise');
const fl = [off.calmar, ...noise.map(r => r.calmar)];
const NOISE = Math.max(...fl) - Math.min(...fl);
console.log(`\n노이즈 바닥(교란3벌+원본 Calmar 스프레드) = ${NOISE.toFixed(3)}`);

console.log('\n구성                            체결  CAGR평균 CAGR중앙 최악시드  MDD평균  최대MDD MDD>40 Calmar     Δ   시드승');
console.log('─'.repeat(114));
for (const r of R) {
  const d = r.calmar - off.calmar;
  const wins = r.key === off.key ? '-' : `${r.cg.filter((v, i) => v > (off.cg[i] ?? -1e9)).length}/${r.nSeed}`;
  console.log(`${r.name.padEnd(29)} ${String(Math.round(r.trades)).padStart(5)} ${r.cagrA.toFixed(2).padStart(7)}% ${r.cagrM.toFixed(2).padStart(7)}% ${r.cagrMin.toFixed(2).padStart(7)}% ${r.mddA.toFixed(2).padStart(7)}% ${r.mddMax.toFixed(2).padStart(7)}% ${String(r.mdd40).padStart(5)} ${r.calmar.toFixed(2).padStart(6)} ${(r.key === off.key ? '' : (d >= 0 ? '+' : '') + d.toFixed(2)).padStart(6)} ${wins.padStart(7)}`);
}

console.log('\n=== 판정 (노이즈바닥 초과만 실질) ===');
for (const r of R.filter(x => x.grp === 'rule' && x.key !== 'base')) {
  const d = r.calmar - off.calmar;
  const same = r.trades === off.trades && Math.abs(r.cagrA - off.cagrA) < 1e-9;
  console.log(`${r.name.padEnd(29)} ΔCalmar ${(d >= 0 ? '+' : '') + d.toFixed(3)} vs 바닥 ${NOISE.toFixed(3)} → ${same ? '전 시드 기준선과 동일(영향 0건)' : Math.abs(d) > NOISE ? (d > 0 ? '★실질 개선' : '실질 악화') : '미통과(노이즈 내)'}`);
}
