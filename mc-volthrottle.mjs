/**
 * mc-volthrottle.mjs — 2026-08-08 포트폴리오 변동성 타게팅 축 검정 · 30시드 MC + 노이즈 바닥 동시측정
 *
 * strategy-explorer 후보 4 ("volatility-throttle.mjs 가 --volshadow 로 배선돼 있는데 MC 판정 기록이 없다").
 * 레드팀 판정 = **조건부 통과**. 후보 4개 중 유일하게 새 계좌·새 상품·새 데이터 없이 지금 잴 수 있다.
 *
 * ═══ 배선 실측 (2026-08-08, MC 전 단일경로 1런 · §3 필수 절차) ═══
 *
 *   ★ `--volshadow` 는 shadow 가 아니다. 이름과 달리 **실제로 예산을 곱한다** —
 *     backtest-swing.mjs:1039 `Math.floor(eq / sl * volMult)` 와 :1557 `exposureMultiplier: volMult * atrM`.
 *     "기록만 한다"로 읽으면 오독한다. shadowStats(:1042)는 부수 계측일 뿐이다.
 *
 *   ★ 승수는 구조적으로 항상 ≤ 1 이다 — volatility-throttle.mjs `return Math.min(1, ref / current)`.
 *     변동성이 낮을 때 노출을 **늘리지 않는다.** 즉 이 축은 순수하게 "거래를 줄이는" 방향이고,
 *     통과 3축(손절15·갭trail10·NEUTRAL rsi2 스킵)의 공통점과 부합한다.
 *
 *   실측 (단일경로, 2023-01-02~2026-07-24, live-parity 인자):
 *     off  체결 1152 · 승률 61% · PF 1.32 · CAGR 42.00% · MDD 23.40% · Calmar 1.79 · 최종 34,102,050
 *     on   체결 1281 · 승률 60% · PF 1.29 · CAGR 29.30% · MDD 18.70% · Calmar 1.57 · 최종 24,555,840
 *          avgMult 0.825 · minMult 0.351 · days 868
 *   ⇒ 최종자본이 다르다 = **죽은 코드 아님**(--rotate 전례 회피 확인).
 *   ⇒ avgMult 0.825 = 평균 17.5% 노출 축소인데 CAGR 은 30% 상대 감소(42.0→29.3). 복리 비선형.
 *   ⇒ 단일경로 ΔCalmar **-0.22** 는 바닥(구간별 0.27~0.49) 이내 = **판정 불가**. MC 가 필요한 이유가 이것.
 *
 * ═══ ⚠️ 미충족 전제 — 실행 전 반드시 해소할 것 ═══
 *
 *   **항등 대조군을 기존 플래그로 만들 수 없다.** `min(1, ref/current)` 를 1 로 고정할 파라미터가 없다.
 *   `--volshadow 0` 은 다른 코드 경로(`: 1`)라 "기능 off"이지 "기능 on 인데 값이 1"이 아니다 —
 *   §2 가 요구하는 항등 대조군이 아니다.
 *
 *   필요한 최소 수정 1건 (backtest-swing.mjs):
 *     :62 근처   + const VOL_FIXED = Number(argOf('--volfixed', 0));   // >0 이면 volMult 고정. 0=현행
 *     :1031      - const volMult = VOL_SHADOW && (k === 'combo' || k === 'combo-v2') ? ... : 1;
 *                + const volMult = VOL_FIXED > 0 ? VOL_FIXED
 *                +   : (VOL_SHADOW && (k === 'combo' || k === 'combo-v2') ? volatilityThrottleMultiplier(...) : 1);
 *   이 플래그 하나가 두 대조군을 동시에 준다:
 *     `--volfixed 1`     = 항등 대조군 (기준선과 최종자본 **원 단위 동일**해야 한다)
 *     `--volfixed 0.825` = 상수 노출 대조군 (스로틀의 avgMult 와 같은 평균 노출, **타이밍 정보만 제거**)
 *   두 번째가 이 축의 진짜 판정면이다 — 집중도 축에서 얻은 법칙의 대칭형:
 *   **"선별력 없는 집중은 레버리지와 수학적으로 같다"의 뒷면 = 타이밍 정보 없는 스로틀은
 *     단순 디레버리징과 수학적으로 같다."** 상수 arm 과 Calmar 가 같으면 이 축은 정보가 0이다.
 *
 *   ※ `--regimeexp 0.825,0.825,0.825` 로 근사하면 안 된다 — 적용 지점이 다르다(:1515 expFrac vs
 *     :1039/:1557 volMult). §9 "다르게 나오면서 다른 것을 잰다"에 정확히 해당한다.
 *
 * ═══ 판정 기준 (사전 선언 — 실행 후 수정 금지) ═══
 *
 *  [0] 항등 검증: `ident` arm 이 기준선과 최종자본 원 단위까지 동일하지 않으면 **즉시 중단.**
 *      배선이 의도와 다른 것을 하고 있다는 뜻이고, 그 상태의 표는 전부 무효다.
 *
 *  [1] 주 판정 = ΔCalmar vs 노이즈 바닥. |Δ| < 바닥이면 **판정 불가**(채택도 기각도 아님).
 *
 *  [2] ★ 상수 노출 게이트 (이 축 전용)
 *      throttle arm 의 ΔCalmar 가 `const825` arm 의 ΔCalmar 를 **노이즈 바닥만큼 초과**해야 한다.
 *      초과하지 못하면 "변동성 타이밍에 정보 없음 = 그냥 노출을 줄인 것"으로 적는다.
 *      이게 이 축의 핵심 질문이고, 없으면 MDD 개선을 정보로 오독한다.
 *
 *  [3] ★ 이웃값 플래토 (트레일 10% 위양성 선례)
 *      volWindow 20/30/45 중 **3개 이상이 같은 방향**이어야 채택 후보. 스파이크는 기각.
 *
 *  [4] IS/OOS 분할 — [1][2][3] 통과 arm 만 2단계로. 전기간 단일 측정은 강세장 OOS 승리로
 *      횡보장 IS 패배를 덮는다(J·K 선례 60승0패도 IS/OOS 에서 기각, 집중도 선례도 동일).
 *      IS 20230102~20241231 / OOS 20250102~20260724. **바닥은 구간마다 다시 잰다.**
 *
 *  [5] 사이징 축이라는 사전 정보를 병기한다 — 가장 가까운 선례 `--atrsize 3` 은 CAGR 16.8%로
 *      급감해 "리스크저감 레버만"으로 기각됐다. 이 저장소 결론 "엣지=진입품질이지 사이징 아님"과
 *      단일경로 ΔCalmar -0.22 를 근거로 **사전 기대는 낮다.** 그래도 재는 이유는 비용이 0 이기 때문이다.
 *
 *  [6] 시드승(paired)은 보조 지표로만 병기한다.
 *
 * ⚠️ §1-F MC 실행 중 다른 노드 작업 금지. 판정 전 전 arm 시드수 충족 확인(0시드 가드 내장).
 *
 * 실행:
 *   node mc-volthrottle.mjs --seeds 30                                    (전기간)
 *   node mc-volthrottle.mjs --seeds 30 --from 20230102 --to 20241231 --tag IS
 *   node mc-volthrottle.mjs --seeds 30 --from 20250102 --to 20260724 --tag OOS
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
// 상수 노출 대조군의 배수 = throttle 의 실측 avgMult. 구간을 바꾸면 그 구간의 avgMult 로 다시 잡을 것.
const CONSTMULT = argOf('--constmult', '0.825');
const ALL = [101, 202, 303, 404, 505, 606, 707, 808, 909, 111,
  131, 151, 171, 191, 211, 231, 251, 271, 291, 311,
  331, 351, 371, 391, 411, 431, 451, 471, 491, 511,
  531, 551, 571, 591, 611, 631, 651, 671, 691, 711,
  731, 751, 771, 791, 811, 831, 851, 871, 891, 911,
  931, 951, 971, 991, 1011, 1031, 1051, 1071, 1091, 1111];
const SEEDS = ALL.slice(0, NSEED);
const INITIAL = 10_000_000;

const COMMON = ['--no-freshness-check', '--from', FROM, '--to', TO];
/**
 * 라이브 계약 인자.
 *  · `--rsivol 0` = `strategy-contract.mjs:145` RSI_ENTRY_FILTER.volMin (2026-07-29 사용자 승인 변경)
 *  · ★ `--gapaxis --scenpolicy gap-pol.json` 포함 — 라이브 `stock-live.mjs:191 gapPolicyToday()` 가
 *    매일 005930 시가갭으로 G1/G2 면 trail 6→10 · tp 6/12→10/20 을 **상시 오버라이드**한다.
 *    이걸 빼면 라이브가 아닌 다른 전략을 기준선으로 삼게 된다.
 *    실측(정제본 전기간 단일경로): 없음 32.80%/29.30%/1.12 → 있음 36.40%/31.10%/**1.17** (체결 1152→1011).
 *
 * ⚠️ **단, 갭정책 자체의 채택 근거가 오염 소스 위에 있다** — `mc-gap.mjs`·`mc-gap2`·`mc-gap-is`·
 *   `mc-gapbound`·`mc-gaprsi` 5개가 전부 `--candles` 없이(= 기본값 `candles-daily.jsonl` = 가짜
 *   가격점프 18종목 포함) 측정했다. 원 채택 근거는 IS Calmar 1.19→1.77 · OOS 2.87→4.67 인데
 *   정제본 단일경로에서는 Δ+0.05 밖에 안 나온다.
 *   → 그래서 `nogap` arm 을 넣어 **같은 런에서 갭정책을 30시드로 재검증**한다. 공짜다.
 */
const GAPPOL = ['--gapaxis', '--scenpolicy', 'gap-pol.json'];
const LIVE = ['--strategies', 'combo-v2', '--live-parity', '--skipneutralrsi',
  '--slots', '5', '--trail', '6', '--tp1r', '1', '--tp2r', '2', '--liveuni', '420', '--rsivol', '0',
  ...GAPPOL];
const T = 'candles-daily-toss-clean.jsonl';
// 갭정책 해제용 — LIVE 에서 GAPPOL 세 인자를 빼는 arm 은 runOne 이 `dropGap` 으로 처리한다.

const CONFIGS = [
  { key: 'base',    name: '현행 (스로틀 off · 갭정책 on)', file: T, extra: [], grp: 'rule' },
  // ★ 갭정책 재검증 arm — 오염 소스로 채택된 규칙을 정제본 30시드로 다시 잰다(부수 산출, 비용 0)
  { key: 'nogap',   name: '[재검증] 갭정책 off',          file: T, extra: [], dropGap: true, grp: 'gap' },
  // [0] 항등 대조군 — --volfixed 미구현이면 이 arm 이 base 와 동일하게 나오지 않는다(위 헤더 참조)
  { key: 'ident',   name: '[항등] volfixed 1.0',        file: T, extra: ['--volfixed', '1'], grp: 'ident' },
  // [2] 상수 노출 대조군 — 타이밍 정보만 제거. 이 축의 진짜 판정면
  { key: 'const',   name: `[상수노출] volfixed ${CONSTMULT}`, file: T, extra: ['--volfixed', CONSTMULT], grp: 'ctrl' },
  // 본 arm + [3] 이웃값 플래토
  { key: 'vt30',    name: '★스로틀 win30 (기본)',       file: T, extra: ['--volshadow', '1', '--volwindow', '30'], grp: 'rule' },
  { key: 'vt20',    name: '스로틀 win20 (이웃)',        file: T, extra: ['--volshadow', '1', '--volwindow', '20'], grp: 'rule' },
  { key: 'vt45',    name: '스로틀 win45 (이웃)',        file: T, extra: ['--volshadow', '1', '--volwindow', '45'], grp: 'rule' },
  // 노이즈 바닥 — base 와 **같은 설정**(갭정책 on)이어야 한다. 설정이 다르면 바닥이 다른 것을 잰다.
  // 교란본 3벌은 전부 49MB = 정제본 유래(원본 110MB 아님) 확인 완료 → 모집단 일치.
  { key: 'n1', name: '[바닥] 현행 · 교란 #1', file: 'candles-pert-1.jsonl', extra: [], grp: 'noise' },
  { key: 'n2', name: '[바닥] 현행 · 교란 #2', file: 'candles-pert-2.jsonl', extra: [], grp: 'noise' },
  { key: 'n3', name: '[바닥] 현행 · 교란 #3', file: 'candles-pert-3.jsonl', extra: [], grp: 'noise' },
];

const RE = /^combo-v2\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.-]+)%\s+(\d+)%\s+([\d.]+)일\s+([\d,]+)원/m;
const REMULT = /avgMult=([\d.]+)\s+minMult=([\d.]+)\s+days=(\d+)/;

async function runOne(cfg, seed) {
  // dropGap: LIVE 에서 갭정책 3인자만 제거한다(다른 인자는 그대로) — 갭정책 재검증 arm 전용.
  const live = cfg.dropGap ? LIVE.filter(a => !GAPPOL.includes(a)) : LIVE;
  const args = ['--max-old-space-size=6144', 'backtest-swing.mjs',
    ...live, '--candles', cfg.file, ...cfg.extra, ...COMMON,
    '--subsample', '0.8', '--seed', String(seed)];
  try {
    const { stdout } = await pexecFile(process.execPath, args,
      { cwd: CWD, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const m = stdout.match(RE);
    if (!m) { console.error(`  ! ${cfg.key} s${seed}: 결과행 파싱 실패`); return null; }
    const mm = stdout.match(REMULT);
    return { n: +m[1], win: +m[2], pf: +m[3], cagr: +m[4], mdd: +m[5],
      final: Number(m[8].replace(/,/g, '')),
      avgMult: mm ? +mm[1] : null, minMult: mm ? +mm[2] : null, seed };
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

console.log(`=== 변동성 타게팅 축 검정 ${SEEDS.length}시드 MC · ${TAG} ${FROM}~${TO} ===`);
console.log(`상수 노출 대조군 배수 = ${CONSTMULT} (스로틀 실측 avgMult)\n`);

const R = [];
for (const cfg of CONFIGS) {
  process.stdout.write(`[${cfg.key}] ${cfg.name} ... `);
  const rows = (await pool(SEEDS.map(s => () => runOne(cfg, s)), CONC)).filter(Boolean);
  if (rows.length < Math.ceil(SEEDS.length * 0.8)) {
    console.log(`\n\n⛔ 중단: ${cfg.key} 유효시드 ${rows.length}/${SEEDS.length} (80% 미달). 결과표 생성 안 함.`);
    process.exit(1);
  }
  const cg = rows.map(r => r.cagr), md = rows.map(r => r.mdd), fin = rows.map(r => r.final);
  const cA = avg(cg), mA = avg(md);
  const mults = rows.map(r => r.avgMult).filter(v => v != null);
  R.push({ ...cfg, nSeed: rows.length, cg, md, fin,
    cagrA: cA, cagrM: med(cg), cagrMin: Math.min(...cg),
    mddA: mA, mddMax: Math.max(...md), mdd50: md.filter(v => v > 50).length,
    finMed: med(fin), finP5: pct(fin, 0.05), finMin: Math.min(...fin),
    lossRate: fin.filter(v => v < INITIAL).length / fin.length * 100,
    calmar: mA > 0 ? cA / mA : 0, win: avg(rows.map(r => r.win)), trades: avg(rows.map(r => r.n)),
    avgMult: mults.length ? avg(mults) : null });
  const r = R[R.length - 1];
  console.log(`${rows.length}시드 · 체결 ${Math.round(r.trades)} · CAGR ${cA.toFixed(2)}% · MDD ${mA.toFixed(2)}% · Calmar ${r.calmar.toFixed(2)}`
    + (r.avgMult != null ? ` · avgMult ${r.avgMult.toFixed(3)}` : ''));
}

const off = R.find(r => r.key === 'base');
const noise = R.filter(r => r.grp === 'noise');
const NOISE = Math.max(off.calmar, ...noise.map(r => r.calmar)) - Math.min(off.calmar, ...noise.map(r => r.calmar));
console.log(`\n노이즈 바닥(교란3벌+원본 Calmar 스프레드) = ${NOISE.toFixed(3)}`);

// ── [0] 항등 검증 — 실패하면 표를 그리지 않는다 ──────────────────────────
const ident = R.find(r => r.key === 'ident');
const identOk = ident && ident.fin.every((v, i) => v === off.fin[i]);
console.log(`\n[0] 항등 대조군: volfixed 1.0 vs 기준선 최종자본 전 시드 일치 = ${identOk ? '✅ 통과' : '❌ 불일치'}`);
if (!identOk) {
  const diffs = ident ? ident.fin.map((v, i) => v - off.fin[i]).filter(v => v !== 0).length : -1;
  console.log(`    불일치 시드 ${diffs}/${off.fin.length}. --volfixed 미구현이거나 배선이 의도와 다르다.`);
  console.log(`    ⛔ 이 상태의 판정은 무효다. 헤더의 최소 수정 1건을 먼저 적용할 것.`);
  process.exit(1);
}

console.log('\n구성                          체결  CAGR평균 CAGR중앙 최악시드  MDD평균  최대MDD MDD>50 Calmar     Δ   시드승');
console.log('─'.repeat(116));
for (const r of R) {
  const d = r.calmar - off.calmar;
  const wins = r.key === off.key ? '-' : `${r.cg.filter((v, i) => v > (off.cg[i] ?? -1e9)).length}/${r.nSeed}`;
  console.log(`${r.name.padEnd(27)} ${String(Math.round(r.trades)).padStart(5)} ${r.cagrA.toFixed(2).padStart(7)}% ${r.cagrM.toFixed(2).padStart(7)}% ${r.cagrMin.toFixed(2).padStart(7)}% ${r.mddA.toFixed(2).padStart(7)}% ${r.mddMax.toFixed(2).padStart(7)}% ${String(r.mdd50).padStart(5)} ${r.calmar.toFixed(2).padStart(6)} ${(r.key === off.key ? '' : (d >= 0 ? '+' : '') + d.toFixed(2)).padStart(6)} ${wins.padStart(7)}`);
}

console.log('\n=== 테일 분포 ===');
console.log('구성                          최종중앙        p5         최소   원금손실률');
console.log('─'.repeat(74));
for (const r of R) {
  console.log(`${r.name.padEnd(27)} ${r.finMed.toLocaleString().padStart(11)} ${r.finP5.toLocaleString().padStart(11)} ${r.finMin.toLocaleString().padStart(11)} ${(r.lossRate.toFixed(1) + '%').padStart(9)}`);
}

// ── 판정 ────────────────────────────────────────────────────────────────
const ctrl = R.find(r => r.key === 'const');
const dCtrl = ctrl ? ctrl.calmar - off.calmar : null;
console.log('\n=== 판정 ===');

// ── 부수 산출: 갭정책 재검증 (오염 소스로 채택된 규칙을 정제본 30시드로) ──────────
const ng = R.find(r => r.key === 'nogap');
if (ng) {
  const dGap = off.calmar - ng.calmar;   // base(갭 on) − nogap(갭 off) = 갭정책의 순효과
  const wins = off.cg.filter((v, i) => v > (ng.cg[i] ?? -1e9)).length;
  console.log(`\n[부수] 갭정책 재검증 (정제본 ${SEEDS.length}시드 · 오염 소스로 채택됐던 규칙)`);
  console.log(`  갭 off ${ng.cagrA.toFixed(2)}%/${ng.mddA.toFixed(2)}% Calmar ${ng.calmar.toFixed(2)}`
    + ` → 갭 on ${off.cagrA.toFixed(2)}%/${off.mddA.toFixed(2)}% Calmar ${off.calmar.toFixed(2)}`);
  console.log(`  ΔCalmar ${(dGap >= 0 ? '+' : '') + dGap.toFixed(3)} vs 바닥 ${NOISE.toFixed(3)} · 시드승 ${wins}/${off.nSeed} → `
    + (Math.abs(dGap) > NOISE ? (dGap > 0 ? '★유지 근거 있음' : '실질 악화 — 라이브에서 빼야 한다') : '판정 불가(노이즈 내) — 원 채택 근거 IS 1.19→1.77 / OOS 2.87→4.67 와 크게 다르다'));
  console.log(`  ※ 이 결과가 '판정 불가'거나 음수면 라이브 gapPolicyToday() 를 사용자 승인 하에 재검토해야 한다.`);
}

console.log(`\n상수 노출 대조군 ΔCalmar = ${dCtrl == null ? 'n/a' : (dCtrl >= 0 ? '+' : '') + dCtrl.toFixed(3)}  (타이밍 정보 0일 때의 기대치)`);

const vts = R.filter(r => r.grp === 'rule' && r.key.startsWith('vt'));
const dirs = vts.map(r => Math.sign(r.calmar - off.calmar));
const plateau = Math.abs(dirs.reduce((s, v) => s + v, 0)) === dirs.length && dirs.length >= 3;

for (const r of vts) {
  const d = r.calmar - off.calmar;
  const same = Math.abs(r.cagrA - off.cagrA) < 1e-9;
  const g1 = Math.abs(d) > NOISE;
  const g2 = dCtrl != null && (d - dCtrl) > NOISE;   // 상수 노출을 바닥만큼 초과
  console.log(`\n${r.name}${r.avgMult != null ? `  (avgMult ${r.avgMult.toFixed(3)})` : ''}`);
  console.log(`  [1] ΔCalmar ${(d >= 0 ? '+' : '') + d.toFixed(3)} vs 바닥 ${NOISE.toFixed(3)} → `
    + (same ? '기준선과 동일(배선 미적용 의심)' : g1 ? (d > 0 ? '★실질 개선' : '실질 악화') : '판정 불가(노이즈 내)'));
  console.log(`  [2] 상수노출 초과분 ${((d - (dCtrl ?? 0)) >= 0 ? '+' : '') + (d - (dCtrl ?? 0)).toFixed(3)} vs 바닥 ${NOISE.toFixed(3)} → `
    + (g2 ? '✅ 타이밍에 정보 있음' : '❌ 단순 디레버리징과 구분 불가'));
  console.log(`  [3] 이웃 플래토(win 20/30/45 동일 방향) → ${plateau ? '✅ 통과' : '❌ 미통과(스파이크)'}`);
  console.log(`  ⇒ ${g1 && d > 0 && g2 && plateau ? '[4] IS/OOS 분할 진행 대상' : '채택 불가'}`);
}
console.log('\n※ [4] IS/OOS 는 별도 실행: --from 20230102 --to 20241231 --tag IS / --from 20250102 --to 20260724 --tag OOS');
console.log('※ 구간을 바꾸면 --constmult 를 그 구간의 실측 avgMult 로 다시 잡을 것(대조군이 어긋난다).');
