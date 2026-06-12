#!/usr/bin/env node
/**
 * sweep-combo.mjs — combo-v2 파라미터 스윕 (과적합 방지: train/validation 분리)
 *   Train: 2023-01~2024-12에서 그리드 탐색 → PF 기준 상위 3개만
 *   Validation: 2025-01~2026-06에서 재검증 → 양쪽 모두 좋은 조합만 채택 후보
 *
 * 실행: node sweep-combo.mjs   (일봉 캐시 필수 — backtest-swing.mjs 선실행)
 */
import { execFileSync } from 'child_process';

const GRID = [];
for (const trail of [8, 10, 12])
  for (const minbreak of [2, 3, 5])
    for (const maxholdr of [3, 5])
      GRID.push({ trail, minbreak, maxholdr });

function runOne(params, from, to) {
  const args = ['backtest-swing.mjs', '--strategies', 'combo-v2', '--from', from, '--to', to,
    '--trail', String(params.trail), '--minbreak', String(params.minbreak), '--maxholdr', String(params.maxholdr)];
  const out = execFileSync('node', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
  // 요약 행 파싱: "combo-v2     1384    57%   1.35    45.0%   25.3%    60%     4.2일  ..."
  const m = out.match(/combo-v2\s+(\d+)\s+(\d+)%\s+([\d.∞]+)\s+(-?[\d.]+)%\s+([\d.]+)%\s+(\d+)%/);
  if (!m) return null;
  return { trades: +m[1], winRate: +m[2], pf: m[3] === '∞' ? 99 : +m[3], cagr: +m[4], mdd: +m[5], monWin: +m[6] };
}

const fmt = (p, r) => `trail=${p.trail} minbreak=${p.minbreak} maxholdr=${p.maxholdr} | PF ${r.pf} CAGR ${r.cagr}% MDD ${r.mdd}% 승률 ${r.winRate}% 월승률 ${r.monWin}% (${r.trades}건)`;

console.log(`=== combo-v2 스윕: Train 2023-01~2024-12 (${GRID.length}조합) ===`);
const trainResults = [];
for (let i = 0; i < GRID.length; i++) {
  const p = GRID[i];
  try {
    const r = runOne(p, '20230102', '20241230');
    if (r) { trainResults.push({ p, r }); console.log(`[${i + 1}/${GRID.length}] ${fmt(p, r)}`); }
    else console.log(`[${i + 1}/${GRID.length}] 파싱 실패`);
  } catch (e) { console.log(`[${i + 1}/${GRID.length}] 오류: ${e.message.slice(0, 80)}`); }
}

// PF 우선, MDD 패널티로 상위 3개 (안정 복리 관점)
trainResults.sort((a, b) => (b.r.pf - b.r.mdd / 100) - (a.r.pf - a.r.mdd / 100));
const top = trainResults.slice(0, 3);
console.log('\n=== Train 상위 3 → Validation 2025-01~2026-06 재검증 ===');
const final = [];
for (const { p, r } of top) {
  const v = runOne(p, '20250102', '20260611');
  console.log(`TRAIN ${fmt(p, r)}`);
  console.log(`VALID ${v ? fmt(p, v) : '실패'}`);
  if (v) final.push({ p, train: r, valid: v });
}

// 기준선(현행 trail=10 minbreak=3 maxholdr=5)도 validation 출력
const baseV = runOne({ trail: 10, minbreak: 3, maxholdr: 5 }, '20250102', '20260611');
console.log(`\n[기준선 현행값] VALID ${baseV ? fmt({ trail: 10, minbreak: 3, maxholdr: 5 }, baseV) : '실패'}`);
console.log('\n채택 기준: validation PF가 기준선 이상 + train/valid 일관성. 둘 다 충족 못 하면 현행 유지가 정답.');
