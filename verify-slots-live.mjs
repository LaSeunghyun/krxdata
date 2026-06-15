// 라이브 실동작(slots1) vs 동결(slots2) 익일시가 MC 재검증
// 적대적 감사 후속: 라이브 budgetEst=cash(전액)+hasOpenSlot(보유0)= de facto slots1.
// I3에서 slots1은 "테일 악화"로 기각된 구성 → 익일시가·최신데이터에서 paired MC로 정직 비교.
import { execSync } from 'node:child_process';

const SEEDS = Number(process.argv[2] ?? 40);
const SUB = process.argv[3] ?? '0.8';
const base = '--strategies combo-v2 --capital 30000 --atrsize 4 --caps D --entryopen 1';

function run(slots, seed) {
  const cmd = `node backtest-swing.mjs ${base} --slots ${slots} --seed ${seed} --subsample ${SUB}`;
  const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  // "combo-v2  ...  57,490원" 마지막 최종자본 컬럼 추출
  const m = out.match(/combo-v2\s+\d+\s+\d+%\s+[\d.]+\s+[\d.\-]+%\s+[\d.]+%\s+\d+%\s+[\d.]+일\s+([\d,]+)원/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)]; };
const stat = (arr) => ({
  n: arr.length, p5: pct(arr, 0.05), p25: pct(arr, 0.25), med: pct(arr, 0.5),
  p75: pct(arr, 0.75), p95: pct(arr, 0.95),
  ruin: (arr.filter(x => x < 30000).length / arr.length * 100).toFixed(1) + '%',
  min: Math.min(...arr),
});

const s1 = [], s2 = [];
let wins = 0; // slots2 > slots1 (paired)
for (let seed = 1; seed <= SEEDS; seed++) {
  const a = run(1, seed), b = run(2, seed);
  if (a == null || b == null) { console.error(`seed ${seed} parse fail`); continue; }
  s1.push(a); s2.push(b);
  if (b > a) wins++;
  if (seed % 10 === 0) console.error(`[${seed}/${SEEDS}] slots1 med~${pct(s1, .5)} / slots2 med~${pct(s2, .5)}`);
}

const z = (() => { const n = s1.length, k = wins, p = 0.5; return ((k - n * p) / Math.sqrt(n * p * (1 - p))).toFixed(2); })();
console.log(JSON.stringify({
  config: `익일시가 atrsize4 capsD, ${SEEDS}시드 subsample ${SUB}`,
  slots1_live: stat(s1),
  slots2_frozen: stat(s2),
  paired_slots2_beats_slots1: `${wins}/${s1.length} (z=${z})`,
}, null, 2));
