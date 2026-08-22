import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_PARITY_BASE, LIVE_PARITY_VERSION, BACKTEST_TO, HYPOTHESES, BARBELL,
} from '../validation-registry.mjs';
import {
  LIVE_SLOTS, LIVE_UNIVERSE_LIMIT, TRAIL_PCT, PARTIAL_TP, RSI_ENTRY_FILTER,
} from '../strategy-contract.mjs';
import { mergeArgs } from '../validation-lib.mjs';

const valueOf = (args, flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * ★ 이 스위트의 존재 이유 (2026-08-22)
 * LIVE_PARITY_BASE 가 하드코딩이던 시절 라이브가 07-24·07-29 두 번 움직였는데 base 는 07-22 에 멈춰
 * **약 4주간 VM 일일 크론이 라이브와 다른 전략을 재검증**했다. 아무도 몰랐던 이유는 대조하는 코드가
 * 없었기 때문이다. 이제 base 는 계약에서 파생되고, 아래가 그 파생이 실제로 맞는지 기계 검증한다.
 */
test('live parity base mirrors the live contract, not hardcoded numbers', () => {
  assert.equal(valueOf(LIVE_PARITY_BASE, '--slots'), String(LIVE_SLOTS));
  assert.equal(valueOf(LIVE_PARITY_BASE, '--liveuni'), String(LIVE_UNIVERSE_LIMIT));
  assert.equal(valueOf(LIVE_PARITY_BASE, '--trail'), String(TRAIL_PCT));
  assert.equal(valueOf(LIVE_PARITY_BASE, '--rsivol'), String(RSI_ENTRY_FILTER.volMin));
});

// 라이브는 % 로 말하고 백테는 trail 배수로 말한다. 그 환산이 어긋나면 조용히 다른 익절을 재게 된다.
test('partial take-profit multipliers translate the live percentages', () => {
  assert.equal(Number(valueOf(LIVE_PARITY_BASE, '--tp1r')) * TRAIL_PCT, PARTIAL_TP.tp1Pct);
  assert.equal(Number(valueOf(LIVE_PARITY_BASE, '--tp2r')) * TRAIL_PCT, PARTIAL_TP.tp2Pct);
});

test('skipNeutral presence in base follows the contract flag', () => {
  assert.equal(LIVE_PARITY_BASE.includes('--skipneutralrsi'), RSI_ENTRY_FILTER.skipNeutral);
});

// 방법론 §1-B: 폭락(2026-07)이 빠진 구간에서는 방어장치 검정이 성립하지 않는다.
test('backtest window includes the July 2026 crash', () => {
  assert.ok(BACKTEST_TO >= '20260724', `--to ${BACKTEST_TO} 는 폭락을 제외한다`);
  assert.equal(valueOf(LIVE_PARITY_BASE, '--to'), BACKTEST_TO);
  assert.equal(valueOf(BARBELL.aggressiveArgs, '--to'), BACKTEST_TO);
});

test('gap policy is part of the baseline because live overrides trail/tp daily', () => {
  assert.ok(LIVE_PARITY_BASE.includes('--gapaxis'));
  assert.equal(valueOf(LIVE_PARITY_BASE, '--scenpolicy'), 'gap-pol.json');
});

// --rsiuni 는 live-parity 에서 무효다(유니버스가 LIVE_UNI 로 고정). 남아 있으면 읽는 사람을 오도한다.
test('base does not carry the inert --rsiuni flag', () => {
  assert.ok(!LIVE_PARITY_BASE.includes('--rsiuni'));
});

test('live parity version is stamped so ledger rows can be split on it', () => {
  assert.match(LIVE_PARITY_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});

/**
 * ★ myVerdict 는 라이브 현재값이어야 한다.
 * 어긋나면 FLIP 경보가 상시 울리고, 상시 울리는 경보는 읽히지 않아 진짜 뒤집힘을 가린다.
 * 실제로 slots(s3 vs 라이브 5) · partialtp(tp_4_8 vs 라이브 6/12) · rsivol(on vs 라이브 off)
 * 세 건이 라이브와 모순인 채 방치돼 있었다.
 */
test('verdicts that name a live setting agree with the contract', () => {
  const byId = Object.fromEntries(HYPOTHESES.map(h => [h.id, h]));
  assert.equal(byId.slots.myVerdict, `s${LIVE_SLOTS}`);
  assert.equal(byId.partialtp.myVerdict, `tp_${PARTIAL_TP.tp1Pct}_${PARTIAL_TP.tp2Pct}`);
  assert.equal(byId.rsivol.myVerdict, RSI_ENTRY_FILTER.volMin > 0 ? 'on125' : 'off');
  assert.equal(byId.skipneutral.myVerdict, RSI_ENTRY_FILTER.skipNeutral ? 'on' : 'off');
});

test('every hypothesis declares its verdict among its own variants', () => {
  for (const h of HYPOTHESES) {
    if (h.monitor) continue;
    assert.ok(h.myVerdict, `${h.id}: myVerdict 없음`);
    assert.ok(Object.keys(h.variants).includes(h.myVerdict),
      `${h.id}: myVerdict '${h.myVerdict}' 가 variants 에 없다`);
  }
});

/**
 * ★ base 가 라이브를 담게 되면서 생긴 함정 — 두 arm 이 같은 인자로 접히면 그 가설은 죽는다.
 * 구 winner_stack 이 정확히 그랬다: baseline:[] 이 base 의 --skipneutralrsi 를 상속받아
 * winner arm 과 사실상 같아졌다. 그래서 __DROP: 을 도입했고, 여기서 그 붕괴를 기계로 막는다.
 */
test('no hypothesis collapses into identical arms after merging with base', () => {
  for (const h of HYPOTHESES) {
    const seen = new Map();
    for (const [name, args] of Object.entries(h.variants)) {
      const key = mergeArgs(args, LIVE_PARITY_BASE).join(' ');
      if (seen.has(key)) {
        assert.fail(`${h.id}: '${name}' 과 '${seen.get(key)}' 가 병합 후 동일 — 테스트 불가능한 가설`);
      }
      seen.set(key, name);
    }
  }
});

// __DROP: 이 실제로 base 에서 플래그를 빼는지 (오타가 나면 조용히 no-op 이 되어 arm 이 접힌다)
test('drop-token variants really remove the flag they name', () => {
  const byId = Object.fromEntries(HYPOTHESES.map(h => [h.id, h]));
  const off = mergeArgs(byId.skipneutral.variants.off, LIVE_PARITY_BASE);
  assert.ok(!off.includes('--skipneutralrsi'));

  const gapOff = mergeArgs(byId.gappolicy.variants.off, LIVE_PARITY_BASE);
  assert.ok(!gapOff.includes('--gapaxis'));
  assert.ok(!gapOff.includes('--scenpolicy'));
  assert.ok(!gapOff.includes('gap-pol.json'), 'scenpolicy 값이 고아로 남았다');
});
