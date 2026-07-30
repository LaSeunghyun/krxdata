/**
 * diag-close-shift.mjs — Toss/KIS 종가 괴리가 날짜 정렬 문제인지 판정 (2026-07-30)
 *
 * diag-toss-kis-close.mjs 결과: 불일치 86.9% · 평균|괴리| 0.81% 인데
 *   · 부호포함 평균 괴리는 +0.0127% (거의 0) — 방향이 무작위다
 *   · 이상치가 위메이드 +15.88% · 에코프로 -10.98% · 현대차 -5.30%
 *   · 카카오는 26/26 완전일치
 * NXT 애프터마켓은 정규장 기준 가격제한이 걸려 15% 괴리를 만들 수 없고,
 * NXT 통합이라면 카카오만 완전일치할 이유도 없다 → **NXT 가설 반증.**
 *
 * 남은 가설:
 *   (C) 날짜 정렬 오차 — Toss d[i]의 종가가 실제로는 다른 날짜의 종가
 *   (D) 수정주가 처리 차이 (KIS FID_ORG_ADJ_PRC='1'=원주가 vs Toss 수정주가)
 *   (E) 내 로더 버그 — j.d[] 와 j.c[] 길이 불일치로 인덱스가 밀림
 *
 * 방법: (E)를 먼저 배제(배열 길이 검사). 그 다음 각 불일치 건에 대해
 * Toss 종가가 KIS의 date±1, ±2 종가와 일치하는지 본다. 특정 shift에서
 * 일치율이 급등하면 (C) 확정. 아무 shift에서도 안 맞으면 (D)로 넘어간다.
 *
 * 실행: node diag-close-shift.mjs
 */
import 'dotenv/config';
import { createReadStream } from 'fs';
import readline from 'readline';
import { getDailyPrices } from './kis-api.js';

const CODES = ['005930', '035720', '112040', '086520', '005380', '047810'];
const NAMES = { '005930': '삼성전자', '035720': '카카오', '112040': '위메이드', '086520': '에코프로', '005380': '현대차', '047810': '한국항공우주' };

// ── (E) 로더 무결성: j.d 와 j.c 길이가 같은가 ─────────────────────────────────
const want = new Set(CODES);
const raw = new Map();
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream('candles-daily.jsonl') });
  rl.on('line', (l) => {
    const head = l.slice(0, 40);
    for (const c of want) {
      if (!head.includes(`"${c}"`)) continue;
      try { const j = JSON.parse(l); if (j.code === c) raw.set(c, j); } catch {}
    }
  });
  rl.on('close', res);
});

console.log('=== (E) 로더 무결성: 배열 길이 ===');
let lenBad = 0;
for (const c of CODES) {
  const j = raw.get(c);
  if (!j) { console.log(`${NAMES[c]}: 없음`); continue; }
  const ok = j.d.length === j.c.length && j.d.length === j.o.length;
  if (!ok) lenBad++;
  console.log(`${(NAMES[c] ?? c).padEnd(8)} d=${j.d.length} o=${j.o.length} h=${j.h?.length} l=${j.l?.length} c=${j.c.length} → ${ok ? 'OK' : '★불일치'}`);
}
console.log(lenBad ? `★ 길이 불일치 ${lenBad}종목 → (E) 로더/데이터 버그 가능` : '길이 전부 일치 → (E) 배제');

// ── KIS 수집 ──────────────────────────────────────────────────────────────────
const kisOf = new Map();
for (const c of CODES) {
  try { kisOf.set(c, await getDailyPrices(c)); } catch (e) { console.error(`! ${c} KIS 실패: ${String(e.message).slice(0, 60)}`); }
  await new Promise(r => setTimeout(r, 350));
}

// ── (C) shift 검정 ────────────────────────────────────────────────────────────
// KIS 배열은 최신순. 거래일 인덱스로 shift를 준다(달력일 아님 — 휴일 왜곡 방지).
console.log('\n=== (C) 날짜 shift 검정: Toss 종가가 KIS의 몇 거래일 밀린 값과 맞나 ===');
console.log('종목        표본  shift-2  shift-1  shift 0  shift+1  shift+2');
const SHIFTS = [-2, -1, 0, 1, 2];
const totals = new Map(SHIFTS.map(s => [s, { hit: 0, n: 0 }]));

for (const c of CODES) {
  const j = raw.get(c), kis = kisOf.get(c);
  if (!j || !kis) continue;
  const tm = new Map();
  for (let i = 0; i < j.d.length; i++) tm.set(String(j.d[i]), j.c[i]);
  const kIdx = new Map(kis.map((k, i) => [k.date, i]));

  const line = [];
  let n = 0;
  const hits = new Map(SHIFTS.map(s => [s, 0]));
  for (const k of kis) {
    const tc = tm.get(k.date);
    if (tc == null) continue;
    n++;
    const i0 = kIdx.get(k.date);
    for (const s of SHIFTS) {
      // KIS 최신순이므로 인덱스 +1 = 하루 과거. shift +1 = "Toss가 하루 과거 값을 담고 있다"
      const kk = kis[i0 + s];
      if (kk && kk.close === tc) hits.set(s, hits.get(s) + 1);
    }
  }
  if (!n) continue;
  for (const s of SHIFTS) { const t = totals.get(s); t.hit += hits.get(s); t.n += n; }
  for (const s of SHIFTS) line.push(`${hits.get(s)}/${n}`.padStart(9));
  console.log(`${(NAMES[c] ?? c).padEnd(10)}${String(n).padStart(5)}${line.join('')}`);
}

console.log('---');
const tl = SHIFTS.map(s => { const t = totals.get(s); return `${(t.hit / t.n * 100).toFixed(1)}%`.padStart(9); });
console.log(`합계 일치율     ${tl.join('')}`);

const best = SHIFTS.reduce((a, s) => (totals.get(s).hit > totals.get(a).hit ? s : a), 0);
const bestRate = totals.get(best).hit / totals.get(best).n * 100;
const zeroRate = totals.get(0).hit / totals.get(0).n * 100;

console.log('\n=== 판정 ===');
if (best !== 0 && bestRate > zeroRate + 20) {
  console.log(`(C) 확정: shift ${best > 0 ? '+' : ''}${best} 에서 일치율 ${bestRate.toFixed(1)}% (shift 0 은 ${zeroRate.toFixed(1)}%).`);
  console.log(`    → Toss 일봉의 날짜 라벨이 ${Math.abs(best)}거래일 어긋나 있다.`);
} else if (zeroRate > 90) {
  console.log(`괴리 없음 — shift 0 일치율 ${zeroRate.toFixed(1)}%. 앞 스크립트 결과를 재확인해야 한다.`);
} else {
  console.log(`(C) 기각: 어떤 shift에서도 일치율이 뛰지 않는다 (최고 shift ${best} = ${bestRate.toFixed(1)}%).`);
  console.log(`    → 날짜 정렬 문제가 아니다. (D) 수정주가 처리 차이를 검정해야 한다.`);
  console.log(`    → 다음 단계: KIS FID_ORG_ADJ_PRC='0'(수정주가)로 재조회해 같은 대조를 반복.`);
}
