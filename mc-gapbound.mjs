/**
 * mc-strat-compare.mjs — 갭 조건부 정책 (30분 대용) 10시드 MC (2026-07-29)
 *
 * ⚠️ 함정 기록: backtest-swing.mjs의 argOf는 `argv.indexOf(flag)`로 **첫 번째** 값만 읽는다.
 *   공통 BASE에 `--strategies combo-v2`를 넣고 뒤에 `--strategies rsi2`를 덧붙이면 **조용히 무시된다**
 *   (실제로 그렇게 돌려 네 구성이 전부 동일한 숫자를 낸 적 있음). 그래서 여기선 구성별로 **전체 커맨드**를 쓴다.
 *
 * 목표: "현재 전략보다 수익이 좋은 방법" — 현행 combo-v2 라이브 설정 대 대안 구성.
 *   판정: IS·OOS 양쪽에서 Calmar 초과 + 시드 6승 이상. 한쪽만 이기면 국면의존으로 기각.
 *
 * 실행: node mc-strat-compare.mjs [--seeds 10] [--conc 4]
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
const LIVE = '--strategies combo-v2 --live-parity --skipneutralrsi --slots 5 --trail 6 --tp1r 1 --tp2r 2 --liveuni 420';
const SOLO = '--strategies rsi2 --slots 5';
const SOLO_UNI = '--strategies rsi2 --slots 5 --rsiuni 420';   // 유니버스만 라이브와 맞춘 변종

const CONFIGS = [
  { key: 'OS-base', name: 'OOS 기준(정책없음)', re: 'combo-v2', flags: LIVE + ' --rsivol 0 --gapaxis --from 20240921' },
  { key: 'OS-b02',  name: 'OOS 경계 ±0.2', re: 'combo-v2', flags: LIVE + ' --rsivol 0 --gapaxis --from 20240921 --gapbound 0.2 --scenpolicy gap-pol.json' },
  { key: 'OS-b03',  name: 'OOS 경계 ±0.3', re: 'combo-v2', flags: LIVE + ' --rsivol 0 --gapaxis --from 20240921 --gapbound 0.3 --scenpolicy gap-pol.json' },
  { key: 'OS-b05',  name: 'OOS 경계 ±0.5(사전등록)', re: 'combo-v2', flags: LIVE + ' --rsivol 0 --gapaxis --from 20240921 --gapbound 0.5 --scenpolicy gap-pol.json' },
  { key: 'OS-b08',  name: 'OOS 경계 ±0.8', re: 'combo-v2', flags: LIVE + ' --rsivol 0 --gapaxis --from 20240921 --gapbound 0.8 --scenpolicy gap-pol.json' },
];

const mkRe = (name) => new RegExp(`^${name.replace(/[-]/g, '\\-')}\\s+(\\d+)\\s+(\\d+)%\\s+([\\d.]+)\\s+([\\d.-]+)%\\s+([\\d.-]+)%\\s+(\\d+)%\\s+([\\d.]+)일`, 'm');

async function runOne(cfg, seed) {
  const cmd = `node backtest-swing.mjs ${cfg.flags} ${COMMON} --subsample 0.8 --seed ${seed}`;
  try {
    const { stdout } = await pexec(cmd, { cwd: 'C:\\claudeT\\files', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const m = stdout.match(mkRe(cfg.re));
    if (!m) return null;
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

console.log(`=== 전략 구성 비교 · ${SEEDS.length}시드 MC (subsample 0.8) ===\n`);
const R = [];
for (const cfg of CONFIGS) {
  process.stdout.write(`[${cfg.key}] ${cfg.name} ... `);
  const rows = (await pool(SEEDS.map(s => () => runOne(cfg, s)), CONC)).filter(Boolean);
  const cagr = rows.map(r => r.cagr), mdd = rows.map(r => r.mdd);
  const cA = avg(cagr), mA = avg(mdd);
  R.push({ ...cfg, n: rows.length, cagrs: cagr, cagrA: cA, cagrM: med(cagr), mddA: mA, calmar: mA > 0 ? cA / mA : 0, win: avg(rows.map(r => r.win)), pf: avg(rows.map(r => r.pf)), trades: avg(rows.map(r => r.n)) });
  console.log(`${rows.length}/${SEEDS.length}시드 · 체결 ${Math.round(avg(rows.map(r => r.n)))} · CAGR ${cA.toFixed(2)}% · MDD ${mA.toFixed(2)}% · Calmar ${(mA > 0 ? cA / mA : 0).toFixed(2)}`);
}

console.log('\n=== 결과 ===');
console.log('구성                            시드 체결  승률  PF    CAGR(평균/중앙)   MDD    Calmar');
console.log('─'.repeat(96));
for (const r of R) console.log(`${r.name.padEnd(30)} ${String(r.n).padStart(3)} ${String(Math.round(r.trades)).padStart(5)} ${r.win.toFixed(0).padStart(4)}% ${r.pf.toFixed(2)} ${(r.cagrA.toFixed(2) + '% / ' + r.cagrM.toFixed(2) + '%').padStart(17)} ${(r.mddA.toFixed(2) + '%').padStart(7)} ${r.calmar.toFixed(2).padStart(7)}`);

// 시드별 승패: 같은 구간 안에서 현행 대비
for (const seg of ['IS', 'OS']) {
  const base = R.find(r => r.key === `${seg}-base`);
  if (!base) continue;
  console.log(`\n=== ${seg} 시드별 CAGR — 현행 대비 ===`);
  for (const r of R.filter(x => x.key.startsWith(seg) && x.key !== `${seg}-live`)) {
    const w = r.cagrs.filter((v, i) => v > (base.cagrs[i] ?? Infinity)).length;
    console.log(`${r.name.padEnd(30)} ${w}승 ${r.cagrs.length - w}패  (${r.cagrs.map((v, i) => ((v - (base.cagrs[i] ?? 0)) >= 0 ? '+' : '') + (v - (base.cagrs[i] ?? 0)).toFixed(0)).join(' ')})`);
  }
}
console.log('\n※ 채택 조건: IS·OOS 양쪽에서 현행 Calmar 초과 + 각 구간 시드 6승 이상.');
console.log('※ 한쪽만 이기면 국면의존 → 기각(오늘 이 패턴으로 여러 축이 죽었다).');
