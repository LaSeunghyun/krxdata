/**
 * mc-regimeexp.mjs — 레짐별 총 노출 스로틀 60시드 MC + 노이즈 바닥 (2026-08-03)
 *
 * ═══ 왜 이 축인가 ═══
 * 사용자 질문: "코스피 5% 빠지는데 타점으로 산 이유는? 조금 더 천천히 사도 됐던 거 아닐까"
 * "천천히 사기"(--maxnew, 일일 신규진입 상한)는 **이미 측정돼 기각됐다** — 1/2/3건 모두
 *   ΔCalmar +0.07/+0.06/-0.01 vs 바닥 0.174 = 전부 노이즈 내. 1건으로 조여 체결이 45% 줄었는데도
 *   MDD 방어가 안 됐다(24.43% vs 바닥권). "천천히 사면 덜 물린다"는 데이터에서 미지지.
 * 같은 파일에 방향을 설명하는 측정이 있다 — **낙폭이 깊을수록 rsi2 +5일 성과가 좋아진다**
 *   (DOWN -0.21% → +2.46%, 승률 44→56%, 5버킷 단조). 얕은 낙폭을 골라 사는 게 더 나빴다
 *   (--rsimaxdd20 15 → CAGR 48.6→37.9% · MDD 15.3→19.9%). 예외는 -50% 초과 버킷 하나뿐.
 *
 * 그래서 남는 질문은 "진입 속도"가 아니라 **총 노출**이다. `--regimeexp` 는 레짐별 투자비율을
 * 낮춰 perSlot 을 줄이고 나머지를 현금으로 남긴다 — 진입 건수를 막는 게 아니라 **크기를 줄인다.**
 * 성질이 다른 축이고 **아직 한 번도 측정되지 않았다**(2026-07-22 구현, mc-exposure 에도 없음).
 *
 * ═══ 판정 기준 (결과 보기 전 선언) ═══
 *   NOISE = 현행(풀투자) + 교란 3벌의 Calmar 스프레드. |ΔCalmar| > NOISE 여야 실질.
 *   · 통과 → 라이브에 이식(strategy-contract 에 REGIME_EXP 신설). 단 라이브엔 이 배선이 없으므로
 *     이식 자체가 신규 코드다 = 별도 리뷰 필요.
 *   · 노이즈 내 → **현행 유지**. 그리고 그때는 "급락 대응으로 노출을 줄인다"는 축이
 *     --maxnew 와 함께 **둘 다 측정 실패**한 것이므로 그 방향을 종결한다.
 *   · 꼬리(최악시드·최대MDD)는 별도로 본다 — 노출 축의 목적이 평균이 아니라 꼬리이므로,
 *     평균이 노이즈 내여도 꼬리가 명확히 나으면 후보로 올린다(손절 15% 채택과 같은 논리).
 *
 * 실행: node mc-regimeexp.mjs [--seeds 60] [--conc 1]
 * ※ conc 는 1 을 권한다 — 2·3 에서 시드 탈락이 두 번 났고(08-02 next, 08-03 n2) 바닥이 오염된다.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
const pexec = promisify(exec);

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const NSEED = Number(argOf('--seeds', 60));
const CONC = Number(argOf('--conc', 1));
// ★ 2026-08-03: 부모 프로세스가 누적 ~300 자녀 spawn 이후 자원 고갈로 전 시드 실패하는 현상이 있다
//   (명령 단독 실행은 exit 0 · 디스크 194GB 여유 · 파일 무결 확인). arm 을 나눠 돌리기 위한 옵션.
//   --floor N : 노이즈 바닥을 직전 동일구성 측정본에서 가져온다(바닥 arm 스킵).
//     정당성 — 이 하네스와 mc-stoptiming 의 base·n1·n2·n3 는 LIVE·FLOW·COMMON·SEEDS·교란파일이
//     전부 동일하고 base Calmar 도 양쪽 1.95 로 일치한다. 즉 같은 측정을 두 번 할 이유가 없다.
const FLOOR_ARG = argOf('--floor', null);
const ALL_SEEDS = Array.from({ length: 90 }, (_, i) => 101 + i * 37);
const SEEDS = ALL_SEEDS.slice(0, NSEED);

const COMMON = '--no-freshness-check --from 20230102 --to 20260724';
const LIVE = '--strategies combo-v2 --live-parity --skipneutralrsi --slots 5 --trail 6 --tp1r 1 --tp2r 2 --liveuni 420 --rsivol 0 --stoppct 15';
const T = 'candles-daily-toss-clean.jsonl';
const FLOW = '--flowexit 0 --flowexitdays 10';

// UP,NEUTRAL,DOWN 투자비율. 현행은 전부 1.0(풀투자).
// DOWN 을 조이는 강도를 3단으로 본다 — 사용자 질문의 취지가 "급락장에 노출을 줄이자"이므로
// UP 은 1.0 으로 고정하고 DOWN·NEUTRAL 만 낮춘다(UP 을 조이면 상승장 수익을 버린다).
const CONFIGS_ALL = [
  { key: 'base', name: '현행 (풀투자 1.0/1.0/1.0)', file: T, extra: FLOW, grp: 'rule' },
  { key: 'd07', name: 'DOWN 0.7 (1.0/1.0/0.7)', file: T, extra: `${FLOW} --regimeexp 1.0,1.0,0.7`, grp: 'rule' },
  { key: 'd05', name: 'DOWN 0.5 (1.0/1.0/0.5)', file: T, extra: `${FLOW} --regimeexp 1.0,1.0,0.5`, grp: 'rule' },
  { key: 'nd', name: 'NEUTRAL·DOWN 조임 (1.0/0.7/0.5)', file: T, extra: `${FLOW} --regimeexp 1.0,0.7,0.5`, grp: 'rule' },
  { key: 'n1', name: '[바닥] 현행 · 교란 #1', file: 'candles-pert-1.jsonl', extra: FLOW, grp: 'noise' },
  { key: 'n2', name: '[바닥] 현행 · 교란 #2', file: 'candles-pert-2.jsonl', extra: FLOW, grp: 'noise' },
  { key: 'n3', name: '[바닥] 현행 · 교란 #3', file: 'candles-pert-3.jsonl', extra: FLOW, grp: 'noise' },
];

const CONFIGS = FLOOR_ARG ? CONFIGS_ALL.filter(c => c.grp === 'rule') : CONFIGS_ALL;

const RE = /combo-v2\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.]+)%/;

/**
 * ★ 2026-08-03: **일시 실패는 재시도한다.** 08-02~03 에 시드 탈락이 세 번 났고(conc 3·2·1),
 *   conc 1 에서도 났으므로 동시성 문제가 아니다. 상승 실패한 명령을 그대로 재현하면
 *   exit 0 으로 정상 종료한다 = 결정적 오류가 아니라 환경성 일시 실패다(모리 스파이크 추정).
 *   시드 하나가 빠지면 가드가 판정을 거부하고 전재(300런, 20분+)를 다시 돌려야 했다 —
 *   재시도 1회가 그 버용을 없얰준다. 실패 사유는 자를지지 않게 200자까지 남긴다.
 */
/** exec 실패의 **실제 사유**만 뽑는다. e.message 는 "Command failed: <명령 250자>" 로 시작해
 *  앞부분을 자르면 명령어만 보이고 오류가 안 보인다(08-03 진단이 그래서 막혔다). */
const errBrief = (e) => {
  const se = String(e?.stderr ?? '').trim();
  if (se) return se.slice(0, 200);
  const m = String(e?.message ?? '').split(String.fromCharCode(10)).slice(1).join(' ').trim();
  if (m) return m.slice(0, 200);
  return `code=${e?.code ?? '?'} signal=${e?.signal ?? '?'}`;
};
async function runOne(cfg, seed, attempt = 0) {
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
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

console.log(`=== 레짐별 노출 스로틀 ${SEEDS.length}시드 MC + 노이즈 바닥 ===`);
console.log(`${COMMON} · subsample 0.8 · 기준선 = 현행(풀투자)\n`);

const R = [];
for (const cfg of CONFIGS) {
  process.stdout.write(`[${cfg.key}] ${cfg.name} ... `);
  const rows = (await pool(SEEDS.map(s => () => runOne(cfg, s)), CONC)).filter(Boolean);
  const cagr = rows.map(r => r.cagr), mdd = rows.map(r => r.mdd);
  const cA = avg(cagr), mA = avg(mdd);
  R.push({ ...cfg, nSeed: rows.length, cagrs: cagr, mdds: mdd, cagrA: cA, cagrM: med(cagr), mddA: mA,
           calmar: mA > 0 ? cA / mA : 0, trades: avg(rows.map(r => r.n)) });
  console.log(`${rows.length}시드 · 체결 ${Math.round(avg(rows.map(r => r.n)))} · CAGR ${cA.toFixed(2)}% · MDD ${mA.toFixed(2)}% · Calmar ${(mA > 0 ? cA / mA : 0).toFixed(2)}`);
}

const short = R.filter(r => r.nSeed < SEEDS.length);
if (short.length) {
  console.log(`\n🚨 시드 미충족 arm ${short.length}건 — 판정 불가. ${short.map(r => `${r.key}(${r.nSeed}/${SEEDS.length})`).join(' ')}`);
  console.log('   --conc 를 낮춰 단독 재실행 필요(2·3 에서 두 번 탈락 전례).');
  process.exit(1);
}

const base = R.find(r => r.key === 'base');
const noiseArms = R.filter(r => r.grp === 'noise');
const floorSet = FLOOR_ARG ? null : [base.calmar, ...noiseArms.map(r => r.calmar)];
const NOISE = FLOOR_ARG ? Number(FLOOR_ARG) : (Math.max(...floorSet) - Math.min(...floorSet));

console.log('\n=== 결과 ===');
console.log('구성                              체결   CAGR(평균/중앙)   MDD     Calmar   Δ vs 현행');
console.log('─'.repeat(98));
for (const r of R) {
  const d = r.calmar - base.calmar;
  const mark = r.grp === 'noise' ? '   (바닥측정)' : (r.key === 'base' ? '   (기준선)' : (Math.abs(d) > NOISE ? (d > 0 ? '  ★실질개선' : '  ★실질악화') : '  (노이즈내)'));
  console.log(`${r.name.padEnd(32)} ${String(Math.round(r.trades)).padStart(5)} ${(r.cagrA.toFixed(1) + '% / ' + r.cagrM.toFixed(1) + '%').padStart(16)} ${(r.mddA.toFixed(1) + '%').padStart(7)} ${r.calmar.toFixed(2).padStart(8)} ${((d >= 0 ? '+' : '') + d.toFixed(2)).padStart(9)}${mark}`);
}

console.log('\n=== 꼬리 위험 (노출 축의 목적은 평균이 아니라 꼬리다) ===');
console.log('구성                          최악시드CAGR  최대MDD  CAGR<0  MDD>40%');
console.log('-'.repeat(76));
for (const r of R) {
  if (r.grp !== 'rule') continue;
  console.log(`${r.name.padEnd(28)} ${(Math.min(...r.cagrs).toFixed(1) + '%').padStart(12)} ${(Math.max(...r.mdds).toFixed(1) + '%').padStart(8)} ${String(r.cagrs.filter(v => v < 0).length + '/' + r.cagrs.length).padStart(7)} ${String(r.mdds.filter(v => v > 40).length + '/' + r.mdds.length).padStart(8)}`);
}

console.log(`\n=== 노이즈 바닥 ===`);
// ★ --floor 로 바닥값을 주입하면 floorSet 은 null 이다(130행). 여기서 무조건 .map 하면
//   **모든 arm 결과를 다 찍은 뒤 판정 직전에** TypeError 로 죽어 정작 판정을 잃는다(2026-08-03 실측).
console.log(floorSet
  ? `현행 + 교란 3벌 Calmar: ${floorSet.map(v => v.toFixed(2)).join(' / ')}`
  : `바닥 주입값 사용(--floor) — 이 실행에서 교란 arm 은 돌리지 않았다`);
console.log(`NOISE = ${NOISE.toFixed(3)}`);

console.log(`\n=== 판정 ===`);
const seedWin = (a, b) => a.cagrs.filter((v, i) => v > (b.cagrs[i] ?? Infinity)).length;
const rules = R.filter(r => r.grp === 'rule' && r.key !== 'base');
let anyPass = false;
for (const r of rules) {
  const d = r.calmar - base.calmar, w = seedWin(r, base);
  const pass = Math.abs(d) > NOISE;
  if (pass && d > 0) anyPass = true;
  console.log(`${r.name.padEnd(32)} ΔCalmar ${(d >= 0 ? '+' : '') + d.toFixed(2)} · 시드 ${w}승 ${SEEDS.length - w}패 · MDD ${base.mddA.toFixed(1)}%→${r.mddA.toFixed(1)}% · 최악시드 ${Math.min(...base.cagrs).toFixed(1)}%→${Math.min(...r.cagrs).toFixed(1)}% → ${pass ? (d > 0 ? '실질 개선' : '실질 악화') : '노이즈 내'}`);
}
console.log('');
if (anyPass) {
  console.log('→ 통과 구성이 있다. 다만 **라이브에는 이 배선이 없다**(REGIME_EXP 는 백테 전용) —');
  console.log('   이식은 신규 코드이므로 별도 리뷰가 필요하고, IS/OOS 분할로도 재확인해야 한다.');
} else {
  console.log('→ 전 구성 노이즈 내. **현행(풀투자) 유지.**');
  console.log('   그리고 이것으로 "급락 대응으로 노출·진입을 줄인다" 방향은 --maxnew 와 함께 **둘 다 측정 실패**다.');
  console.log('   진입 속도(--maxnew: Δ+0.07/+0.06/-0.01 vs 바닥 0.174)도, 총 노출(이 측정)도 효과가 없다.');
  console.log('   이 방향을 종결하고 기록한다 — 같은 축을 다시 제안하지 않기 위해서다.');
}
console.log('※ 꼬리가 평균과 갈리면 꼬리를 우선한다(방어 축의 목적이 꼬리이므로). 그때는 후보로 올려 IS/OOS 로 간다.');
