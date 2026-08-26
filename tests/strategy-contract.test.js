import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BACKTEST_COMBO_CAPS, LIVE_COMBO_CAPS, LIVE_MAX_ORDER_VALUE, LIVE_MAX_ORDERS_PER_DAY, LIVE_SLOTS, LIVE_RSI2_UNIVERSE_LIMIT, HARD_STOP_PCT, TRAIL_PCT, AI_TRADER } from '../strategy-contract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 2026-08-08: status.mjs 가 avg*0.93(-7%)·hi*0.92(-8%) 라는 폐기된 값으로 손절선을 표시하던 사고가 계기.
//   OCI홀딩스는 "손절선 265,420 여유 -0.5%"로 보고됐는데 실제로는 손절이 없었고(sub 미상),
//   한화오션도 84,723 표시 vs 실제 77,435 였다. 두 종목 다 틀렸다 = 없는 방어를 있다고 보고했다.
//   stock-live.mjs 는 top-level await·무한루프가 있어 import 할 수 없다(두 번째 트레이더가 뜬다).
//   그래서 값을 strategy-contract 로 승격하되 stock-live 리터럴은 남겼고, drift 는 여기서 소스 대조로 잡는다.
test('exit constants stay in sync with the live engine literal', () => {
  const src = readFileSync(join(ROOT, 'stock-live.mjs'), 'utf8');
  const m = src.match(/const\s+TRAIL_PCT\s*=\s*(\d+(?:\.\d+)?)\s*,\s*HARD_STOP_PCT\s*=\s*(\d+(?:\.\d+)?)\s*;/);
  assert.ok(m, 'stock-live.mjs 의 TRAIL_PCT/HARD_STOP_PCT 선언을 찾지 못했다 — 선언 형태가 바뀌면 이 대조가 조용히 죽는다');
  assert.equal(Number(m[1]), TRAIL_PCT, `TRAIL_PCT drift: stock-live=${m[1]} vs contract=${TRAIL_PCT}`);
  assert.equal(Number(m[2]), HARD_STOP_PCT, `HARD_STOP_PCT drift: stock-live=${m[2]} vs contract=${HARD_STOP_PCT}`);
});

// status.mjs 가 폐기 상수로 회귀하지 않는지 — 리터럴 0.93/0.92 는 -7%/-8% 이고 현행은 -15%/-6% 다.
test('status.mjs does not resurrect the retired stop multipliers', () => {
  const src = readFileSync(join(ROOT, 'status.mjs'), 'utf8');
  assert.ok(!/avg\s*\*\s*0\.93/.test(src), 'status.mjs 에 폐기된 -7% 하드손절 계산이 남아 있다');
  assert.ok(!/hi\s*\*\s*0\.92/.test(src), 'status.mjs 에 폐기된 -8% 트레일 계산이 남아 있다');
});

test('live combo caps stay on the validated conservative preset', () => {
  assert.deepEqual(LIVE_COMBO_CAPS, {
    UP: { hi120: 6, rsi2: 4 },
    NEUTRAL: { hi120: 0, rsi2: 8 },
    DOWN: { hi120: 0, rsi2: 4 },
  });
});

test('backtest combo caps match the live contract', () => {
  assert.deepEqual(BACKTEST_COMBO_CAPS, LIVE_COMBO_CAPS);
});

// 2026-08-04: slots 3→5 · rsi2 유니버스 40→420 으로 핀 갱신. 둘 다 2026-07-24 uni420 재조정에서
//   5시드 MC 로 확정된 값인데(strategy-contract.mjs LIVE_SLOTS 주석) 이 테스트만 구값에 멈춰 있었다.
//   스위트가 상시 red 면 게이트로 못 쓴다 — 값 자체는 계약 주석이 근거를 갖고 있으므로 핀을 옮긴다.
test('live execution constants stay small-account safe', () => {
  assert.equal(LIVE_MAX_ORDER_VALUE, 100_000);
  assert.equal(LIVE_MAX_ORDERS_PER_DAY, 3);
  assert.equal(LIVE_SLOTS, 5);
  assert.equal(LIVE_RSI2_UNIVERSE_LIMIT, 420);
});

// 2026-08-26: AI 청산권고는 사람 승인을 거친다. 실적 3건·평균 -4.93%·승 0/3 이고,
//   그 3건은 전부 사용자가 직접 산 포지션이라 소유권 가드 적용 후 유효 표본은 0건이 된다.
//   매수는 이미 텔레그램 승인인데 매도만 자동집행이던 비대칭을 없앤다.
test('AI 청산은 기본값이 사람 승인이다', () => {
  assert.equal(AI_TRADER.sellRequiresApproval, true,
    'false 로 두면 미검증 기능이 실계좌에 자동집행된다 — 되돌릴 때만 명시적으로 바꾼다');
});
