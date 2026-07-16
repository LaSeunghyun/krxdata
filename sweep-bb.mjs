#!/usr/bin/env node
/**
 * sweep-bb.mjs — bb-mr/bb-brk 파라미터 스윕 (Train/Validation 분리, sweep-combo.mjs와 동일 방법론)
 *   Train: 2023-01~2024-12 그리드 탐색 → PF-MDD 페널티 상위 2개만
 *   Validation: 2025-01~2026-06 재검증
 *
 * 실행: node sweep-bb.mjs   (일봉 캐시 필수 — backtest-swing.mjs 선실행)
 */
import { execFileSync } from 'child_process';

const GRID = [
  { period: 20, mult: 2.0 },
  { period: 20, mult: 2.5 },
  { period: 10, mult: 1.5 },
];

function runOne(strat, params, from, to) {
  const args = ['backtest-swing.mjs', '--strategies', strat, '--from', from, '--to', to,
    '--bbperiod', String(params.period), '--bbmult', String(params.mult)];
  const out = execFileSync('node', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
  const re = new RegExp(`${strat.replace('-', '\\-')}\\s+(\\d+)\\s+(\\d+)%\\s+([\\d.∞]+)\\s+(-?[\\d.]+)%\\s+([\\d.]+)%\\s+(\\d+)%`);
  const m = out.match(re);
  if (!m) return null;
  return { trades: +m[1], winRate: +m[2], pf: m[3] === '∞' ? 99 : +m[3], cagr: +m[4], mdd: +m[5], monWin: +m[6] };
}

const fmt = (p, r) => `period=${p.period} mult=${p.mult} | PF ${r.pf} CAGR ${r.cagr}% MDD ${r.mdd}% 승률 ${r.winRate}% 월승률 ${r.monWin}% (${r.trades}건)`;

for (const strat of ['bb-mr', 'bb-brk']) {
  console.log(`\n=== ${strat} 스윕: Train 2023-01~2024-12 (${GRID.length}조합) ===`);
  const trainResults = [];
  for (let i = 0; i < GRID.length; i++) {
    const p = GRID[i];
    try {
      const r = runOne(strat, p, '20230102', '20241230');
      if (r) { trainResults.push({ p, r }); console.log(`[${i + 1}/${GRID.length}] ${fmt(p, r)}`); }
      else console.log(`[${i + 1}/${GRID.length}] 파싱 실패`);
    } catch (e) { console.log(`[${i + 1}/${GRID.length}] 오류: ${e.message.slice(0, 80)}`); }
  }
  if (!trainResults.length) { console.log(`${strat}: train 전부 실패 — validation 생략`); continue; }

  trainResults.sort((a, b) => (b.r.pf - b.r.mdd / 100) - (a.r.pf - a.r.mdd / 100));
  const top = trainResults.slice(0, 2);
  console.log(`\n=== ${strat} Train 상위 ${top.length} → Validation 2025-01~2026-06 재검증 ===`);
  for (const { p, r } of top) {
    const v = runOne(strat, p, '20250102', '20260611');
    console.log(`TRAIN ${fmt(p, r)}`);
    console.log(`VALID ${v ? fmt(p, v) : '실패'}`);
  }
}

console.log('\n채택 기준: validation PF가 기존 baseline(rsi2/hi120/combo-v2) 이상 + train/valid 일관성. 둘 다 충족 못 하면 기각이 정답.');
