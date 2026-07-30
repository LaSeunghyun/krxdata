/**
 * diag-krx-integrity.mjs — candles-daily-krx.jsonl 무결성 검사 (2026-07-30)
 *
 * 백테를 돌리기 전에 데이터를 신뢰할 수 있는지 기계적으로 확인한다.
 * 이 세션에서 조용한 데이터 결함으로 두 번 오진했다(날짜정렬 오진, 룩백 누락).
 *
 * 검사 항목:
 *  1) 행수 분포 — 전기간 상장 종목은 Toss와 같은 행수여야 한다. 적으면 신규상장/거래정지.
 *  2) 날짜 집합 정합 — KRX 날짜가 Toss 날짜의 부분집합인가. 아니면 거래일 정의가 다르다.
 *  3) **상위집합 제약(전 표본)** — 같은 날짜에서 Toss고가 >= KRX고가 AND Toss저가 <= KRX저가.
 *     Toss가 NXT 포함 세션이라는 확정 근거. 15종목 390건에서 100%였던 걸 전체로 확대 검증한다.
 *     위반이 나오면 수집 데이터가 오염됐거나(수정주가 설정 차이 등) 가설이 틀렸다.
 *  4) 값 위생 — 0/음수/NaN, 고가<저가, 종가가 고저 범위 밖.
 *  5) 종가 괴리 분포 — KRX vs Toss 종가 차이의 통계(앞서 15종목에서 평균|괴리| 0.81%였다).
 *
 * 실행: node --max-old-space-size=4096 diag-krx-integrity.mjs
 */
import { createReadStream, existsSync } from 'fs';
import readline from 'readline';

const KRX = 'candles-daily-krx.jsonl';
const TOSS = 'candles-daily.jsonl';
for (const f of [KRX, TOSS]) if (!existsSync(f)) { console.error(`${f} 없음`); process.exit(1); }

const loadInto = async (file, filter) => {
  const m = new Map();
  await new Promise((res) => {
    const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (l) => {
      if (!l.trim()) return;
      try {
        const j = JSON.parse(l);
        if (!j?.code || !Array.isArray(j.d)) return;
        if (filter && !filter.has(j.code)) return;
        m.set(j.code, j);                                  // 중복 라인은 나중 것이 이김(백테 loadPool과 동일)
      } catch {}
    });
    rl.on('close', res);
  });
  return m;
};

const krx = await loadInto(KRX, null);
console.log(`KRX ${krx.size}종목 로드`);
const toss = await loadInto(TOSS, new Set(krx.keys()));
console.log(`Toss ${toss.size}종목 로드 (KRX와 교집합)\n`);

// ── 1) 행수 ───────────────────────────────────────────────────────────────────
const rowDiff = [];
let sameRows = 0;
for (const [c, k] of krx) {
  const t = toss.get(c);
  if (!t) { rowDiff.push([c, k.d.length, null]); continue; }
  if (k.d.length === t.d.length) sameRows++;
  else rowDiff.push([c, k.d.length, t.d.length]);
}
console.log(`=== 1) 행수 ===`);
console.log(`Toss와 동일 행수 ${sameRows}/${krx.size} (${(sameRows / krx.size * 100).toFixed(1)}%)`);
console.log(`불일치 ${rowDiff.length}종목 · Toss 미보유 ${rowDiff.filter(r => r[2] === null).length}종목`);
if (rowDiff.length) {
  const shorter = rowDiff.filter(r => r[2] != null && r[1] < r[2]).length;
  const longer = rowDiff.filter(r => r[2] != null && r[1] > r[2]).length;
  console.log(`  KRX가 더 짧음 ${shorter} (신규상장·거래정지로 정상 가능) · KRX가 더 김 ${longer} (★비정상)`);
  for (const [c, kn, tn] of rowDiff.filter(r => r[2] != null && r[1] > r[2]).slice(0, 5)) console.log(`    ★ ${c} KRX ${kn} > Toss ${tn}`);
}

// ── 2~5) 날짜별 대조 ──────────────────────────────────────────────────────────
let nCmp = 0, viol = 0, hyg = 0, notInToss = 0;
const violEx = [], hygEx = [];
const absDiffs = [];
let signedSum = 0, exactMatch = 0;

for (const [c, k] of krx) {
  const t = toss.get(c);
  const tIdx = t ? new Map(t.d.map((d, i) => [String(d), i])) : null;
  for (let i = 0; i < k.d.length; i++) {
    const o = k.o[i], h = k.h[i], lo = k.l[i], cl = k.c[i];
    // 4) 값 위생
    if (![o, h, lo, cl].every(v => Number.isFinite(v) && v > 0) || h < lo || cl > h || cl < lo || o > h || o < lo) {
      hyg++; if (hygEx.length < 6) hygEx.push(`${c} ${k.d[i]} o=${o} h=${h} l=${lo} c=${cl}`);
      continue;
    }
    if (!tIdx) continue;
    const j = tIdx.get(String(k.d[i]));
    if (j == null) { notInToss++; continue; }
    nCmp++;
    // 3) 상위집합 제약
    if (!(t.h[j] >= h && t.l[j] <= lo)) {
      viol++;
      if (violEx.length < 8) violEx.push(`${c} ${k.d[i]} TossH ${t.h[j]} vs KrxH ${h} | TossL ${t.l[j]} vs KrxL ${lo}`);
    }
    // 5) 종가 괴리
    const d = (t.c[j] / cl - 1) * 100;
    absDiffs.push(Math.abs(d)); signedSum += d;
    if (t.c[j] === cl) exactMatch++;
  }
}

console.log(`\n=== 4) 값 위생 ===`);
console.log(`위반 ${hyg}건 ${hyg ? '★' : '(없음)'}`);
for (const e of hygEx) console.log(`  ${e}`);

console.log(`\n=== 2) 날짜 정합 ===`);
console.log(`대조 가능 ${nCmp.toLocaleString()}건 · KRX에만 있는 날짜 ${notInToss.toLocaleString()}건`);
console.log(`  ※ Toss 파일이 20260724까지라 07-25~07-29는 KRX에만 있는 것이 정상이다.`);

console.log(`\n=== 3) 상위집합 제약 (Toss고가>=KRX고가 AND Toss저가<=KRX저가) ===`);
console.log(`표본 ${nCmp.toLocaleString()}건 · 만족 ${(nCmp - viol).toLocaleString()} (${((nCmp - viol) / nCmp * 100).toFixed(3)}%) · 위반 ${viol.toLocaleString()} (${(viol / nCmp * 100).toFixed(3)}%)`);
for (const e of violEx) console.log(`  ★ ${e}`);

absDiffs.sort((a, b) => a - b);
const q = (p) => absDiffs[Math.floor(absDiffs.length * p)];
console.log(`\n=== 5) 종가 괴리 (Toss/KRX - 1) ===`);
console.log(`완전일치 ${exactMatch.toLocaleString()}/${nCmp.toLocaleString()} = ${(exactMatch / nCmp * 100).toFixed(1)}%  (= 그날 NXT 거래 없음)`);
console.log(`부호포함 평균 ${(signedSum / nCmp).toFixed(4)}%  ← 0에 가까우면 편향 아닌 노이즈`);
console.log(`평균 |괴리| ${(absDiffs.reduce((s, v) => s + v, 0) / absDiffs.length).toFixed(4)}%`);
console.log(`|괴리| p50 ${q(0.5).toFixed(3)}% · p90 ${q(0.9).toFixed(3)}% · p99 ${q(0.99).toFixed(3)}% · 최대 ${absDiffs.at(-1).toFixed(2)}%`);

// ── 판정 ──────────────────────────────────────────────────────────────────────
console.log(`\n=== 판정 ===`);
const pass = hyg === 0 && viol / nCmp < 0.001 && rowDiff.filter(r => r[2] != null && r[1] > r[2]).length === 0;
if (pass) {
  console.log(`통과 — 데이터를 백테에 쓸 수 있다.`);
  console.log(`  · 값 위생 위반 0`);
  console.log(`  · 상위집합 제약 위반율 ${(viol / nCmp * 100).toFixed(3)}% < 0.1% → Toss=NXT통합 가설이 전 표본에서 유지`);
  console.log(`  · KRX가 Toss보다 긴 종목 0 (날짜 오염 없음)`);
} else {
  console.log(`★ 미통과 — 아래를 해결하기 전에 백테를 돌리면 안 된다.`);
  if (hyg) console.log(`  · 값 위생 위반 ${hyg}건`);
  if (viol / nCmp >= 0.001) console.log(`  · 상위집합 제약 위반율 ${(viol / nCmp * 100).toFixed(3)}% >= 0.1%`);
}
