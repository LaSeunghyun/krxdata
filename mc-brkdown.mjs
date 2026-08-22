/**
 * mc-brkdown.mjs — DOWN·NEUTRAL 레짐 hi120(돌파) 허용 60시드 MC + 노이즈 바닥 (2026-08-04)
 *
 * ═══ 왜 이 축인가 ═══
 * 사용자 관측: "오늘 아침 8시에 급등한 종목들을 내가 들고 있지 않아서 속상하다."
 * 실측으로 원인을 분해했다(diag-missed-move.mjs · diag-top-gainers.mjs):
 *   ① 급등은 바이오 섹터 집중. 상위 25종목 중 **8종목이 유니버스 안에 있었다** → 유니버스 문제 아님.
 *   ② 슬롯 5/5 만석·현금 55만(슬롯예산 300만) → 신호가 있었어도 살 자본이 없었다.
 *   ③ +25% 급등은 rsi2(2일 RSI<10 과매도)로 잡을 수 없다. 돌파를 잡는 건 hi120 뿐인데
 *      **캡 구성 A~F 전부 DOWN hi120=0** 이고 08-04 레짐이 DOWN 이라 아예 돌지 않았다.
 *
 * ③ 이 이 하네스의 대상이다. 그리고 그 차단은 **한 번도 측정되지 않았다** —
 * 여섯 구성 전부 DOWN hi120=0 이라 스윕으로 표현할 방법이 없었고 전용 플래그도 없다.
 * 반면 backtest-swing 주석 C20 은 "UP hi120이 전기간 최대 수익원 +26.3M" 이라고 기록한다.
 * 최대 수익원이 레짐 두 개에서 미검증으로 꺼져 있다 → 남은 축 중 근거가 있는 편이다.
 *
 * ═══ 사전 예상 (반증 대상으로 먼저 적는다) ═══
 * 기각될 가능성이 높다. 하락장 돌파 매수는 휩소가 사는 자리이고, 이 프로젝트에서 통과한 3건은
 * 전부 "거래를 줄이는" 방향(손절15%·갭trail10·NEUTRAL스킵)이었다. 이 축은 정반대다.
 * 그럼에도 **미검증인 것과 검증해서 기각된 것은 다르다.**
 *
 * ═══ 판정 기준 (결과 보기 전 선언) ═══
 *   NOISE = 현행(A) + 교란 3벌의 Calmar 스프레드. |ΔCalmar| > NOISE 여야 실질.
 *   · 통과(개선) → 후보로 올린다. 단 라이브 이식은 strategy-contract 의 LIVE_COMBO_CAPS 변경이라
 *     **검증된 기준선을 직접 바꾸는 일**이다 → IS/OOS 재확인 + 별도 리뷰 필수.
 *   · 노이즈 내 → 현행 유지. "하락장에서도 돌파를 산다" 축을 측정 완료로 종결·기록한다.
 *   · 꼬리(최악시드 CAGR·최대 MDD)를 별도로 본다. 이 축은 **공격적** 방향이라 평균이 좋아도
 *     꼬리가 나빠지면 채택하지 않는다(손절 당일집행·레짐노출 기각과 같은 논리).
 *
 * 실행: node mc-brkdown.mjs [--seeds 60] [--conc 1] [--floor 0.309]
 * ※ conc 1 권장 — 08-02·08-03 에 conc 2·3 에서 시드 탈락이 두 번 나 바닥이 오염됐다.
 * ※ --floor 0.309 는 08-03 mc-stoptiming/mc-regimeexp 에서 동일 구성(LIVE·FLOW·COMMON·교란파일·
 *   60시드)으로 측정한 값이다. base Calmar 가 양쪽 1.95 로 일치했으므로 재측정 대신 주입할 수 있다.
 *   단 주입하면 이 실행의 base 가 1.95 근처인지 **반드시 눈으로 확인**해야 한다(다르면 재측정).
 */
import { exec } from 'child_process';
import { promisify } from 'util';
const pexec = promisify(exec);

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const NSEED = Number(argOf('--seeds', 60));
const CONC = Number(argOf('--conc', 1));
const FLOOR_ARG = argOf('--floor', null);
const ALL_SEEDS = Array.from({ length: 90 }, (_, i) => 101 + i * 37);
const SEEDS = ALL_SEEDS.slice(0, NSEED);

const COMMON = '--no-freshness-check --from 20230102 --to 20260724';
const LIVE = '--strategies combo-v2 --live-parity --skipneutralrsi --slots 5 --trail 6 --tp1r 1 --tp2r 2 --liveuni 420 --rsivol 0 --stoppct 15';
const T = 'candles-daily-toss-clean.jsonl';
const FLOW = '--flowexit 0 --flowexitdays 10';

/**
 * arm = 캡 프리셋. G/H/I 는 backtest-swing.mjs CAPS_PRESETS 에 08-04 신설.
 *   A 현행 : UP{6,4} NEUTRAL{0,8} DOWN{0,4}
 *   G      : DOWN hi120 2 허용
 *   H      : DOWN hi120 4 허용 (강하게)
 *   I      : NEUTRAL·DOWN 둘 다 hi120 2 허용
 * ※ I 는 --skipneutralrsi 와 무관하다 — 그 플래그는 rsi2 만 막는다. NEUTRAL hi120 은 캡이 정한다.
 */
const CONFIGS_ALL = [
  { key: 'base', name: '현행 A (DOWN hi120 0)', file: T, extra: `${FLOW} --caps A`, grp: 'rule' },
  // G(DOWN 2)·H(DOWN 4) 는 08-04 60시드에서 ΔCalmar -0.64/-0.61 · 최악시드 23.9%→9.1%/6.2% 로
  // 기각 확정됐다. 재측정할 이유가 없어 arm 에서 뺀다(기록은 이 주석과 CAPS_PRESETS 에 남는다).
  { key: 'i', name: 'I · NEUTRAL+DOWN hi120 2', file: T, extra: `${FLOW} --caps I --brkreg UP,NEUTRAL,DOWN`, grp: 'rule' },
  { key: 'j', name: 'J · NEUTRAL만 hi120 2', file: T, extra: `${FLOW} --caps J --brkreg UP,NEUTRAL`, grp: 'rule' },
  { key: 'k', name: 'K · NEUTRAL만 hi120 4', file: T, extra: `${FLOW} --caps K --brkreg UP,NEUTRAL`, grp: 'rule' },
  { key: 'n1', name: '[바닥] 현행 · 교란 #1', file: 'candles-pert-1.jsonl', extra: `${FLOW} --caps A`, grp: 'noise' },
  { key: 'n2', name: '[바닥] 현행 · 교란 #2', file: 'candles-pert-2.jsonl', extra: `${FLOW} --caps A`, grp: 'noise' },
  { key: 'n3', name: '[바닥] 현행 · 교란 #3', file: 'candles-pert-3.jsonl', extra: `${FLOW} --caps A`, grp: 'noise' },
];
const CONFIGS = FLOOR_ARG ? CONFIGS_ALL.filter(c => c.grp === 'rule') : CONFIGS_ALL;

const RE = /combo-v2\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.]+)%/;

/** exec 실패의 실제 사유만 뽑는다. e.message 는 "Command failed: <명령 250자>" 로 시작해
 *  앞을 자르면 명령어만 보이고 오류가 안 보인다(08-03 에 이걸로 진단이 세 번 막혔다). */
const errBrief = (e) => {
  const se = String(e?.stderr ?? '').trim();
  if (se) return se.slice(0, 200);
  const m = String(e?.message ?? '').split(String.fromCharCode(10)).slice(1).join(' ').trim();
  if (m) return m.slice(0, 200);
  return `code=${e?.code ?? '?'} signal=${e?.signal ?? '?'}`;
};
async function runOne(cfg, seed, attempt = 0) {
  // 힙 2048MB. 08-03 실측: 실사용 피크 156~276MB 인데 6144 로 두면 여유 RAM 1.6GB 환경에서
  // V8 이 그 값을 근거로 예약·GC 전략을 잡아 **그 자체가 실패 요인**이 됐다(시드 5건 탈락).
  const cmd = `node --max-old-space-size=2048 backtest-swing.mjs ${LIVE} --candles ${cfg.file} ${cfg.extra} ${COMMON} --subsample 0.8 --seed ${seed}`;
  try {
    const { stdout } = await pexec(cmd, { cwd: 'C:\\claudeT\\files', encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    const m = stdout.match(RE);
    if (!m) {
      if (attempt < 1) { console.error(`  ~ ${cfg.key} seed${seed}: 파싱 실패 → 재시도`); return runOne(cfg, seed, attempt + 1); }
      console.error(`  ! ${cfg.key} seed${seed}: 파싱 실패(재시도 후)`); return null;
    }
    return { n: +m[1], win: +m[2], pf: +m[3], cagr: +m[4], mdd: +m[5] };
  } catch (e) {
    if (attempt < 1) { console.error(`  ~ ${cfg.key} seed${seed} 재시도: ${errBrief(e)}`); return runOne(cfg, seed, attempt + 1); }
    console.error(`  ! ${cfg.key} seed${seed} 실패(재시도 후): ${errBrief(e)}`); return null;
  }
}
async function pool(tasks, n) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

console.log(`=== DOWN·NEUTRAL hi120 허용 ${SEEDS.length}시드 MC + 노이즈 바닥 ===`);
console.log(`${COMMON} · subsample 0.8 · 기준선 = 현행 A(DOWN hi120 0)\n`);

const R = [];
for (const cfg of CONFIGS) {
  process.stdout.write(`[${cfg.key}] ${cfg.name} ... `);
  const rows = (await pool(SEEDS.map(s => () => runOne(cfg, s)), CONC)).filter(Boolean);
  const cagr = rows.map(r => r.cagr), mdd = rows.map(r => r.mdd), wins = rows.map(r => r.win);
  const cA = avg(cagr), mA = avg(mdd);
  R.push({ ...cfg, nSeed: rows.length, cagrs: cagr, mdds: mdd, cagrA: cA, cagrM: med(cagr), mddA: mA,
           winA: avg(wins), calmar: mA > 0 ? cA / mA : 0, trades: avg(rows.map(r => r.n)) });
  console.log(`${rows.length}시드 · 체결 ${Math.round(avg(rows.map(r => r.n)))} · 승률 ${avg(wins).toFixed(0)}% · CAGR ${cA.toFixed(2)}% · MDD ${mA.toFixed(2)}% · Calmar ${(mA > 0 ? cA / mA : 0).toFixed(2)}`);
}

const short = R.filter(r => r.nSeed < SEEDS.length);
if (short.length) {
  console.log(`\n🚨 시드 미충족 arm ${short.length}건 — 판정 불가. ${short.map(r => `${r.key}(${r.nSeed}/${SEEDS.length})`).join(' ')}`);
  console.log('   --conc 1 로 단독 재실행 필요.');
  process.exit(1);
}

const base = R.find(r => r.key === 'base');
const noiseArms = R.filter(r => r.grp === 'noise');
const floorSet = FLOOR_ARG ? null : [base.calmar, ...noiseArms.map(r => r.calmar)];
const NOISE = FLOOR_ARG ? Number(FLOOR_ARG) : (Math.max(...floorSet) - Math.min(...floorSet));

console.log('\n=== 결과 ===');
console.log('구성                              체결   승률   CAGR(평균/중앙)   MDD     Calmar   Δ vs 현행');
console.log('─'.repeat(104));
for (const r of R) {
  const d = r.calmar - base.calmar;
  const mark = r.grp === 'noise' ? '   (바닥측정)' : (r.key === 'base' ? '   (기준선)' : (Math.abs(d) > NOISE ? (d > 0 ? '  ★실질개선' : '  ★실질악화') : '  (노이즈내)'));
  console.log(`${r.name.padEnd(30)} ${String(Math.round(r.trades)).padStart(5)} ${(r.winA.toFixed(0) + '%').padStart(6)} ${(r.cagrA.toFixed(1) + '% / ' + r.cagrM.toFixed(1) + '%').padStart(16)} ${(r.mddA.toFixed(1) + '%').padStart(7)} ${r.calmar.toFixed(2).padStart(8)} ${((d >= 0 ? '+' : '') + d.toFixed(2)).padStart(9)}${mark}`);
}

console.log('\n=== 꼬리 위험 (공격 축이므로 평균이 좋아도 꼬리가 나쁘면 기각) ===');
console.log('구성                          최악시드CAGR  최대MDD  CAGR<0  MDD>40%');
console.log('-'.repeat(76));
for (const r of R) {
  if (r.grp !== 'rule') continue;
  console.log(`${r.name.padEnd(28)} ${(Math.min(...r.cagrs).toFixed(1) + '%').padStart(12)} ${(Math.max(...r.mdds).toFixed(1) + '%').padStart(8)} ${String(r.cagrs.filter(v => v < 0).length + '/' + r.cagrs.length).padStart(7)} ${String(r.mdds.filter(v => v > 40).length + '/' + r.mdds.length).padStart(8)}`);
}

console.log(`\n=== 노이즈 바닥 ===`);
console.log(floorSet
  ? `현행 + 교란 3벌 Calmar: ${floorSet.map(v => v.toFixed(2)).join(' / ')}`
  : `바닥 주입값 사용(--floor ${FLOOR_ARG}) — 교란 arm 미실행. base Calmar ${base.calmar.toFixed(2)} 가 1.95 근처인지 확인할 것`);
console.log(`NOISE = ${NOISE.toFixed(3)}`);

console.log(`\n=== 판정 ===`);
const seedWin = (a, b) => a.cagrs.filter((v, i) => v > (b.cagrs[i] ?? Infinity)).length;
const rules = R.filter(r => r.grp === 'rule' && r.key !== 'base');
let anyPass = false;
for (const r of rules) {
  const d = r.calmar - base.calmar, w = seedWin(r, base);
  const real = Math.abs(d) > NOISE;
  const tailOk = Math.min(...r.cagrs) >= Math.min(...base.cagrs) && Math.max(...r.mdds) <= Math.max(...base.mdds);
  if (real && d > 0 && tailOk) anyPass = true;
  console.log(`${r.name.padEnd(30)} ΔCalmar ${(d >= 0 ? '+' : '') + d.toFixed(2)} · 시드 ${w}승 ${SEEDS.length - w}패 · MDD ${base.mddA.toFixed(1)}%→${r.mddA.toFixed(1)}% · 최악시드 ${Math.min(...base.cagrs).toFixed(1)}%→${Math.min(...r.cagrs).toFixed(1)}% · 꼬리 ${tailOk ? 'OK' : '악화'} → ${real ? (d > 0 ? (tailOk ? '실질 개선' : '평균개선·꼬리악화 = 기각') : '실질 악화') : '노이즈 내'}`);
}
console.log('');
if (anyPass) {
  console.log('→ 통과 구성이 있다. 다만 이식은 **검증된 기준선(LIVE_COMBO_CAPS)을 직접 바꾸는 일**이다.');
  console.log('   IS/OOS 분할 재확인 + 별도 리뷰 없이 라이브에 넣지 않는다.');
  console.log('   그리고 자본 제약(슬롯 5/5 만석)은 별개 문제로 남는다 — 신호가 생겨도 살 돈이 없으면 소용없다.');
} else {
  console.log('→ 전 구성 노이즈 내 또는 꼬리 악화. **현행 A 유지(DOWN hi120 0).**');
  console.log('   "하락장에서도 돌파를 산다" 축을 측정 완료로 종결한다. 08-04 급등을 놓친 것은');
  console.log('   버그가 아니라 검증된 설계의 비용이다 — 그 국면에서 돌파를 사면 장기 성과가 나빠진다.');
}
