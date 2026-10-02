import test from 'node:test';
import assert from 'node:assert/strict';
import { gateScore, assembleSignals, SCORE_STALE_DAYS } from '../ai-signals.mjs';

const NOW = Date.parse('2026-10-01T00:00:00Z');
const base = { total: 77, short: 70, long: 80, reco: 'buy', shortTargetPct: 5, midTargetPct: 12 };

test('신선한 점수(3일)는 reco·목표가를 그대로 쓴다 (음성 대조)', () => {
  const g = gateScore(base, '2026-09-28T00:00:00Z', NOW);
  assert.equal(g.stale, false);
  assert.equal(g.reco, 'buy');
  assert.equal(g.midTargetPct, 12);
});

test('경계: 정확히 14일은 유효, 15일은 stale', () => {
  assert.equal(gateScore(base, '2026-09-17T00:00:00Z', NOW).stale, false);
  assert.equal(gateScore(base, '2026-09-16T00:00:00Z', NOW).stale, true);
  assert.equal(SCORE_STALE_DAYS, 14);
});

test('7/13 생성분(80일 경과)은 reco·목표가 제외, 점수는 유지', () => {
  const g = gateScore(base, '2026-07-13T00:00:00Z', NOW);
  assert.equal(g.stale, true);
  assert.equal(g.reco, null);
  assert.equal(g.shortTargetPct, null);
  assert.equal(g.midTargetPct, null);
  assert.equal(g.total, 77);
  assert.ok(g.ageDays >= 79);
});

test('generated_at 누락/불량은 보수적으로 stale', () => {
  assert.equal(gateScore(base, null, NOW).stale, true);
  assert.equal(gateScore(base, 'garbage', NOW).reco, null);
});

test('assembleSignals 통합: stale 행은 sig.score.reco=null, fresh 행은 유지', async () => {
  const mk = (generated_at) => {
    const rows = [
      [{ stock_code: '005930', corp_name: 'A', sector: 's', current_price: 100, total_score: 50, short_score: 1, long_score: 2, recommendation: 'buy', short_target_pct: 5, mid_target_pct: 9, high_52w: 120, low_52w: 80, market_cap_tril: 1, avg_turnover_20d: 1e10, bonus_flag: false, generated_at }],
      [], [{ close: 1 }], [],
    ];
    return async () => rows.shift() ?? [];
  };
  const opts = { withDetail: false, withNews: false, withAnalyst: false, now: NOW };
  const stale = await assembleSignals('005930', { dbQuery: mk('2026-07-13T00:00:00Z'), ...opts });
  const fresh = await assembleSignals('005930', { dbQuery: mk('2026-09-30T00:00:00Z'), ...opts });
  assert.equal(stale.score.reco, null);
  assert.equal(stale.score.stale, true);
  assert.equal(fresh.score.reco, 'buy');
  assert.equal(fresh.score.midTargetPct, 9);
});
