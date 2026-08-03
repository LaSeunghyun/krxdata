/**
 * mc-flowtiming.mjs — 수급청산 **집행 시점** MC + 노이즈 바닥 동시측정 (2026-08-01)
 *
 * ═══ 왜 재는가 ═══
 * 라이브(stock-live.mjs)와 백테(backtest-swing.mjs)가 수급청산을 **다른 시점에 집행**한다.
 *   백테  `p.exitAtOpen = 'flow_break'` → **익일** 시가
 *   라이브 청산 루프에서 `createOrder` → **장중 즉시**(사실상 당일 시가)
 * 정보집합은 같다(둘 다 전일까지 확정 수급 — 수급 스냅샷은 18:00 KST 마감 후 1회).
 * 다른 것은 집행 시점이고 그 차이가 정확히 **1거래일**이다:
 *   신호는 X일 마감 후 확정 → 라이브 X+1 시가 / 백테 X+2 시가.
 * 즉 MC 로 채택된 값(MDD 22.3→20.5% · Calmar 1.65→1.82)은 **X+2 타이밍**의 것이고,
 * 라이브가 실제로 하는 X+1 타이밍은 한 번도 측정된 적이 없다.
 * 이건 2026-07-29 에 rsi2·hi120 에서 고친 "라이브만 실시간 = 미검증 괴리"와 같은 유형인데
 * 수급청산만 그 리팩터를 빠져나갔다.
 *
 * ═══ 단일경로 결과 (증거 아님 — 이 MC 를 돌리는 이유) ═══
 *   A 익일시가(백테 현행)  CAGR 30.3% MDD 34.4% Calmar 0.88  flow_break 101건 승률50% -614k
 *   B 당일시가(라이브)     CAGR 46.7% MDD 24.9% Calmar 1.88  flow_break 117건 승률58% +8,372k
 *   C 수급청산 off         CAGR 32.8% MDD 29.3% Calmar 1.12
 * B 가 크게 좋아 보이지만 **단일경로 승자가 MC 에서 죽은 사례가 누적 9건**이다.
 * 게다가 A 가 C 보다 나쁘다 = 검증된 규칙이 이 구간·이 설정에서는 해로워 보인다는 뜻이라
 * 원래 채택 근거(다른 구간·다른 설정)와도 대조가 필요하다.
 *
 * ═══ 판정 기준 (결과 보기 전 선언) ═══
 *   NOISE = off + 교란 3벌의 Calmar 스프레드. |ΔCalmar| > NOISE 여야 실질로 인정한다.
 *   · B 가 A 보다 실질 개선 → 라이브를 그대로 두고 **백테를 라이브에 맞춘다**(검증 기준을 옮긴다)
 *   · B 가 A 보다 실질 악화 → 라이브를 종가판정 경로로 옮긴다(원래 계획)
 *   · 노이즈 내 → 집행 시점은 무차별. 그러면 **백테와 일치시키는 쪽**(A)을 택한다.
 *     이유: 미검증 괴리를 남길 이유가 없고, 방향도 "거래를 늦추는" 쪽이라 통과 3축과 같다.
 *   · A 와 C 의 관계도 같이 본다 — 규칙 자체의 존치 여부가 걸린다.
 *
 * 실행: node mc-flowtiming.mjs [--seeds 30] [--conc 3]
 * ※ 메모리 규칙: MC 실행 중에는 다른 노드 작업을 띄우지 않는다(arm 이 0시드로 죽어 바닥이 오염된다).
 */
import { exec } from 'child_process';
import { promisify } from 'util';
const pexec = promisify(exec);

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const NSEED = Number(argOf('--seeds', 30));
const CONC = Number(argOf('--conc', 3));
const ALL_SEEDS = Array.from({ length: 90 }, (_, i) => 101 + i * 37);
const SEEDS = ALL_SEEDS.slice(0, NSEED);

const COMMON = '--no-freshness-check --from 20230102 --to 20260724';
const LIVE = '--strategies combo-v2 --live-parity --skipneutralrsi --slots 5 --trail 6 --tp1r 1 --tp2r 2 --liveuni 420 --rsivol 0 --stoppct 15';
const T = 'candles-daily-toss-clean.jsonl';
const FLOW = '--flowexit 0 --flowexitdays 10';

// ★ 2026-08-01 60시드 — 30시드에서 B(1.96) vs C(1.61) = Δ+0.35 가 바닥 0.380 **바로 아래**라
//   판정 불가였다. 경계값에서는 기각·채택이 아니라 **시드를 늘리는 것**이 올바른 대응이다
//   (손절 15% 가 30시드 미통과 → 60시드 통과로 갈린 전례). 바닥은 시드를 늘리면 좁아진다.
//   기준선을 **B(=라이브 실동작, 이제 백테 기본값)** 로 바꾼다 — 존치 여부를 그 기준에서 묻는다.
// ★ 2026-08-02 손절 집행시점. 사용자 질문("-15% 인데 -30% 에 체결되는 이유")에서 나온 축이다.
//   판정은 15:35 종가인데 집행이 익일 시가라 그 사이 갭만큼 실현이 벌어지고 상한이 없다.
//   KRX 마감 후에도 NXT 애프터마켓(15:40~20:00)이 열려 있으니 당일 청산이 가능하다.
//   단일경로: off 1.88 / stop 1.97 / all 0.34 — all 은 트레일·만기가 무너져 즉시 기각(측정 불필요).
//   stop 만 Δ+0.09 로 바닥 아래라 MC 로 가른다.
const CONFIGS = [
  { key: 'base', name: '현행 (손절도 익일 시가)', file: T, extra: FLOW, grp: 'rule' },
  { key: 'sd', name: '손절만 당일 종가 집행', file: T, extra: `${FLOW} --exitsameday stop`, grp: 'rule' },
  { key: 'n1', name: '[바닥] 현행 · 교란 #1', file: 'candles-pert-1.jsonl', extra: FLOW, grp: 'noise' },
  { key: 'n2', name: '[바닥] 현행 · 교란 #2', file: 'candles-pert-2.jsonl', extra: FLOW, grp: 'noise' },
  { key: 'n3', name: '[바닥] 현행 · 교란 #3', file: 'candles-pert-3.jsonl', extra: FLOW, grp: 'noise' },
];

const RE = /combo-v2\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.]+)%/;

async function runOne(cfg, seed) {
  const cmd = `node --max-old-space-size=6144 backtest-swing.mjs ${LIVE} --candles ${cfg.file} ${cfg.extra} ${COMMON} --subsample 0.8 --seed ${seed}`;
  try {
    const { stdout } = await pexec(cmd, { cwd: 'C:\\claudeT\\files', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const m = stdout.match(RE);
    if (!m) return null;
    return { n: +m[1], win: +m[2], pf: +m[3], cagr: +m[4], mdd: +m[5] };
  } catch (e) { console.error(`  ! ${cfg.key} seed${seed}: ${String(e.message).slice(0, 60)}`); return null; }
}
async function pool(tasks, n) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

console.log(`=== 수급청산 집행시점 ${SEEDS.length}시드 MC + 노이즈 바닥 ===`);
console.log(`${COMMON} · subsample 0.8 · 기준선 = A(익일시가, 백테 검증본)\n`);

const R = [];
for (const cfg of CONFIGS) {
  process.stdout.write(`[${cfg.key}] ${cfg.name} ... `);
  const rows = (await pool(SEEDS.map(s => () => runOne(cfg, s)), CONC)).filter(Boolean);
  const cagr = rows.map(r => r.cagr), mdd = rows.map(r => r.mdd);
  const cA = avg(cagr), mA = avg(mdd);
  R.push({ ...cfg, nSeed: rows.length, cagrs: cagr, mdds: mdd, cagrA: cA, cagrM: med(cagr), mddA: mA,
           calmar: mA > 0 ? cA / mA : 0, win: avg(rows.map(r => r.win)), trades: avg(rows.map(r => r.n)) });
  console.log(`${rows.length}시드 · 체결 ${Math.round(avg(rows.map(r => r.n)))} · CAGR ${cA.toFixed(2)}% · MDD ${mA.toFixed(2)}% · Calmar ${(mA > 0 ? cA / mA : 0).toFixed(2)}`);
}

// ★ 시드수가 안 채워진 arm 이 있으면 바닥이 오염된다 — 판정 전에 먼저 막는다(2026-07-31 교훈).
const short = R.filter(r => r.nSeed < SEEDS.length);
if (short.length) {
  console.log(`\n🚨 시드 미충족 arm ${short.length}건 — 판정 불가. ${short.map(r => `${r.key}(${r.nSeed}/${SEEDS.length})`).join(' ')}`);
  console.log('   다른 노드 작업이 떠 있었거나 메모리가 부족했다. 단독 재실행 필요.');
  process.exit(1);
}

const base = R.find(r => r.key === 'base');
const noise = R.filter(r => r.grp === 'noise');
const floorSet = [base.calmar, ...noise.map(r => r.calmar)];
const NOISE = Math.max(...floorSet) - Math.min(...floorSet);

console.log('\n=== 결과 ===');
console.log('구성                              체결   CAGR(평균/중앙)   MDD     Calmar   Δ vs A');
console.log('─'.repeat(96));
for (const r of R) {
  const d = r.calmar - base.calmar;
  const mark = r.grp === 'noise' ? '   (바닥측정)' : (r.key === 'next' ? '   (기준선)' : (Math.abs(d) > NOISE ? (d > 0 ? '  ★실질개선' : '  ★실질악화') : '  (노이즈내)'));
  console.log(`${r.name.padEnd(32)} ${String(Math.round(r.trades)).padStart(5)} ${(r.cagrA.toFixed(1) + '% / ' + r.cagrM.toFixed(1) + '%').padStart(16)} ${(r.mddA.toFixed(1) + '%').padStart(7)} ${r.calmar.toFixed(2).padStart(8)} ${((d >= 0 ? '+' : '') + d.toFixed(2)).padStart(8)}${mark}`);
}

console.log('\n=== 꼬리 위험 ===');
console.log('구성                          최악시드CAGR  최대MDD  CAGR<0  MDD>40%');
console.log('-'.repeat(76));
for (const r of R) {
  if (r.grp !== 'rule') continue;
  console.log(`${r.name.padEnd(28)} ${(Math.min(...r.cagrs).toFixed(1) + '%').padStart(12)} ${(Math.max(...r.mdds).toFixed(1) + '%').padStart(8)} ${String(r.cagrs.filter(v => v < 0).length + '/' + r.cagrs.length).padStart(7)} ${String(r.mdds.filter(v => v > 40).length + '/' + r.mdds.length).padStart(8)}`);
}

console.log(`\n=== 노이즈 바닥 ===`);
console.log(`A + 교란 3벌 Calmar: ${floorSet.map(v => v.toFixed(2)).join(' / ')}`);
console.log(`NOISE = ${NOISE.toFixed(3)}  (이 값보다 작은 Δ 는 판정 불가)`);

console.log(`\n=== 판정 ===`);
const sd = R.find(r => r.key === 'sd');
const seedWin = (a, b) => a.cagrs.filter((v, i) => v > (b.cagrs[i] ?? Infinity)).length;
const d = sd.calmar - base.calmar;
const w = seedWin(sd, base);
console.log(`손절 당일집행 vs 현행: ΔCalmar ${d >= 0 ? '+' : ''}${d.toFixed(2)} · 시드 ${w}승 ${SEEDS.length - w}패`);
console.log(`노이즈 바닥 ${NOISE.toFixed(3)} · |Δ| ${Math.abs(d).toFixed(3)} → ${Math.abs(d) > NOISE ? '판정 가능' : '바닥 안 · 판정 불가'}`);
console.log('');
console.log('꼬리 비교 (손절 축은 평균이 아니라 꼬리로 판단한다):');
console.log(`  최악시드 CAGR  현행 ${Math.min(...base.cagrs).toFixed(1)}%  →  당일집행 ${Math.min(...sd.cagrs).toFixed(1)}%`);
console.log(`  최대 MDD       현행 ${Math.max(...base.mdds).toFixed(1)}%  →  당일집행 ${Math.max(...sd.mdds).toFixed(1)}%`);
console.log('');
if (Math.abs(d) <= NOISE) {
  console.log('→ 바닥 안. 집행 시점 변경의 **평균 효과는 확립되지 않는다.**');
  console.log('   꼬리가 명확히 나으면 그것만으로 채택할 수 있다(갭 위험 축소가 이 변경의 목적이므로).');
  console.log('   꼬리도 무차별이면 **현행 유지** — 백테가 못 재는 NXT 유동성 비용이 남아 있으므로');
  console.log('   측정되지 않은 이득으로 검증된 경로를 바꿀 근거가 없다.');
} else if (d > 0) {
  console.log('→ 당일 집행이 실질 우위. 단 배포 전에 NXT 애프터마켓 유동성 비용을 별도 확인해야 한다');
  console.log('   (백테는 종가 전량체결을 가정 — 실제로는 부분체결·슬리피지가 난다).');
} else {
  console.log('→ 당일 집행이 실질 열위. **현행 유지**(익일 시가).');
}
console.log('※ 한계: Toss 일봉 종가는 20:00 NXT 애프터 종가이고 라이브 판정은 15:35 다. 이 측정의');
console.log('   "당일 종가 집행"은 "15:40 즉시 체결"이 아니라 애프터마켓 종료 시점에 가깝다.');
