/**
 * perturb-candles.mjs — 의미 없는 크기의 데이터 교란본 생성 (2026-07-30)
 *
 * ═══ 왜 ═══
 * 종가소스 MC에서 IS는 KRX가 지고(Calmar 1.67→1.50 · 시드 3승7패) OOS는 크게 이겼다(1.94→2.77 · 9승1패).
 * 그런데 **IS 구간의 두 데이터셋은 사실상 같다**: 종가 완전일치 88~91%, 평균|괴리| 0.03~0.04%.
 * NXT가 2025년부터 가동됐으니 IS는 거의 NXT 이전이다 → IS 비교는 검정력이 없는 축퇴된 검정이다.
 *
 * 그렇다면 그 1.67 vs 1.50 은 무엇인가? **경로 혼돈**일 수 있다.
 * 진입 하나가 틱 단위로 갈리면 슬롯 점유가 달라지고 이후 경로 전체가 갈라진다.
 * 그게 사실이면 이 리서치 프로그램의 측정 정밀도가 가정보다 훨씬 나쁘고,
 * 이 세션에서 기각한 45개 변종 중 일부는 노이즈 안에 있었다는 뜻이다.
 *
 * ═══ 교란 설계 (실측에 맞춤) ═══
 * IS에서 다른 행 비율 ≈ 12%, 그 행들의 평균 괴리 ≈ 0.030/0.12 ≈ 0.25% ≈ 1~2틱.
 * → 랜덤 FRAC(기본 0.12) 비율의 (종목,날짜) 종가를 **±1틱** 이동한다.
 *   1틱은 호가 최소단위 = 매수/매도 스프레드 안쪽이므로 의미상 무해하다.
 * 유효성 보존: 종가를 옮긴 뒤 고가/저가를 확장해 low <= close <= high 를 유지한다.
 * 시가·거래량은 건드리지 않는다(결정변수인 종가만 교란해 원인을 격리).
 *
 * 실행: node --max-old-space-size=4096 perturb-candles.mjs <src.jsonl> <dst.jsonl> <seed> [--frac 0.12]
 */
import { createReadStream, createWriteStream } from 'fs';
import readline from 'readline';

const [src, dst, seedArg] = process.argv.slice(2);
if (!src || !dst || !seedArg) { console.error('사용법: perturb-candles.mjs <src> <dst> <seed> [--frac 0.12]'); process.exit(1); }
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const FRAC = Number(argOf('--frac', '0.12'));
const SEED = Number(seedArg);

/** mulberry32 — 재현 가능한 PRNG. Math.random을 쓰면 교란본을 재생성할 수 없다. */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);

// KR 호가단위 (2023 개편) — stock-live.mjs tick()과 동일
const tick = (p) => (p < 2_000 ? 1 : p < 5_000 ? 5 : p < 20_000 ? 10 : p < 50_000 ? 50 : p < 200_000 ? 100 : p < 500_000 ? 500 : 1_000);

const ws = createWriteStream(dst);
const rl = readline.createInterface({ input: createReadStream(src), crlfDelay: Infinity });
let nRow = 0, nPert = 0, nStock = 0;
let sumAbsPct = 0;

for await (const l of rl) {
  if (!l.trim()) continue;
  let j;
  try { j = JSON.parse(l); } catch { continue; }
  if (!j?.code || !Array.isArray(j.c)) continue;
  nStock++;
  for (let i = 0; i < j.c.length; i++) {
    nRow++;
    if (rnd() >= FRAC) continue;
    const c0 = j.c[i];
    if (!(c0 > 0)) continue;
    const t = tick(c0);
    const dir = rnd() < 0.5 ? -1 : 1;
    const c1 = c0 + dir * t;
    if (!(c1 > 0)) continue;
    j.c[i] = c1;
    // 유효성: low <= close <= high 유지
    if (j.h[i] < c1) j.h[i] = c1;
    if (j.l[i] > c1) j.l[i] = c1;
    nPert++;
    sumAbsPct += Math.abs(t / c0) * 100;
  }
  ws.write(JSON.stringify(j) + '\n');
}
await new Promise(r => ws.end(r));

console.log(`${src} → ${dst}  seed=${SEED} frac=${FRAC}`);
console.log(`  종목 ${nStock} · 행 ${nRow.toLocaleString()} · 교란 ${nPert.toLocaleString()} (${(nPert / nRow * 100).toFixed(2)}%)`);
console.log(`  교란된 행의 평균 |변화| ${(sumAbsPct / nPert).toFixed(4)}%  → 전체 행 기준 ${(sumAbsPct / nRow).toFixed(4)}%`);
console.log(`  ※ 참고: IS 구간 Toss vs KRX 실측은 전체행 기준 평균 |괴리| 0.030~0.041%`);
