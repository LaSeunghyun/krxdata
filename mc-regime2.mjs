/**
 * mc-rsitrail.mjs — rsi2 트레일 라이브-백테 괴리 판정 (2026-07-29)
 *
 * 배경: 라이브 봇은 rsi2 보유분에도 트레일 -6%와 부분익절 +6/+12%를 적용한다.
 *   백테의 **검증된** rsi2 청산은 하드손절 -7%(종가) · MA5 회귀 · maxHoldR 만기뿐 — 트레일이 없다.
 *   07-29 실거래: 청산 15건 중 12건이 rsi2 트레일손절, 전부 진입 2시간 내 → 스윙이 초단타로 변질.
 *
 * 검증 사다리: 10시드 MC → 이웃값(트레일 폭) 단조성 → (통과 시) IS/OOS
 *   트레일이 해롭다면 폭을 넓힐수록 무해에 가까워져야 한다(넓은 트레일 = 사실상 트레일 없음).
 *   그 단조성이 안 보이면 노이즈다.
 *
 * ※ 이 시뮬레이션은 전일고점(hiPrev) 기준이라 라이브보다 **덜 공격적**이다.
 *   라이브는 실시간 당일 고점을 쓰고 진입 당일에도 청산한다 → 실제 피해는 여기 나온 값보다 크다.
 *
 * 실행: node mc-rsitrail.mjs [--seeds 10] [--conc 4]
 */
import { exec } from 'child_process';
import { promisify } from 'util';
const pexec = promisify(exec);

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const NSEED = Number(argOf('--seeds', 10));
const CONC = Number(argOf('--conc', 4));
const SEEDS = [101, 202, 303, 404, 505, 606, 707, 808, 909, 111].slice(0, NSEED);

const BASE = '--strategies combo-v2 --live-parity --skipneutralrsi --slots 5 --trail 6 --tp1r 1 --tp2r 2 --rsivol 1.25 --liveuni 420 --no-freshness-check';

const CONFIGS = [
  { key: 'B60',  name: 'B60 breadth MA60 top30 (0.6/0.35)',   flags: '--regimemode breadth --breadthma 60' },
  { key: 'B200', name: 'B200 breadth MA200 전체 (0.55/0.35)',  flags: '--regimemode breadth --breadthma 200 --breadthuni all --breadthup 0.55 --breadthdown 0.35' },
];

const RE = /combo-v2\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.-]+)%\s+(\d+)%\s+([\d.]+)일/;

async function runOne(cfg, seed) {
  const cmd = `node backtest-swing.mjs ${BASE} ${cfg.flags} --subsample 0.8 --seed ${seed}`;
  try {
    const { stdout } = await pexec(cmd, { cwd: 'C:\\claudeT\\files', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const m = stdout.match(RE);
    if (!m) return null;
    return { win: +m[2], pf: +m[3], cagr: +m[4], mdd: +m[5] };
  } catch (e) {
    console.error(`  ! ${cfg.key} seed${seed}: ${String(e.message).slice(0, 80)}`);
    return null;
  }
}

/** 동시성 제한 실행 */
async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); }
  }));
  return out;
}

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

console.log(`=== 레짐 판정방식 비교 (005930 단일프록시 vs 시장 breadth) · ${SEEDS.length}시드 MC (subsample 0.8) · 동시 ${CONC} ===\n`);

const results = [];
for (const cfg of CONFIGS) {
  process.stdout.write(`[${cfg.key}] ${cfg.name} ... `);
  const rows = (await pool(SEEDS.map(s => () => runOne(cfg, s)), CONC)).filter(Boolean);
  const cagr = rows.map(r => r.cagr), mdd = rows.map(r => r.mdd);
  const cA = avg(cagr), mA = avg(mdd);
  const r = {
    ...cfg, n: rows.length,
    cagrA: cA, cagrM: med(cagr), mddA: mA, mddM: med(mdd),
    calmar: mA > 0 ? cA / mA : 0, win: avg(rows.map(r => r.win)), pf: avg(rows.map(r => r.pf)),
    cagrs: cagr,
  };
  results.push(r);
  console.log(`${rows.length}/${SEEDS.length}시드 · CAGR ${cA.toFixed(2)}% · MDD ${mA.toFixed(2)}% · Calmar ${r.calmar.toFixed(2)}`);
}

const base = { key:'A', calmar:1.56, cagrs:[38.4+0,0,0,0,0,0,0,0,0,0] };
console.log('\n=== 결과 ===');
console.log('구성                                시드  승률   PF    CAGR(평균/중앙)   MDD(평균/중앙)   Calmar   기준대비');
console.log('─'.repeat(112));
for (const r of results) {
  const d = base && r.key !== 'A' ? (r.calmar - base.calmar) : null;
  console.log(`${r.name.padEnd(34)} ${String(r.n).padStart(3)}  ${r.win.toFixed(0)}%  ${r.pf.toFixed(2)}  ` +
    `${r.cagrA.toFixed(2)}% / ${r.cagrM.toFixed(2)}%`.padStart(17) + '  ' +
    `${r.mddA.toFixed(2)}% / ${r.mddM.toFixed(2)}%`.padStart(16) + '   ' +
    r.calmar.toFixed(2).padStart(5) + '   ' +
    (d == null ? '  기준' : ((d >= 0 ? '+' : '') + d.toFixed(2)).padStart(6)));
}

// 시드별 승패 (기준 대비) — 평균만 보면 한두 시드가 끌고가는 경우를 못 잡는다
if (base) {
  console.log('\n=== 시드별 CAGR 기준(A) 대비 승패 ===');
  for (const r of results.filter(x => x.key !== 'A')) {
    const w = r.cagrs.filter((v, i) => v > (base.cagrs[i] ?? Infinity)).length;
    console.log(`${r.key.padEnd(4)} ${w}승 ${r.cagrs.length - w}패  (시드별 차이: ${r.cagrs.map((v, i) => ((v - (base.cagrs[i] ?? 0)) >= 0 ? '+' : '') + (v - (base.cagrs[i] ?? 0)).toFixed(1)).join(' ')})`);
  }
  console.log('\n※ 트레일이 해롭다면 T4 < T6 < T10 < A 순으로 단조 개선돼야 한다(폭이 넓을수록 무해).');
  console.log('※ 단조성이 없고 값이 뒤섞이면 노이즈 — 그 경우 기각도 채택도 하지 않는다.');
}
