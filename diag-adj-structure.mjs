/**
 * diag-adj-structure.mjs — Toss/KRX 종가 비율의 구조 판정 (2026-07-30)
 *
 * 배경: KRX 재수집분과 Toss 캐시를 대조하니 474/1125(42.1%) 종목이 최대괴리 5% 초과였고
 *       배수가 30x·10x·5x = 정확히 분할 비율이었다. FID_ORG_ADJ_PRC(0/1)는 원인이 아니었다.
 *       025560 단일 조사: 비율이 전 기간 **5.000 고정**, 계단 전환 0건.
 *
 * ═══ 판정할 것 (이게 핵심) ═══
 * 종목별로 Toss/KRX 비율이
 *   (A) **상수** → Toss 캐시가 캐시생성 이후의 권리변동을 반영하지 않았다(미수정), KIS는 역수정.
 *       Toss 시계열 자체는 내부일관적이다 → **기존 백테는 오염 안 됐다.**
 *       비교를 위해 상수배율로 정규화하면 정확히 맞출 수 있다(Path 2 성립).
 *   (B) **계단(구간별로 다름)** → Toss 시계열 **내부에** 가짜 가격점프가 있다.
 *       그 점프가 hi120 돌파·rsi2 신호를 허위 생성한다 → **기존 백테 결과가 오염됐다.**
 *       이건 이번 정합화보다 훨씬 큰 문제다.
 *
 * 방법: 비율을 소수 3자리로 양자화해 고유값 개수를 센다. 반올림 노이즈(±0.002)는 병합.
 *       고유 구간이 1개면 (A), 2개 이상이고 각 구간이 연속 날짜 블록이면 (B).
 *
 * 실행: node --max-old-space-size=6144 diag-adj-structure.mjs
 */
import { createReadStream, writeFileSync } from 'fs';
import readline from 'readline';

const load = async (file, filter) => {
  const m = new Map();
  await new Promise((res) => {
    const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (l) => {
      if (!l.trim()) return;
      try { const j = JSON.parse(l); if (!j?.code || !Array.isArray(j.d)) return; if (filter && !filter.has(j.code)) return; m.set(j.code, j); } catch {}
    });
    rl.on('close', res);
  });
  return m;
};

const krx = await load('candles-daily-krx.jsonl', null);
const toss = await load('candles-daily.jsonl', new Set(krx.keys()));
console.log(`KRX ${krx.size} · Toss ${toss.size}\n`);

/** 반올림 노이즈를 흡수해 비율을 구간(segment)으로 묶는다. 상대허용 0.5%. */
function segments(ratios) {
  const segs = [];
  for (const r of ratios) {
    const last = segs[segs.length - 1];
    if (last && Math.abs(r.v / last.v - 1) < 0.005) { last.n++; last.to = r.d; last.v = (last.v * (last.n - 1) + r.v) / last.n; }
    else segs.push({ v: r.v, n: 1, from: r.d, to: r.d });
  }
  return segs;
}

const constStock = [], stepStock = [], cleanStock = [];
const norm = {};   // code → 정규화 배율 (Toss = KRX × factor)

for (const [c, k] of krx) {
  const t = toss.get(c);
  if (!t) continue;
  const km = new Map(k.d.map((d, i) => [String(d), k.c[i]]));
  const ratios = [];
  for (let i = 0; i < t.d.length; i++) {
    const kc = km.get(String(t.d[i]));
    if (kc == null || !(kc > 0) || !(t.c[i] > 0)) continue;
    ratios.push({ d: String(t.d[i]), v: t.c[i] / kc });
  }
  if (ratios.length < 50) continue;
  const segs = segments(ratios);
  const big = segs.filter(s => s.n >= ratios.length * 0.02);          // 2% 이상 차지하는 구간만 유효
  const maxDev = Math.max(...ratios.map(r => Math.abs(r.v - 1)));

  if (maxDev < 0.01) { cleanStock.push(c); norm[c] = 1; continue; }    // 사실상 1 = 깨끗
  if (big.length <= 1) {
    const f = big[0]?.v ?? ratios[0].v;
    constStock.push({ c, f, segs: segs.length, big: big.length });
    norm[c] = f;
  } else {
    stepStock.push({ c, segs: big.map(s => `${s.v.toFixed(3)}×${s.n}일(${s.from}~${s.to})`).join(' | ') });
  }
}

console.log(`=== 구조 판정 ===`);
const tot = cleanStock.length + constStock.length + stepStock.length;
console.log(`대상 ${tot}종목`);
console.log(`  깨끗(비율≈1)          ${cleanStock.length}  ${(cleanStock.length / tot * 100).toFixed(1)}%`);
console.log(`  (A) 상수배율          ${constStock.length}  ${(constStock.length / tot * 100).toFixed(1)}%  → 정규화로 해결 가능`);
console.log(`  (B) 계단(내부 점프)   ${stepStock.length}  ${(stepStock.length / tot * 100).toFixed(1)}%  ${stepStock.length ? '★ Toss 시계열 내부 오염 의심' : ''}`);

if (constStock.length) {
  console.log(`\n=== (A) 상수배율 분포 ===`);
  const hist = new Map();
  for (const s of constStock) { const key = s.f.toFixed(2); hist.set(key, (hist.get(key) ?? 0) + 1); }
  for (const [f, n] of [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  배율 ${f}×  →  ${n}종목`);
}

if (stepStock.length) {
  console.log(`\n=== (B) 계단 종목 상위 10 (★ 기존 백테 오염 여부 판정 대상) ===`);
  for (const s of stepStock.slice(0, 10)) console.log(`  ${s.c}  ${s.segs}`);
}

writeFileSync('krx-norm-factors.json', JSON.stringify({
  builtAt: '20260730',
  note: 'Toss = KRX × factor. 비교 시 KRX에 factor를 곱해 Toss 스케일로 맞춘다(또는 Toss를 나눈다).',
  clean: cleanStock.length, constant: constStock.length, stepped: stepStock.length,
  steppedCodes: stepStock.map(s => s.c),
  factors: norm,
}, null, 1));
console.log(`\n→ krx-norm-factors.json 기록 (정규화 배율 ${Object.keys(norm).length}종목)`);
