import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLiveCandidates,
  liveCandidateBudget,
  applyComboCaps,
} from '../live-parity.mjs';
import { LIVE_UNIVERSE_LIMIT, LIVE_COMBO_CAPS } from '../strategy-contract.mjs';

// 2026-08-04: 40 → 420. 2026-07-24 유니버스 확장(사용자 요청, 5시드 MC 로 slots5/trail6 재조정)
//   때 계약은 바뀌었는데 이 핀만 남아 있었다 = 스위트가 상시 red 라 진짜 회귀를 가린다.
test('live parity universe is configured as market-cap top 420', () => {
  assert.equal(LIVE_UNIVERSE_LIMIT, 420);
});

/**
 * ★ 레짐캡 집행 (2026-08-04). 백테 backtest-swing.mjs:1463 의
 *   `if (countSub(candidate.sub) >= caps[sub]) continue` 와 의미가 같은지 고정한다.
 *   라이브에 이 규칙이 통째로 없어서 2026-08-03 DOWN 레짐에 rsi2 5 를 채운 사건의 회귀 방지.
 */
test('applyComboCaps blocks candidates whose sub is already at the regime cap', () => {
  const cands = [
    { code: 'A', sub: 'rsi2' },
    { code: 'B', sub: 'hi120' },
    { code: 'C', sub: 'rsi2' },
  ];
  // DOWN: rsi2 4 · hi120 0. 보유 rsi2 4 = 캡 도달 → rsi2 후보 전부 차단, hi120 은 캡 0 이라 항상 차단.
  const down = applyComboCaps(cands, {
    regime: 'DOWN',
    heldSubs: ['rsi2', 'rsi2', 'rsi2', 'rsi2'],
    caps: LIVE_COMBO_CAPS,
  });
  assert.deepEqual(down.kept, []);
  assert.deepEqual(down.blocked.map(c => c.code), ['A', 'B', 'C']);

  // 보유 3 이면 아직 한 자리 남는다 — 사이클당 1건만 사므로 고정 카운트 필터로 충분하다.
  const room = applyComboCaps(cands, {
    regime: 'DOWN',
    heldSubs: ['rsi2', 'rsi2', 'rsi2'],
    caps: LIVE_COMBO_CAPS,
  });
  assert.deepEqual(room.kept.map(c => c.code), ['A', 'C']);
  assert.deepEqual(room.blocked.map(c => c.code), ['B']);   // hi120 캡 0
});

test('applyComboCaps ignores positions with unknown sub and subs absent from the cap table', () => {
  const cands = [{ code: 'A', sub: 'rsi2' }, { code: 'V', sub: 'volsurge' }];
  // sub 미상(수동·레거시)은 어느 캡에도 안 들어간다 → rsi2 카운트는 1 로만 센다.
  const r = applyComboCaps(cands, {
    regime: 'UP',
    heldSubs: ['rsi2', undefined, null, ''],
    caps: LIVE_COMBO_CAPS,
  });
  assert.deepEqual(r.kept.map(c => c.code), ['A', 'V']);   // UP rsi2 캡 4 > 보유 1, volsurge 는 캡 테이블 밖
  assert.deepEqual(r.blocked, []);
});

test('applyComboCaps is a no-op when the regime has no cap entry', () => {
  const cands = [{ code: 'A', sub: 'rsi2' }];
  const r = applyComboCaps(cands, { regime: null, heldSubs: ['rsi2', 'rsi2', 'rsi2', 'rsi2', 'rsi2'], caps: LIVE_COMBO_CAPS });
  assert.deepEqual(r.kept.map(c => c.code), ['A']);
  assert.deepEqual(r.blocked, []);
});

test('buildLiveCandidates uses the live regime gates and conviction ordering', () => {
  const rows = [
    { code: 'A', rsi: 1, breakoutPct: 0, sector: 'IT' },
    { code: 'B', rsi: 50, breakoutPct: 8, sector: '산업재' },
    { code: 'C', rsi: 0, breakoutPct: 0, sector: '금융' },
  ];

  const up = buildLiveCandidates(rows, { regime: 'UP', rsiMax: 10, minBreakout: 3 });
  assert.deepEqual(up.map(({ code, sub, conviction }) => ({ code, sub, conviction })), [
    { code: 'A', sub: 'rsi2', conviction: 9 },
    { code: 'B', sub: 'hi120', conviction: 8 },
    { code: 'C', sub: 'rsi2', conviction: 10 },
  ].sort((a, b) => b.conviction - a.conviction || (a.sub === 'hi120' ? -1 : 1)));

  const neutral = buildLiveCandidates(rows, { regime: 'NEUTRAL', rsiMax: 10, minBreakout: 3 });
  assert.equal(neutral.some(c => c.sub === 'hi120'), false);
  assert.equal(neutral.find(c => c.code === 'C').conviction, 8.5);
});

test('buildLiveCandidates can remove UP-regime rsi2 without changing other regimes', () => {
  const rows = [{ code: 'A', rsi: 0, breakoutPct: 4, sector: 'IT' }];

  const up = buildLiveCandidates(rows, { regime: 'UP', allowUpRsi: false });
  assert.deepEqual(up.map(c => c.sub), ['hi120']);

  const neutral = buildLiveCandidates(rows, { regime: 'NEUTRAL', allowUpRsi: false });
  assert.deepEqual(neutral.map(c => c.sub), ['rsi2']);
});

test('liveCandidateBudget matches live per-slot and strong-conviction sizing', () => {
  const common = { cash: 800_000, equity: 900_000, slots: 3, strongThreshold: 7, strongFraction: 0.5 };
  assert.equal(liveCandidateBudget({ ...common, conviction: 6.9 }), 300_000);
  assert.equal(liveCandidateBudget({ ...common, conviction: 7 }), 400_000);
  assert.equal(liveCandidateBudget({ ...common, cash: 200_000, conviction: 6 }), 200_000);
});

test('liveCandidateBudget applies a research-only exposure multiplier when supplied', () => {
  assert.equal(liveCandidateBudget({
    cash: 800_000,
    equity: 900_000,
    slots: 3,
    conviction: 7,
    strongThreshold: 7,
    strongFraction: 0.5,
    exposureMultiplier: 0.5,
  }), 200_000);
});
