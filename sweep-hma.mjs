#!/usr/bin/env node
/**
 * sweep-hma.mjs — HMA 전략 3종 검증 (Train/Validation 분리, sweep-bb.mjs 컨벤션)
 *   #1 hma-regime: combo-v2 레짐 판정을 SMA20/60 → HMA(N) 슬로프로 교체 비교 (본명)
 *   #2 hma-turn:   Hull 정석 슬로프 반전 스탠드얼론
 *   #3 hma-dip:    HMA 하향이탈 평균회귀 falsification (+rsi2 중복률)
 *
 *   채택 기준 (사전 등록, docs/superpowers/specs/2026-07-16-krxdata-hma-strategy-design.md):
 *   - regime: train PF>=1.05 AND valid PF>=1.85 (baseline 0.97/1.98 대비)
 *   - turn:   train PF>1.0 AND valid PF>=1.26
 *   - dip:    rsi2 중복률 우선 확인, 높으면 기각
 *
 * 실행: node sweep-hma.mjs [--part baseline|regime|turn|dip]  (기본 all, 일봉 캐시 필수)
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const TRAIN = ['20230102', '20241230'];
const VALID = ['20250102', '20260611'];
const argvS = process.argv.slice(2);
const PART = (() => { const i = argvS.indexOf('--part'); return i >= 0 ? argvS[i + 1] : 'all'; })();
const want = (p) => PART === 'all' || PART === p;

function runOne(strat, extraFlags, [from, to]) {
  const args = ['backtest-swing.mjs', '--strategies', strat, '--from', from, '--to', to, ...extraFlags];
  const out = execFileSync('node', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
  const re = new RegExp(`${strat.replace(/-/g, '\\-')}\\s+(\\d+)\\s+(\\d+)%\\s+([\\d.∞]+)\\s+(-?[\\d.]+)%\\s+([\\d.]+)%\\s+(\\d+)%`);
  const m = out.match(re);
  const g = out.match(/레짐 통계 \(mode=[^)]+\): 전환 (\d+)회 \| UP (\d+)일 \/ NEUTRAL (\d+)일 \/ DOWN (\d+)일/);
  if (!m) return null;
  return {
    trades: +m[1], winRate: +m[2], pf: m[3] === '∞' ? 99 : +m[3], cagr: +m[4], mdd: +m[5], monWin: +m[6],
    regime: g ? { trans: +g[1], up: +g[2], neutral: +g[3], down: +g[4] } : null,
  };
}
const fmt = (r) => r
  ? `PF ${r.pf} CAGR ${r.cagr}% MDD ${r.mdd}% 승률 ${r.winRate}% 월승률 ${r.monWin}% (${r.trades}건)` +
    (r.regime ? ` | 레짐전환 ${r.regime.trans}회 UP${r.regime.up}/N${r.regime.neutral}/D${r.regime.down}` : '')
  : '실패';

// ── #0 baseline: combo-v2 현행(proxy) 레짐 ──────────────────────
if (want('baseline') || want('regime')) {
  console.log('=== baseline: combo-v2 (현행 SMA20/60 proxy 레짐) ===');
  for (const [label, period] of [['TRAIN', TRAIN], ['VALID', VALID]]) {
    try { console.log(`${label} ${fmt(runOne('combo-v2', [], period))}`); }
    catch (e) { console.log(`${label} 오류: ${e.message.slice(0, 100)}`); }
  }
}

// ── #1 hma-regime: combo-v2 + HMA 레짐 ─────────────────────────
if (want('regime')) {
  console.log('\n=== hma-regime: combo-v2 + --regimemode hma (채택: train>=1.05 AND valid>=1.85) ===');
  for (const N of [20, 30, 49]) {
    for (const [label, period] of [['TRAIN', TRAIN], ['VALID', VALID]]) {
      try { console.log(`N=${N} ${label} ${fmt(runOne('combo-v2', ['--regimemode', 'hma', '--regimehma', String(N)], period))}`); }
      catch (e) { console.log(`N=${N} ${label} 오류: ${e.message.slice(0, 100)}`); }
    }
  }
}

// ── #2 hma-turn: 슬로프 반전 스탠드얼론 ─────────────────────────
if (want('turn')) {
  console.log('\n=== hma-turn (채택: train PF>1.0 AND valid PF>=1.26) ===');
  for (const p of [16, 25, 49]) {
    for (const [label, period] of [['TRAIN', TRAIN], ['VALID', VALID]]) {
      try { console.log(`period=${p} ${label} ${fmt(runOne('hma-turn', ['--hmaperiod', String(p)], period))}`); }
      catch (e) { console.log(`period=${p} ${label} 오류: ${e.message.slice(0, 100)}`); }
    }
  }
}

// ── #3 hma-dip: 평균회귀 falsification + rsi2 중복률 ────────────
if (want('dip')) {
  console.log('\n=== hma-dip period=25 (falsification — rsi2 중복률 우선 확인) ===');
  try { console.log(`TRAIN ${fmt(runOne('hma-dip', [], TRAIN))}`); }
  catch (e) { console.log(`TRAIN 오류: ${e.message.slice(0, 100)}`); }
  try {
    const dumpFile = '.hma-dip-overlap.json';
    const args = ['backtest-swing.mjs', '--strategies', 'hma-dip,rsi2', '--from', VALID[0], '--to', VALID[1], '--dump', dumpFile];
    const out = execFileSync('node', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
    const m = out.match(/hma\-dip\s+(\d+)\s+(\d+)%\s+([\d.∞]+)\s+(-?[\d.]+)%\s+([\d.]+)%\s+(\d+)%/);
    console.log(`VALID ${m ? `PF ${m[3]} CAGR ${m[4]}% MDD ${m[5]}% 승률 ${m[2]}% 월승률 ${m[6]}% (${m[1]}건)` : '파싱 실패'}`);
    const d = JSON.parse(readFileSync(dumpFile, 'utf8'));
    const dipTrades = d.books['hma-dip']?.trades ?? [];
    const rsiCodes = new Set((d.books['rsi2']?.trades ?? []).map(t => t.code));
    const overlap = dipTrades.filter(t => rsiCodes.has(t.code)).length;
    console.log(`OVERLAP hma-dip↔rsi2 (valid, 종목 기준): ${overlap}/${dipTrades.length}건 (${dipTrades.length ? Math.round(overlap / dipTrades.length * 100) : 0}%)`);
  } catch (e) { console.log(`VALID/OVERLAP 오류: ${e.message.slice(0, 100)}`); }
}

console.log('\n판정은 사전 등록 기준으로만 — 사후 임계값 조정 금지. baseline: rsi2 1.26/1.48, hi120 0.87/1.26, combo-v2 0.97/1.98 (PF train/valid)');
