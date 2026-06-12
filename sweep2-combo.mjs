#!/usr/bin/env node
/**
 * sweep2-combo.mjs — 2라운드 스윕: 레짐 MA × 슬롯 배분 × rsi2 손절 (trail=8 고정)
 *   Train 2023-01~2024-12 → 상위 3개 Validation 2025-01~2026-06
 * 실행: node sweep2-combo.mjs
 */
import { execFileSync } from 'child_process';

const GRID = [];
for (const regimema of ['10,30', '20,60', '20,120'])
  for (const caps of ['A', 'B', 'C'])
    for (const stoppct of [5, 7])
      GRID.push({ regimema, caps, stoppct });

function runOne(p, from, to) {
  const args = ['backtest-swing.mjs', '--strategies', 'combo-v2', '--from', from, '--to', to,
    '--regimema', p.regimema, '--caps', p.caps, '--stoppct', String(p.stoppct)];
  const out = execFileSync('node', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
  const m = out.match(/combo-v2\s+(\d+)\s+(\d+)%\s+([\d.∞]+)\s+(-?[\d.]+)%\s+([\d.]+)%\s+(\d+)%/);
  if (!m) return null;
  return { trades: +m[1], winRate: +m[2], pf: m[3] === '∞' ? 99 : +m[3], cagr: +m[4], mdd: +m[5], monWin: +m[6] };
}
const fmt = (p, r) => `ma=${p.regimema} caps=${p.caps} stop=${p.stoppct} | PF ${r.pf} CAGR ${r.cagr}% MDD ${r.mdd}% 승률 ${r.winRate}% 월승률 ${r.monWin}% (${r.trades}건)`;

console.log(`=== 2라운드 스윕: Train 2023-01~2024-12 (${GRID.length}조합, trail=8 고정) ===`);
const results = [];
for (let i = 0; i < GRID.length; i++) {
  const p = GRID[i];
  try {
    const r = runOne(p, '20230102', '20241230');
    if (r) { results.push({ p, r }); console.log(`[${i + 1}/${GRID.length}] ${fmt(p, r)}`); }
    else console.log(`[${i + 1}/${GRID.length}] 파싱 실패`);
  } catch (e) { console.log(`[${i + 1}/${GRID.length}] 오류: ${e.message.slice(0, 80)}`); }
}

results.sort((a, b) => (b.r.pf - b.r.mdd / 100) - (a.r.pf - a.r.mdd / 100));
console.log('\n=== Train 상위 3 → Validation 2025-01~2026-06 ===');
for (const { p, r } of results.slice(0, 3)) {
  const v = runOne(p, '20250102', '20260611');
  console.log(`TRAIN ${fmt(p, r)}`);
  console.log(`VALID ${v ? fmt(p, v) : '실패'}`);
}
const base = { regimema: '20,60', caps: 'A', stoppct: 7 };
const bv = runOne(base, '20250102', '20260611');
console.log(`\n[기준선 현행값] VALID ${bv ? fmt(base, bv) : '실패'}`);
console.log('\n채택 기준: validation PF 기준선 이상 + train/valid 일관성.');
