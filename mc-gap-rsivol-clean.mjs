/**
 * mc-gap-rsivol-clean.mjs — 갭정책·rsivol 정제본 재검증 (2026-08-08)
 *
 * ═══ 왜 다시 재나 ═══
 * 둘 다 **지금 라이브에 적용 중인 규칙**인데 채택 근거가 오염 소스 위에 있다.
 *   · 갭정책 trail10  : `mc-gap.mjs`·`mc-gap2`·`mc-gap-is`·`mc-gapbound`·`mc-gaprsi` 5개가
 *                       전부 `--candles` 미지정 = 기본값 `candles-daily.jsonl`
 *                       (= 가짜 가격점프 18종목 · 최대 30배 포함, hi120 유니버스 18/18 오염)
 *   · rsivol 1.25→0   : `mc-rsivol.mjs` 도 동일하게 오염본
 * 원 채택 근거는 갭정책 IS Calmar 1.19→1.77(+49%) · OOS 2.87→4.67(+63%) 인데
 * 정제본 단일경로에서는 ΔCalmar **+0.05** 밖에 안 나온다. **이 격차가 판정 대상이다.**
 *
 * ★ 추가로 발견한 것: **`mc-gap.mjs` 에는 노이즈 바닥 arm 이 하나도 없다**(pert 참조 0건).
 *   즉 갭정책은 바닥 없이, 10시드로, 오염 소스에서 채택됐다.
 *
 * ═══ stats-auditor 절차 결함 5건 반영 ═══
 *  (1) 교란본 4벌 → **15벌**. 검정력 한계는 시드 수가 아니라 귀무 draw 수다.
 *      `pert-c01..c15.jsonl` (seed 2001~2015, 전부 정제본에서 파생, md5 15/15 고유 확인).
 *  (2) **시드별 Calmar** 를 계산한다. 기존 하네스의 `avg(CAGR)/avg(MDD)` 는 평균의 비라
 *      arm 당 스칼라 1개뿐이고 SE 가 없다. 시드별로 내면 SE·t·부호검정이 공짜다.
 *      ※ 두 정의를 **둘 다** 출력한다 — 기존 판정과 비교 가능해야 하므로.
 *  (3) **n_seed=30 · n_pert=15 사전 고정.** 실행 후 늘리지 않는다.
 *      §4 "경계값이면 시드를 늘려라"가 실제로는 "통과할 때까지 늘린다"로 적용된 전례가 있다.
 *  (4) **MDD 를 따로 보고**한다. 갭정책은 MDD 를 악화시키는데 Calmar 상승이 그것을 가렸다
 *      ("청산폭을 넓혀 방어한다"는 서사로 채택됐으나 실제 기여는 CAGR 쪽이었다).
 *  (5) **시드 키 짝짓기.** 기존 `rows.filter(Boolean)` + 위치 인덱스 짝짓기는 arm 마다 다른
 *      시드가 빠지면 **엉뚱한 시드끼리 짝지어진다.** Map<seed, row> 로 바꾸고,
 *      **한 시드라도 빠지면 중단**한다(0시드 가드의 20% 허용을 없앤다).
 *
 * ═══ 판정 기준 (사전 선언 — 실행 후 수정 금지) ═══
 *
 *  기준 arm = **현행 라이브**(정제본 · 갭정책 on · rsivol 0 · slots5 · trail6 · tp1r1 · tp2r2 · uni420).
 *
 *  [A] 경험적 귀무분포: 교란 15벌 각각의 Δ_p = mean_s( calmar_p(s) − calmar_ref(s) ).
 *      이 15개가 "실제 효과가 0일 때 나오는 Δ" 의 분포다.
 *      p_emp = (#{|Δ_p| ≥ |Δ_arm|} + 1) / (15 + 1).   **최소 달성 가능 p = 0.0625.**
 *      → p_emp ≤ 0.0625 여야 "바닥 초과". 그 값이 하한이므로 그 이상은 구분 불가로 적는다.
 *
 *  [B] 짝지은 t 검정: Δ_s = calmar_arm(s) − calmar_ref(s), s=30개 공통 시드.
 *      t = mean(Δ)/SE(Δ). |t| ≥ 2.045 (df=29, α=0.05 양측) 여야 통과.
 *
 *  [C] 부호검정: #{Δ_s > 0} 이 이항 p ≤ 0.05 여야 통과 (30시드 기준 ≥21 또는 ≤9).
 *
 *  [D] **MDD 게이트**: arm 의 MDD 가 기준 대비 +2%p 초과 악화면, Calmar 가 올라도
 *      "낙폭 방어" 서사로 채택하지 않는다. CAGR·MDD 기여를 분리해 적는다.
 *
 *  [E] 채택 = A·B·C 전부 통과 ∧ D 위반 없음. 하나라도 미달이면 **판정 불가 또는 기각**.
 *      전기간·IS·OOS **세 구간에서 방향이 일치**해야 최종 채택(J·K·집중도 선례).
 *
 * ⚠️ §1-F 실행 중 다른 노드 작업 금지.
 *
 * 실행:
 *   node mc-gap-rsivol-clean.mjs                                            (전기간)
 *   node mc-gap-rsivol-clean.mjs --from 20230102 --to 20241231 --tag IS
 *   node mc-gap-rsivol-clean.mjs --from 20250102 --to 20260724 --tag OOS
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
const pexecFile = promisify(execFile);

const CWD = String.raw`C:\claudeT\files`;
const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

// ── 사전 고정 (실행 후 변경 금지) ────────────────────────────────
const NSEED = 30;
const NPERT = 15;
const CONC = Number(argOf('--conc', 8));
const FROM = argOf('--from', '20230102');
const TO = argOf('--to', '20260724');
const TAG = argOf('--tag', '전기간');

const SEEDS = [101, 202, 303, 404, 505, 606, 707, 808, 909, 111,
  131, 151, 171, 191, 211, 231, 251, 271, 291, 311,
  331, 351, 371, 391, 411, 431, 451, 471, 491, 511].slice(0, NSEED);

const T = 'candles-daily-toss-clean.jsonl';
const GAPPOL = ['--gapaxis', '--scenpolicy', 'gap-pol.json'];
/** 현행 라이브 계약. rsivol 0 = strategy-contract.mjs:145 (2026-07-29 사용자 승인). */
const REF = ['--strategies', 'combo-v2', '--live-parity', '--skipneutralrsi',
  '--slots', '5', '--trail', '6', '--tp1r', '1', '--tp2r', '2', '--liveuni', '420',
  '--rsivol', '0', ...GAPPOL];
const COMMON = ['--no-freshness-check', '--from', FROM, '--to', TO];

const ARMS = [
  { key: 'ref', name: '기준 = 현행 라이브 (갭 on · rsivol 0)', file: T, args: REF, grp: 'ref' },
  // 갭정책 축 — GAPPOL 세 인자를 뺀다
  { key: 'gapoff', name: '★갭정책 off', file: T, args: REF.filter(a => !GAPPOL.includes(a)), grp: 'rule' },
  // rsivol 축 — 0 → 1.25 (되돌리기)
  { key: 'rsivol125', name: '★rsivol 1.25 (되돌림)', file: T,
    args: REF.map((a, i, arr) => (arr[i - 1] === '--rsivol' ? '1.25' : a)), grp: 'rule' },
];
for (let i = 1; i <= NPERT; i++) {
  const id = String(i).padStart(2, '0');
  ARMS.push({ key: `p${id}`, name: `[귀무] 교란 #${id}`, file: `pert-c${id}.jsonl`, args: REF, grp: 'null' });
}

const RE = /^combo-v2\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.-]+)%\s+(\d+)%\s+([\d.]+)일\s+([\d,]+)원/m;

async function runOne(arm, seed) {
  const args = ['--max-old-space-size=6144', 'backtest-swing.mjs',
    ...arm.args, '--candles', arm.file, ...COMMON, '--subsample', '0.8', '--seed', String(seed)];
  try {
    const { stdout } = await pexecFile(process.execPath, args,
      { cwd: CWD, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const m = stdout.match(RE);
    if (!m) return null;
    const cagr = +m[4], mdd = +m[5];
    return { seed, n: +m[1], win: +m[2], pf: +m[3], cagr, mdd,
      // ★ 시드별 Calmar — 이게 stats-auditor 가 지적한 핵심 누락이다
      calmar: mdd > 0 ? cagr / mdd : 0,
      final: Number(m[8].replace(/,/g, '')) };
  } catch { return null; }
}
async function pool(tasks, n) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) },
    async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}
const sum = (a) => a.reduce((s, v) => s + v, 0);
const avg = (a) => (a.length ? sum(a) / a.length : 0);
const sd = (a) => { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(sum(a.map(v => (v - m) ** 2)) / (a.length - 1)); };
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
function binomP2(k, n, p = 0.5) {   // 양측 이항 p (정확)
  const C = (n, k) => { let x = 1; for (let i = 0; i < k; i++) x = x * (n - i) / (i + 1); return x; };
  const pmf = (i) => C(n, i) * p ** i * (1 - p) ** (n - i);
  const t = pmf(k) * 1.0000001;
  let s = 0; for (let i = 0; i <= n; i++) if (pmf(i) <= t) s += pmf(i);
  return Math.min(1, s);
}

console.log(`=== 갭정책·rsivol 정제본 재검증 · ${TAG} ${FROM}~${TO} ===`);
console.log(`사전 고정: n_seed=${NSEED} · n_pert=${NPERT} · 소스=${T} (전 arm 명시)`);
console.log(`경험적 p 하한 = 1/(${NPERT}+1) = ${(1 / (NPERT + 1)).toFixed(4)}\n`);

const R = new Map();
for (const arm of ARMS) {
  process.stdout.write(`[${arm.key}] ${arm.name} ... `);
  const rows = (await pool(SEEDS.map(s => () => runOne(arm, s)), CONC)).filter(Boolean);
  // ★ (5) 시드 완전성 — 한 시드라도 빠지면 짝짓기가 깨진다. 80% 허용을 없앤다.
  if (rows.length !== SEEDS.length) {
    console.log(`\n\n⛔ 중단: ${arm.key} 유효시드 ${rows.length}/${SEEDS.length}. 짝짓기가 성립하지 않으므로 표를 만들지 않는다.`);
    process.exit(1);
  }
  const bySeed = new Map(rows.map(r => [r.seed, r]));   // ★ 위치 인덱스가 아니라 시드 키
  const cal = rows.map(r => r.calmar);
  R.set(arm.key, { ...arm, bySeed,
    cagrA: avg(rows.map(r => r.cagr)), mddA: avg(rows.map(r => r.mdd)),
    calSeedA: avg(cal), calSeedM: med(cal), calSeedSD: sd(cal),
    calRatio: avg(rows.map(r => r.mdd)) > 0 ? avg(rows.map(r => r.cagr)) / avg(rows.map(r => r.mdd)) : 0,
    trades: avg(rows.map(r => r.n)) });
  const x = R.get(arm.key);
  console.log(`체결 ${Math.round(x.trades)} · CAGR ${x.cagrA.toFixed(2)}% · MDD ${x.mddA.toFixed(2)}% · Calmar(시드평균) ${x.calSeedA.toFixed(3)} · Calmar(비율) ${x.calRatio.toFixed(3)}`);
}

const ref = R.get('ref');
/** 시드 키로 짝지은 Δ 계열 (Calmar / CAGR / MDD). */
function paired(key, field) {
  const a = R.get(key);
  return SEEDS.map(s => a.bySeed.get(s)[field] - ref.bySeed.get(s)[field]);
}

// ── [A] 경험적 귀무분포 ────────────────────────────────────────
const nullD = [];
for (let i = 1; i <= NPERT; i++) nullD.push(avg(paired(`p${String(i).padStart(2, '0')}`, 'calmar')));
const nullSorted = [...nullD].sort((a, b) => a - b);
console.log(`\n=== [A] 경험적 귀무분포 (교란 ${NPERT}벌 · 시드짝 ΔCalmar 평균) ===`);
console.log(`  평균 ${avg(nullD).toFixed(4)} · SD ${sd(nullD).toFixed(4)} · 범위 [${nullSorted[0].toFixed(3)}, ${nullSorted[nullSorted.length - 1].toFixed(3)}]`);
console.log(`  |Δ| 상위: ${[...nullD].map(Math.abs).sort((a, b) => b - a).slice(0, 5).map(v => v.toFixed(3)).join(' ')}`);
console.log(`  ※ 구 하네스의 "바닥 = max−min 스프레드" 환산값 = ${(nullSorted[nullSorted.length - 1] - nullSorted[0]).toFixed(3)}`);

console.log(`\n=== 요약표 ===`);
console.log(`구성                              체결   CAGR%   MDD%  Calmar(시드)  Calmar(비율)`);
console.log('─'.repeat(88));
for (const k of ['ref', 'gapoff', 'rsivol125']) {
  const a = R.get(k);
  console.log(`${a.name.padEnd(33)} ${String(Math.round(a.trades)).padStart(5)} ${a.cagrA.toFixed(2).padStart(7)} ${a.mddA.toFixed(2).padStart(6)} ${a.calSeedA.toFixed(3).padStart(12)} ${a.calRatio.toFixed(3).padStart(13)}`);
}

// ── 판정 ────────────────────────────────────────────────────────
const T_CRIT = 2.045;   // df=29, α=0.05 양측
for (const k of ['gapoff', 'rsivol125']) {
  const a = R.get(k);
  const dC = paired(k, 'calmar'), dG = paired(k, 'cagr'), dM = paired(k, 'mdd');
  const mC = avg(dC), seC = sd(dC) / Math.sqrt(dC.length), tC = seC > 0 ? mC / seC : 0;
  const pos = dC.filter(v => v > 0).length;
  const pSign = binomP2(pos, dC.length);
  const worse = nullD.filter(v => Math.abs(v) >= Math.abs(mC)).length;
  const pEmp = (worse + 1) / (NPERT + 1);
  const A = pEmp <= 1 / (NPERT + 1) + 1e-9;
  const B = Math.abs(tC) >= T_CRIT;
  const C = pSign <= 0.05;
  const mddWorse = avg(dM);          // + = arm 의 MDD 가 더 크다(악화)
  const D = mddWorse <= 2.0;

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`${a.name}   (기준 대비)`);
  console.log(`  ΔCalmar(시드짝) 평균 ${(mC >= 0 ? '+' : '') + mC.toFixed(4)} · SD ${sd(dC).toFixed(4)} · SE ${seC.toFixed(4)}`);
  console.log(`  ΔCAGR ${(avg(dG) >= 0 ? '+' : '') + avg(dG).toFixed(2)}%p · ΔMDD ${(mddWorse >= 0 ? '+' : '') + mddWorse.toFixed(2)}%p`);
  console.log(`  [A] 경험적 p = ${pEmp.toFixed(4)} (귀무 ${NPERT}벌 중 |Δ| 이상 ${worse}개) → ${A ? '✅ 바닥 초과' : '❌ 바닥 내 = 판정 불가'}`);
  console.log(`  [B] 짝 t = ${tC.toFixed(3)} (임계 ±${T_CRIT}) → ${B ? '✅ 통과' : '❌ 미통과'}`);
  console.log(`  [C] 부호 ${pos}/${dC.length} 양수 · 이항 p = ${pSign.toFixed(4)} → ${C ? '✅ 통과' : '❌ 미통과'}`);
  console.log(`  [D] MDD 게이트 (+2%p 초과 악화 금지) → ${D ? '✅ 통과' : `❌ 위반 (${mddWorse.toFixed(2)}%p 악화)`}`);
  const verdict = (A && B && C && D) ? '★ 통과 (단, 세 구간 방향 일치 필요)'
    : (!A ? '판정 불가 — 귀무분포와 구분되지 않는다' : '기각');
  console.log(`  ⇒ ${verdict}`);
  // 기여 분해 — Calmar 상승이 CAGR 때문인지 MDD 때문인지
  console.log(`  기여분해: CAGR ${avg(dG) >= 0 ? '기여' : '감소'} ${Math.abs(avg(dG)).toFixed(2)}%p · MDD ${mddWorse <= 0 ? '개선' : '악화'} ${Math.abs(mddWorse).toFixed(2)}%p`);
}

console.log(`\n※ 부호 해석: 두 arm 은 **현행에서 되돌린** 구성이다.`);
console.log(`   Δ < 0  → 되돌리면 나빠진다 = 현행(갭 on · rsivol 0)이 낫다 = 기존 채택이 정제본에서도 지지된다`);
console.log(`   Δ > 0  → 되돌리면 좋아진다 = 현행 규칙이 해롭다 = 라이브에서 빼야 한다`);
console.log(`   판정 불가 → 그 규칙은 근거 없이 라이브에 있는 상태다(무해할 수는 있으나 검증됐다고 말할 수 없다)`);
console.log(`※ 최종 채택은 전기간·IS·OOS 세 구간 방향 일치가 필요하다 (--tag IS / --tag OOS 로 별도 실행).`);
