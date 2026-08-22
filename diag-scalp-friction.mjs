#!/usr/bin/env node
/**
 * diag-scalp-friction.mjs — 5분봉 스캘핑 **비용 바닥** 실측 (2026-08-04)
 *
 * 왜 이걸 먼저 하나: 국내주식 스캘핑의 성패는 신호가 아니라 **마찰**이 정한다.
 *   왕복 = 수수료 0.015%×2 + **매도 거래세 0.15%(면제 불가)** + 호가단위(틱) 슬리피지 + 스프레드.
 *   틱은 가격대별로 다르고(2만~5만원 50원 = 0.25%, 5만~20만원 100원), 이게 수수료보다 크다.
 *   비용 바닥을 모르면 "승률 65% 달성"이 이익인지 손실인지 판정할 수 없다.
 *
 * 산출:
 *   ① 유니버스 가격대 분포 → 가격대별 틱 비용(%)
 *   ② 왕복 마찰 = 수수료+세금 + 2틱 (보수) / +1틱 (지정가 일부 체결 가정)
 *   ③ 손익분기 승률표: 각 TP/SL 조합에서 EV=0 이 되는 승률
 *   ④ 5분봉 실제 변동성 — TP/SL 이 도달 가능한 크기인지 (|5분 수익률| 분포)
 *
 * 실행: node diag-scalp-friction.mjs
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, 'candles-1m.jsonl');

const FEE_BPS = 1.5;    // 편도 수수료 0.015%
const TAX_BPS = 15;     // 매도 거래세 0.15% (면제 불가)

/** 국내주식 호가단위 (2023 개편 기준). 가격대별 최소 가격변동폭. */
function tickSize(px) {
  if (px < 2000) return 1;
  if (px < 5000) return 5;
  if (px < 20000) return 10;
  if (px < 50000) return 50;
  if (px < 200000) return 100;
  if (px < 500000) return 500;
  return 1000;
}

const pctl = (arr, p) => { if (!arr.length) return NaN; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

const lastPx = [];          // 종목별 최종가
const ret5 = [];            // 5분봉 수익률 표본(|%|)
const range5 = [];          // 5분봉 고저폭(%)
let nStock = 0, nBar = 0;

const rl = createInterface({ input: createReadStream(FILE) });
for await (const line of rl) {
  if (!line.trim()) continue;
  let j; try { j = JSON.parse(line); } catch { continue; }
  nStock++; nBar += j.bars.length;
  // bars 는 newest-first → 오름차순으로
  const bars = [...j.bars].reverse();
  lastPx.push(bars[bars.length - 1].c);

  // 1분 → 5분 집계 (연속 5봉 묶음. 세션 경계는 무시 — 비용 산정엔 영향 없음)
  for (let i = 0; i + 5 <= bars.length; i += 5) {
    const seg = bars.slice(i, i + 5);
    const o = seg[0].o, c = seg[4].c;
    const h = Math.max(...seg.map(b => b.h)), l = Math.min(...seg.map(b => b.l));
    if (!(o > 0)) continue;
    ret5.push(Math.abs(c / o - 1) * 100);
    range5.push((h / l - 1) * 100);
  }
}

console.log('=== 5분봉 스캘핑 비용 바닥 실측 ===');
console.log(`데이터: ${nStock}종목 · ${nBar.toLocaleString()}분봉 · 5분봉 표본 ${ret5.length.toLocaleString()}\n`);

// ① 가격대 분포
console.log('① 유니버스 가격대 분포 (최종가)');
for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
  const px = pctl(lastPx, p);
  console.log(`   ${(p * 100).toString().padStart(3)}%분위  ${px.toLocaleString().padStart(10)}원  → 틱 ${tickSize(px)}원 = ${(tickSize(px) / px * 100).toFixed(3)}%`);
}

// ② 왕복 마찰
const tickPct = lastPx.map(px => tickSize(px) / px * 100);
const feeTax = (FEE_BPS * 2 + TAX_BPS) / 100;   // %
console.log(`\n② 왕복 마찰 (수수료 ${FEE_BPS / 100}%×2 + 거래세 ${TAX_BPS / 100}%)`);
console.log(`   수수료+세금 고정분           ${feeTax.toFixed(3)}%`);
console.log(`   틱 비용 중위                 ${pctl(tickPct, 0.5).toFixed(3)}% (1틱) · ${(pctl(tickPct, 0.5) * 2).toFixed(3)}% (2틱=진입+청산)`);
const fricOptimistic = feeTax + pctl(tickPct, 0.5);        // 1틱 (지정가 절반 성공 가정)
const fricRealistic = feeTax + pctl(tickPct, 0.5) * 2;     // 2틱 (시장가 왕복)
console.log(`   → 낙관(1틱) ${fricOptimistic.toFixed(3)}%  |  현실(2틱) ${fricRealistic.toFixed(3)}%`);

// ③ 손익분기 승률
console.log(`\n③ 손익분기 승률 = (SL + 비용) / (TP + SL)   ※ 이 값보다 승률이 높아야 이익`);
const grid = [[0.5, 0.5], [1.0, 1.0], [1.5, 1.0], [2.0, 1.0], [1.0, 0.7], [2.0, 1.5], [3.0, 1.5], [1.5, 1.5], [2.5, 1.0]];
console.log(`   ${'TP/SL'.padEnd(12)}${'낙관비용'.padStart(10)}${'현실비용'.padStart(10)}${'무작위승률'.padStart(12)}`);
for (const [T, S] of grid) {
  const bo = (c) => ((S + c) / (T + S) * 100);
  const rand = S / (T + S) * 100;   // 무작위 워크 기준선(도달 확률)
  const mark = bo(fricRealistic) >= 60 && bo(fricRealistic) <= 70 ? '  ← 목표대 60~70%' : '';
  console.log(`   ${`${T}% / ${S}%`.padEnd(12)}${(bo(fricOptimistic).toFixed(1) + '%').padStart(10)}${(bo(fricRealistic).toFixed(1) + '%').padStart(10)}${(rand.toFixed(1) + '%').padStart(12)}${mark}`);
}

// ④ 5분봉 변동성 — TP/SL 이 애초에 닿는 크기인가
console.log(`\n④ 5분봉 실제 변동성 (TP/SL 이 도달 가능한 크기인지)`);
console.log(`   |5분 수익률|  중위 ${pctl(ret5, 0.5).toFixed(3)}%  ·  75% ${pctl(ret5, 0.75).toFixed(3)}%  ·  90% ${pctl(ret5, 0.9).toFixed(3)}%  ·  99% ${pctl(ret5, 0.99).toFixed(3)}%`);
console.log(`   5분 고저폭    중위 ${pctl(range5, 0.5).toFixed(3)}%  ·  75% ${pctl(range5, 0.75).toFixed(3)}%  ·  90% ${pctl(range5, 0.9).toFixed(3)}%  ·  99% ${pctl(range5, 0.99).toFixed(3)}%`);
console.log(`   평균 |5분수익률| ${avg(ret5).toFixed(3)}%`);

console.log(`\n※ 판정: 현실비용 ${fricRealistic.toFixed(3)}% 를 넘는 TP 를 5분 안에 잡아야 한다.`);
console.log(`   5분 고저폭 중위가 ${pctl(range5, 0.5).toFixed(3)}% 이므로, TP 를 비용 위로 올리면 **여러 봉을 보유**해야 도달한다`);
console.log(`   = 순수 "5분봉 스캘핑"(한두 봉 청산)은 비용 구조상 성립하지 않는다는 뜻일 수 있다. 아래 백테로 확인한다.`);
