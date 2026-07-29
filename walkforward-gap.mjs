/**
 * walkforward.mjs — 워크포워드(rolling origin) 검증 하네스 (2026-07-29 설계 재검토)
 *
 * 왜 필요한가: 지금까지의 판정은 **IS/OOS 단일 절단 1개**에 걸려 있었다. 독립 테스트가 1회뿐이라
 *   "IS에서 이기고 OOS에서 진다"는 결과가 파라미터 문제인지 절단 위치의 우연인지 구분되지 않는다.
 *   그리고 MC는 **종목 서브샘플(0.8)** 이라 횡단면 강건성만 재고 국면 강건성은 재지 않는다.
 *   오늘 35+변종이 전부 국면에서 죽었는데 계측기가 국면을 안 재고 있었다.
 *
 * 설계: 학습 TRAIN개월 → 검증 TEST개월 → STEP개월 전진. 각 창에서
 *   ① 학습구간에서 후보값별 성적을 재고 최선값을 고른다(사람 개입 없음)
 *   ② 그 값을 **검증구간에 그대로 적용**한 성적을 기록한다
 *   ③ 동시에 고정값(현행)의 검증구간 성적을 기록한다
 *   → "적응 선택이 고정값을 이기는가"를 여러 독립 창에서 판정한다.
 *
 * 이 질문이 중요한 이유: 오늘 모든 축이 "느슨한 설정은 강세장, 타이트한 설정은 횡보장에서 이긴다"로
 *   나왔다. 단일 값으로 양쪽을 못 이긴다는 게 증명됐으니, 남은 가설은 "국면에 따라 값을 바꾼다"뿐이다.
 *   워크포워드는 그 가설을 **미래 정보 없이** 평가하는 유일한 방법이다(학습창은 항상 검증창보다 과거).
 *
 * 실행: node walkforward.mjs --flag rsivol --values 0,1.25,1.5 [--train 12] [--test 3] [--step 3]
 */
import { exec } from 'child_process';
import { promisify } from 'util';
const pexec = promisify(exec);

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const FLAG = String(argOf('--flag', 'rsivol'));
const VALUES = String(argOf('--values', '0,1.25,1.5')).split(',');
const FIXED = String(argOf('--fixed', '1.25'));      // 현행 고정값
const TRAIN = Number(argOf('--train', 12));
const TEST = Number(argOf('--test', 3));
const STEP = Number(argOf('--step', 3));
const CONC = Number(argOf('--conc', 4));
const DATA_START = '2023-01', DATA_END = '2026-06';

const BASE = '--strategies combo-v2 --live-parity --skipneutralrsi --slots 5 --trail 6 --tp1r 1 --tp2r 2 --rsivol 0 --liveuni 420 --no-freshness-check --gapaxis';
const RE = /^combo-v2\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.-]+)%/m;

/** 'YYYY-MM' + n개월 → 'YYYYMMDD' (해당 월 1일) */
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = (y * 12 + (m - 1)) + n;
  return `${String(Math.floor(t / 12)).padStart(4, '0')}${String((t % 12) + 1).padStart(2, '0')}01`;
}
const avg2 = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const monthsBetween = (a, b) => { const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number); return (by * 12 + bm) - (ay * 12 + am); };

async function run(from, to, val) {
  const cmd = `node backtest-swing.mjs ${BASE} --from ${from} --to ${to} --${FLAG} ${val}`;
  try {
    const { stdout } = await pexec(cmd, { cwd: 'C:\\claudeT\\files', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const m = stdout.match(RE);
    if (!m) return null;
    const cagr = +m[4], mdd = +m[5];
    return { n: +m[1], win: +m[2], pf: +m[3], cagr, mdd, calmar: mdd > 0 ? cagr / mdd : 0 };
  } catch { return null; }
}
async function pool(tasks, n) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}

// 창 생성
const total = monthsBetween(DATA_START, DATA_END);
const windows = [];
for (let off = 0; off + TRAIN + TEST <= total; off += STEP) {
  windows.push({
    trFrom: addMonths(DATA_START, off), trTo: addMonths(DATA_START, off + TRAIN),
    teFrom: addMonths(DATA_START, off + TRAIN), teTo: addMonths(DATA_START, off + TRAIN + TEST),
  });
}
console.log(`=== 워크포워드: --${FLAG} ∈ {${VALUES.join(', ')}} · 고정값 ${FIXED} ===`);
console.log(`학습 ${TRAIN}개월 → 검증 ${TEST}개월 → ${STEP}개월 전진 · 창 ${windows.length}개\n`);

// ── 고정값 정면비교 모드: 각 후보값을 **모든 검증창**에 적용해 창별 승패를 낸다 ──
//   단일 IS/OOS 절단 1개로 판정하던 것을 독립 창 N개로 대체한다. 적응 선택과 무관하게
//   "어느 고정값이 가장 여러 창에서 이기는가"가 훨씬 강한 증거다.
if (argv.includes('--fixedgrid')) {
  const cells = [];
  for (const [wi, w] of windows.entries()) {
    const res = await pool(VALUES.map(v => () => run(w.teFrom, w.teTo, v)), CONC);
    cells.push({ wi, teFrom: w.teFrom, res });
    console.log(`  창${String(wi + 1).padStart(2)} ${w.teFrom.slice(0, 6)}~${w.teTo.slice(0, 6)}  ` +
      VALUES.map((v, i) => `${v}:${res[i] ? res[i].cagr.toFixed(0) + '%' : '-'}`).join('  '));
  }
  console.log('\n=== 고정값별 검증창 성적 ===');
  console.log('값       창수  CAGR평균  MDD평균  Calmar  최다승');
  const winCount = VALUES.map(() => 0);
  for (const c of cells) {
    let bi = -1, bv = -Infinity;
    c.res.forEach((r, i) => { if (r && r.cagr > bv) { bv = r.cagr; bi = i; } });
    if (bi >= 0) winCount[bi]++;
  }
  VALUES.forEach((v, i) => {
    const rs = cells.map(c => c.res[i]).filter(Boolean);
    const aC = avg2(rs.map(r => r.cagr)), aM = avg2(rs.map(r => r.mdd));
    console.log(`${String(v).padEnd(8)} ${String(rs.length).padStart(4)}  ${aC.toFixed(2).padStart(7)}%  ${aM.toFixed(2).padStart(6)}%  ${(aM > 0 ? aC / aM : 0).toFixed(2).padStart(6)}  ${String(winCount[i]).padStart(4)}창`);
  });
  console.log('\n※ 한 값이 과반 창에서 최고면 그 값이 진짜 우위다. 승수가 흩어지면 국면 의존 = 고정 최적값 없음.');
  process.exit(0);
}

const rows = [];
for (const [wi, w] of windows.entries()) {
  // ① 학습구간에서 후보값 평가 → 최선값 선택 (사람 개입 없음)
  const tr = (await pool(VALUES.map(v => () => run(w.trFrom, w.trTo, v)), CONC));
  let best = null, bestC = -Infinity;
  VALUES.forEach((v, i) => { const c = tr[i]?.calmar ?? -Infinity; if (c > bestC) { bestC = c; best = v; } });
  // ② 선택값을 검증구간에 적용 + ③ 고정값도 검증구간에 적용
  const [teAdapt, teFixed] = await pool([() => run(w.teFrom, w.teTo, best), () => run(w.teFrom, w.teTo, FIXED)], 2);
  rows.push({ wi, ...w, best, bestC, teAdapt, teFixed });
  const f = (r) => r ? `${r.cagr.toFixed(1)}%/${r.mdd.toFixed(1)}%` : '   -   ';
  console.log(`창${String(wi + 1).padStart(2)} 학습 ${w.trFrom.slice(0, 6)}~${w.trTo.slice(0, 6)} → 선택 ${String(best).padStart(5)} (Calmar ${bestC.toFixed(2)}) │ 검증 ${w.teFrom.slice(0, 6)}~${w.teTo.slice(0, 6)}  적응 ${f(teAdapt)}  고정 ${f(teFixed)}`);
}

// 판정
const ok = rows.filter(r => r.teAdapt && r.teFixed);
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
console.log(`\n=== 판정 (대조 가능 창 ${ok.length}개) ===`);
if (ok.length) {
  const aC = avg(ok.map(r => r.teAdapt.cagr)), fC = avg(ok.map(r => r.teFixed.cagr));
  const aM = avg(ok.map(r => r.teAdapt.mdd)), fM = avg(ok.map(r => r.teFixed.mdd));
  const wins = ok.filter(r => r.teAdapt.cagr > r.teFixed.cagr).length;
  console.log(`적응 선택  검증 CAGR 평균 ${aC.toFixed(2)}%  MDD ${aM.toFixed(2)}%  Calmar ${(aM > 0 ? aC / aM : 0).toFixed(2)}`);
  console.log(`고정 ${FIXED}    검증 CAGR 평균 ${fC.toFixed(2)}%  MDD ${fM.toFixed(2)}%  Calmar ${(fM > 0 ? fC / fM : 0).toFixed(2)}`);
  console.log(`창별 승패: 적응 ${wins}승 ${ok.length - wins}패`);
  const sel = {};
  for (const r of ok) sel[r.best] = (sel[r.best] ?? 0) + 1;
  console.log(`학습이 고른 값 분포: ${Object.entries(sel).map(([k, v]) => `${k}→${v}회`).join(' · ')}`);
  console.log(`\n※ 적응이 고정을 이기려면 창 승패 ${Math.ceil(ok.length * 0.6)}승 이상 + 평균 Calmar 초과여야 한다.`);
  console.log(`※ 학습이 고른 값이 매 창 바뀌기만 하고 검증에서 못 이기면 = 국면은 사후에만 보인다(예측 불가).`);
}
