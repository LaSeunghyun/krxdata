/**
 * mc-concentration.mjs — 2026-08-07 집중도(몰빵) 축 검정 · 30시드 MC + 노이즈 바닥 동시측정
 *
 * 사용자 요청: "모든 주식의 정보와 지표를 분석해서 단 하나의 주식을 몰빵해서 사는 방식"
 *   = 후보 랭킹(conviction)은 현행 그대로 두고 **자본을 1종목에 전액 투입**하는 구성.
 *
 * ★ 이 축은 과거 두 번 기각된 이력이 있다 (재측정 사유를 명시한다)
 *   - I3 (evolve-mc3-protocol.md:45) 30k·slots2 기준선: 중앙값 +15% 이나 p5 33,770→29,035,
 *     원금미만 0→3런 → "테일 악화"로 기각
 *   - I17 (:226) 라이브가 de facto slots1 이던 것을 발견: 원금손실 **35% vs 2.5%**(14배),
 *     MDD 41.9% vs 18.3%, paired 32/40 패 (z=3.79)
 *   재측정 근거 3가지: ① 기준선이 slots2 → **slots5** 로 바뀌었다 ② 파라미터가 전면 교체됐다
 *   (uni420·trail6·tp1R/2R·capsA) ③ 검증 구간 규칙이 바뀌었다(§1-B 폭락 필수 — 당시는 미포함).
 *   ①②는 판정을 뒤집을 수 있고 ③은 집중 쪽에 불리하게 작동할 것으로 예상되나, 예상으로 닫지 않는다.
 *
 * ★ 배선 (단일경로로 먼저 검증 완료 — §3, MC 전 필수)
 *   `--slots 1` **단독은 몰빵이 아니다.** liveCandidateBudget 이
 *   `conviction>=7 ? cash*strongFraction : min(cash, perSlot)` 이고 slots=1 이면 perSlot=effEq 라
 *   **약한 후보는 전액·강한 후보는 50%** 를 산다(확신이 높을수록 작게 사는 역전).
 *   → `--strongfrac` 신설(기본=계약값 0.5 = 동작 불변). 진짜 몰빵은 `--slots 1 --strongfrac 1.0`.
 *   항등 대조군 실측: `--slots 5 --strongfrac 0.5` 가 기준선과 최종자본 원 단위까지 동일(26,974,824원).
 *
 * ═══ 판정 기준 (사전 선언 — 실행 후 수정 금지) ═══
 *
 *  [1] 주 판정 = ΔCalmar vs 노이즈 바닥. |Δ| < 바닥이면 **판정 불가**(채택도 기각도 아님).
 *
 *  [2] ★ 테일 게이트 (이 축 전용, 3개 전부 통과해야 채택 후보 자격)
 *      집중은 평균이 아니라 꼬리에서 죽는다. Calmar 평균만 보면 I3 가 놓친 것을 또 놓친다.
 *        G1 원금손실률(최종 < 초기 시드 비율)이 기준선 대비 +5%p 초과 악화 → 탈락
 *        G2 p5 최종자본이 기준선 대비 20% 초과 악화 → 탈락
 *        G3 MDD > 50% 시드 수가 기준선보다 증가 → 탈락
 *      ΔCalmar 가 양수여도 G1~G3 중 하나라도 걸리면 **채택 불가**로 적는다.
 *
 *  [3] [1]+[2] 를 통과한 arm 만 IS/OOS 분할(2단계)로 넘긴다 — 전기간 단일 측정은
 *      강세장 OOS 승리로 횡보장 IS 패배를 덮는다(§2026-08-04 J·K 선례. 60승0패도 IS/OOS 에서 기각됐다).
 *
 *  [4] 시드승(paired)은 보조 지표로만 병기한다. 방향은 보되 단독 근거로 쓰지 않는다.
 *
 * ⚠️ §1-F MC 실행 중 다른 노드 작업 금지. 판정 전 전 arm 시드수 충족 확인(아래 0시드 가드).
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
const pexecFile = promisify(execFile);

const CWD = String.raw`C:\claudeT\files`;
const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const NSEED = Number(argOf('--seeds', 30));
const CONC = Number(argOf('--conc', 4));
const FROM = argOf('--from', '20230102');
const TO = argOf('--to', '20260724');
const TAG = argOf('--tag', '전기간');
const ALL = [101, 202, 303, 404, 505, 606, 707, 808, 909, 111,
  131, 151, 171, 191, 211, 231, 251, 271, 291, 311,
  331, 351, 371, 391, 411, 431, 451, 471, 491, 511,
  531, 551, 571, 591, 611, 631, 651, 671, 691, 711,
  731, 751, 771, 791, 811, 831, 851, 871, 891, 911,
  931, 951, 971, 991, 1011, 1031, 1051, 1071, 1091, 1111];
const SEEDS = ALL.slice(0, NSEED);
const INITIAL = 10_000_000;   // backtest-swing 기본 자본

const COMMON = ['--no-freshness-check', '--from', FROM, '--to', TO];
const LIVE = ['--strategies', 'combo-v2', '--live-parity', '--skipneutralrsi',
  '--trail', '6', '--tp1r', '1', '--tp2r', '2', '--liveuni', '420', '--rsivol', '0'];
const T = 'candles-daily-toss-clean.jsonl';

const CONFIGS = [
  { key: 'base',  name: '현행 5슬롯 분산',            file: T, extra: ['--slots', '5'], grp: 'rule' },
  { key: 's1',    name: '★몰빵 1슬롯 전액',           file: T, extra: ['--slots', '1', '--strongfrac', '1.0'], grp: 'rule' },
  { key: 's1mix', name: '1슬롯·확신시 50%(혼합)',      file: T, extra: ['--slots', '1'], grp: 'rule' },
  { key: 's2',    name: '2슬롯',                      file: T, extra: ['--slots', '2'], grp: 'rule' },
  { key: 's3',    name: '3슬롯',                      file: T, extra: ['--slots', '3'], grp: 'rule' },
  { key: 'n1',    name: '[바닥] 현행 · 교란 #1',       file: 'candles-pert-1.jsonl', extra: ['--slots', '5'], grp: 'noise' },
  { key: 'n2',    name: '[바닥] 현행 · 교란 #2',       file: 'candles-pert-2.jsonl', extra: ['--slots', '5'], grp: 'noise' },
  { key: 'n3',    name: '[바닥] 현행 · 교란 #3',       file: 'candles-pert-3.jsonl', extra: ['--slots', '5'], grp: 'noise' },
];

// 체결 승률 PF CAGR MDD 월승률 평균보유 최종자본
const RE = /^combo-v2\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.-]+)%\s+(\d+)%\s+([\d.]+)일\s+([\d,]+)원/m;

async function runOne(cfg, seed) {
  const args = ['--max-old-space-size=6144', 'backtest-swing.mjs',
    ...LIVE, '--candles', cfg.file, ...cfg.extra, ...COMMON,
    '--subsample', '0.8', '--seed', String(seed)];
  try {
    const { stdout } = await pexecFile(process.execPath, args,
      { cwd: CWD, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const m = stdout.match(RE);
    if (!m) { console.error(`  ! ${cfg.key} s${seed}: 결과행 파싱 실패`); return null; }
    return { n: +m[1], win: +m[2], pf: +m[3], cagr: +m[4], mdd: +m[5],
      final: Number(m[8].replace(/,/g, '')), seed };
  } catch (e) { console.error(`  ! ${cfg.key} s${seed}: ${String(e.message).slice(0, 90)}`); return null; }
}
async function pool(tasks, n) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) },
    async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const srt = (a) => [...a].sort((x, y) => x - y);
const med = (a) => { if (!a.length) return 0; const s = srt(a); return s[Math.floor(s.length / 2)]; };
const pct = (a, p) => { if (!a.length) return 0; const s = srt(a); return s[Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * p)))]; };

console.log(`=== 집중도(몰빵) 축 검정 ${SEEDS.length}시드 MC · ${TAG} ${FROM}~${TO} ===\n`);

const R = [];
for (const cfg of CONFIGS) {
  process.stdout.write(`[${cfg.key}] ${cfg.name} ... `);
  const rows = (await pool(SEEDS.map(s => () => runOne(cfg, s)), CONC)).filter(Boolean);
  // ★ 0시드 가드: 실행이 죽었는데 표를 그리면 없는 근거를 만든다 (mc-exposure 실측 사고).
  if (rows.length < Math.ceil(SEEDS.length * 0.8)) {
    console.log(`\n\n⛔ 중단: ${cfg.key} 유효시드 ${rows.length}/${SEEDS.length} (80% 미달). 결과표 생성 안 함.`);
    process.exit(1);
  }
  const cg = rows.map(r => r.cagr), md = rows.map(r => r.mdd), fin = rows.map(r => r.final);
  const cA = avg(cg), mA = avg(md);
  R.push({ ...cfg, nSeed: rows.length, cg, md, fin,
    cagrA: cA, cagrM: med(cg), cagrMin: Math.min(...cg),
    mddA: mA, mddMax: Math.max(...md), mdd50: md.filter(v => v > 50).length,
    finMed: med(fin), finP5: pct(fin, 0.05), finMin: Math.min(...fin),
    lossRate: fin.filter(v => v < INITIAL).length / fin.length * 100,
    calmar: mA > 0 ? cA / mA : 0, win: avg(rows.map(r => r.win)), trades: avg(rows.map(r => r.n)) });
  const r = R[R.length - 1];
  console.log(`${rows.length}시드 · 체결 ${Math.round(r.trades)} · CAGR ${cA.toFixed(2)}% · MDD ${mA.toFixed(2)}% · Calmar ${r.calmar.toFixed(2)} · 원금손실 ${r.lossRate.toFixed(1)}%`);
}

const off = R.find(r => r.key === 'base');
const noise = R.filter(r => r.grp === 'noise');
const fl = [off.calmar, ...noise.map(r => r.calmar)];
const NOISE = Math.max(...fl) - Math.min(...fl);
console.log(`\n노이즈 바닥(교란3벌+원본 Calmar 스프레드) = ${NOISE.toFixed(3)}`);

console.log('\n구성                          체결  CAGR평균 CAGR중앙 최악시드  MDD평균  최대MDD MDD>50 Calmar     Δ   시드승');
console.log('─'.repeat(116));
for (const r of R) {
  const d = r.calmar - off.calmar;
  const wins = r.key === off.key ? '-' : `${r.cg.filter((v, i) => v > (off.cg[i] ?? -1e9)).length}/${r.nSeed}`;
  console.log(`${r.name.padEnd(27)} ${String(Math.round(r.trades)).padStart(5)} ${r.cagrA.toFixed(2).padStart(7)}% ${r.cagrM.toFixed(2).padStart(7)}% ${r.cagrMin.toFixed(2).padStart(7)}% ${r.mddA.toFixed(2).padStart(7)}% ${r.mddMax.toFixed(2).padStart(7)}% ${String(r.mdd50).padStart(5)} ${r.calmar.toFixed(2).padStart(6)} ${(r.key === off.key ? '' : (d >= 0 ? '+' : '') + d.toFixed(2)).padStart(6)} ${wins.padStart(7)}`);
}

console.log('\n=== 테일 분포 (집중 축의 실제 판정면) ===');
console.log('구성                          최종중앙        p5         최소   원금손실률');
console.log('─'.repeat(74));
for (const r of R) {
  console.log(`${r.name.padEnd(27)} ${r.finMed.toLocaleString().padStart(11)} ${r.finP5.toLocaleString().padStart(11)} ${r.finMin.toLocaleString().padStart(11)} ${(r.lossRate.toFixed(1) + '%').padStart(9)}`);
}

console.log('\n=== 판정 ===');
for (const r of R.filter(x => x.grp === 'rule' && x.key !== 'base')) {
  const d = r.calmar - off.calmar;
  const same = r.trades === off.trades && Math.abs(r.cagrA - off.cagrA) < 1e-9;
  const g1 = r.lossRate - off.lossRate <= 5;
  const g2 = r.finP5 >= off.finP5 * 0.8;
  const g3 = r.mdd50 <= off.mdd50;
  const tail = g1 && g2 && g3;
  const main = same ? '전 시드 기준선과 동일(영향 0건)'
    : Math.abs(d) > NOISE ? (d > 0 ? '★실질 개선' : '실질 악화') : '미통과(노이즈 내)';
  console.log(`\n${r.name}`);
  console.log(`  [1] ΔCalmar ${(d >= 0 ? '+' : '') + d.toFixed(3)} vs 바닥 ${NOISE.toFixed(3)} → ${main}`);
  console.log(`  [2] 테일게이트 G1 원금손실 ${off.lossRate.toFixed(1)}→${r.lossRate.toFixed(1)}% ${g1 ? 'OK' : '✗'}`
    + ` · G2 p5 ${off.finP5.toLocaleString()}→${r.finP5.toLocaleString()} ${g2 ? 'OK' : '✗'}`
    + ` · G3 MDD>50 ${off.mdd50}→${r.mdd50} ${g3 ? 'OK' : '✗'} → ${tail ? '통과' : '탈락'}`);
  console.log(`  ⇒ ${d > NOISE && tail ? '2단계(IS/OOS) 진행 대상' : '채택 불가'}`);
}
