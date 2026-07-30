/**
 * mc-closesrc.mjs — 종가 소스(Toss NXT통합 vs KRX 정규장) 10시드 MC · IS/OOS (2026-07-30)
 *
 * ═══ 배경 ═══
 * Toss 일봉 = KRX정규장 + NXT(프리 08:00~08:50 · 애프터 15:30~20:00) 통합임을 확정했다
 * (상위집합 제약 Toss고가>=KRX고가 AND Toss저가<=KRX저가 가 1,231,423건 중 위반 1.6%,
 *  그 1.6%는 권리변동 계단 18종목이며 제외했다).
 * 백테는 NXT통합 종가로 검증됐는데 라이브 15:35 판정은 사실상 KRX 종가를 읽는다.
 *
 * 단일경로 결과 (1,105종목 동일 코드집합, --from 20230102 --to 20260611):
 *   A Toss정제  CAGR 26.2% · MDD 25.7% · Calmar 1.02 · PF 1.19
 *   B KRX정제   CAGR 38.7% · MDD 22.6% · Calmar 1.71 · PF 1.36
 *   → 종가소스 순효과 CAGR +12.5%p · MDD -3.1%p · Calmar +68%
 *   메커니즘: hi120 × 보유1~3일 이 -8,032k → +71k. NXT 시간외 얇은 거래가
 *            트레일을 조기 발동시키고 있었다는 해석과 일치.
 *
 * ═══ 왜 MC가 필요한가 ═══
 * 이 세션에서 단일경로 승자가 MC에서 4번 죽었다(MA트레일 2.20→0.58 · rsimindist 3.30→1.71 ·
 * caps B 1.08→0.49 · 갭조건부 rsi2손절). 단일경로는 증거가 아니다.
 * 또한 **기준선도 함께 MC** 해야 한다 — 갭정책 때는 기준선의 운 나쁜 단일경로가 착시를 만들었다.
 *
 * ═══ 채택 조건 (결과 보기 전 선언) ═══
 *   IS·OOS 양쪽에서 Toss 대비 Calmar 초과 + 각 구간 시드 6승 이상.
 *   한쪽만 이기면 국면의존 → 기각.
 *
 * 실행: node mc-closesrc.mjs [--seeds 10] [--conc 4]
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
const TOSS = '--candles candles-daily-toss-clean.jsonl';
const KRX = '--candles candles-daily-krx-clean.jsonl';

const CONFIGS = [
  { key: 'IS-toss', name: 'IS  Toss(NXT통합)', flags: `${LIVE} ${TOSS} --from 20230102 --to 20240920` },
  { key: 'IS-krx', name: 'IS  KRX(정규장)', flags: `${LIVE} ${KRX} --from 20230102 --to 20240920` },
  { key: 'OS-toss', name: 'OOS Toss(NXT통합)', flags: `${LIVE} ${TOSS} --from 20240921 --to 20260611` },
  { key: 'OS-krx', name: 'OOS KRX(정규장)', flags: `${LIVE} ${KRX} --from 20240921 --to 20260611` },
];

const RE = /^combo-v2\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.-]+)%\s+(\d+)%\s+([\d.]+)일/m;

async function runOne(cfg, seed) {
  const cmd = `node --max-old-space-size=6144 backtest-swing.mjs ${cfg.flags} ${COMMON} --subsample 0.8 --seed ${seed}`;
  try {
    const { stdout } = await pexec(cmd, { cwd: 'C:\\claudeT\\files', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const m = stdout.match(RE);
    if (!m) { console.error(`  ! ${cfg.key} seed${seed}: 결과행 파싱 실패`); return null; }
    return { n: +m[1], win: +m[2], pf: +m[3], cagr: +m[4], mdd: +m[5] };
  } catch (e) { console.error(`  ! ${cfg.key} seed${seed}: ${String(e.message).slice(0, 70)}`); return null; }
}
async function pool(tasks, n) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

console.log(`=== 종가소스 비교 · ${SEEDS.length}시드 MC (subsample 0.8) · 동일 코드집합 1,105종목 ===\n`);
const R = [];
for (const cfg of CONFIGS) {
  process.stdout.write(`[${cfg.key}] ${cfg.name} ... `);
  const rows = (await pool(SEEDS.map(s => () => runOne(cfg, s)), CONC)).filter(Boolean);
  const cagr = rows.map(r => r.cagr), mdd = rows.map(r => r.mdd);
  const cA = avg(cagr), mA = avg(mdd);
  R.push({ ...cfg, n: rows.length, cagrs: cagr, mdds: mdd, cagrA: cA, cagrM: med(cagr), mddA: mA, calmar: mA > 0 ? cA / mA : 0, win: avg(rows.map(r => r.win)), pf: avg(rows.map(r => r.pf)), trades: avg(rows.map(r => r.n)) });
  console.log(`${rows.length}/${SEEDS.length}시드 · 체결 ${Math.round(avg(rows.map(r => r.n)))} · CAGR ${cA.toFixed(2)}% · MDD ${mA.toFixed(2)}% · Calmar ${(mA > 0 ? cA / mA : 0).toFixed(2)}`);
}

console.log('\n=== 결과 ===');
console.log('구성                       시드 체결  승률  PF    CAGR(평균/중앙)   MDD     Calmar');
console.log('─'.repeat(92));
for (const r of R) console.log(`${r.name.padEnd(25)} ${String(r.n).padStart(3)} ${String(Math.round(r.trades)).padStart(5)} ${r.win.toFixed(0).padStart(4)}% ${r.pf.toFixed(2)} ${(r.cagrA.toFixed(2) + '% / ' + r.cagrM.toFixed(2) + '%').padStart(17)} ${(r.mddA.toFixed(2) + '%').padStart(7)} ${r.calmar.toFixed(2).padStart(8)}`);

for (const seg of ['IS', 'OS']) {
  const base = R.find(r => r.key === `${seg}-toss`);
  const cand = R.find(r => r.key === `${seg}-krx`);
  if (!base || !cand) continue;
  const wC = cand.cagrs.filter((v, i) => v > (base.cagrs[i] ?? Infinity)).length;
  const wM = cand.mdds.filter((v, i) => v < (base.mdds[i] ?? -Infinity)).length;
  console.log(`\n=== ${seg}: KRX vs Toss 시드별 ===`);
  console.log(`CAGR ${wC}승 ${cand.cagrs.length - wC}패  (${cand.cagrs.map((v, i) => ((v - (base.cagrs[i] ?? 0)) >= 0 ? '+' : '') + (v - (base.cagrs[i] ?? 0)).toFixed(0)).join(' ')})`);
  console.log(`MDD  ${wM}승 ${cand.mdds.length - wM}패  (${cand.mdds.map((v, i) => ((v - (base.mdds[i] ?? 0)) >= 0 ? '+' : '') + (v - (base.mdds[i] ?? 0)).toFixed(1)).join(' ')})  ※ 음수가 개선`);
  console.log(`Calmar ${base.calmar.toFixed(2)} → ${cand.calmar.toFixed(2)}  (${((cand.calmar / base.calmar - 1) * 100).toFixed(0)}%)`);
}

console.log('\n※ 채택 조건(사전 선언): IS·OOS 양쪽 Calmar 초과 + 각 구간 시드 6승 이상.');
console.log('※ 이 비교는 "어느 종가가 진실이냐"가 아니다. 라이브는 15:35에 KRX 종가를 읽으므로');
console.log('   KRX가 우세하면 **백테가 비관적이었다**는 뜻이고, Toss가 우세하면 라이브가 손해보고 있다는 뜻이다.');
