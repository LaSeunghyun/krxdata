import test from 'node:test';
import assert from 'node:assert/strict';
import { median, mergeArgs, parseComboRow, calmar, mcMedian } from '../validation-lib.mjs';

// 실제 backtest-swing.mjs 출력 행(evolve-c0-full.log 에서 채취). 열 순서가 바뀌면 이 핀이 깨져야 한다.
const REAL_ROW = 'combo-v2     1431    57%   1.41    52.6%   21.2%    64%     3.9일  41,733,530원';

test('parseComboRow reads cagr/mdd/final from a real combo-v2 row', () => {
  const row = parseComboRow(`헤더\n${REAL_ROW}\n꼬리`);
  assert.equal(row.cagr, 52.6);
  assert.equal(row.mdd, 21.2);
  assert.equal(row.final, 41733530);
});

test('parseComboRow returns null when no combo-v2 row exists', () => {
  assert.equal(parseComboRow('아무것도 없음\nrsi2  100  50%'), null);
});

// ★ argOf 가 첫 출현만 읽으므로(backtest-swing.mjs:38) override 는 반드시 앞에 와야 한다.
test('mergeArgs puts override before base so argOf first-wins favors the override', () => {
  const merged = mergeArgs(['--slots', '5'], ['--strategies', 'combo-v2', '--slots', '3']);
  assert.deepEqual(merged, ['--slots', '5', '--strategies', 'combo-v2', '--slots', '3']);
  assert.ok(merged.indexOf('--slots') < merged.indexOf('--strategies'));
});

test('mergeArgs __DROP_LIVE_PARITY__ strips --live-parity from base', () => {
  const merged = mergeArgs(['__DROP_LIVE_PARITY__'], ['--live-parity', '--slots', '3']);
  assert.deepEqual(merged, ['--slots', '3']);
});

// base 가 라이브 계약을 담으면 presence 플래그(--skipneutralrsi 등)는 prepend 로 끌 수 없다.
// 그 플래그를 끈 arm 을 표현하려면 base 에서 빼는 수밖에 없다.
test('mergeArgs __DROP: removes a boolean flag from base', () => {
  const merged = mergeArgs(['__DROP:--skipneutralrsi'], ['--live-parity', '--skipneutralrsi', '--slots', '5']);
  assert.deepEqual(merged, ['--live-parity', '--slots', '5']);
});

test('mergeArgs __DROP: removes a value flag together with its value', () => {
  const merged = mergeArgs(['__DROP:--slots'], ['--live-parity', '--slots', '5', '--trail', '6']);
  assert.deepEqual(merged, ['--live-parity', '--trail', '6']);
});

test('mergeArgs __DROP: keeps other override args and still prepends them', () => {
  const merged = mergeArgs(['--atrsize', '3', '__DROP:--skipneutralrsi'],
    ['--skipneutralrsi', '--slots', '5']);
  assert.deepEqual(merged, ['--atrsize', '3', '--slots', '5']);
});

test('mergeArgs __DROP: handles several drops at once', () => {
  const merged = mergeArgs(['__DROP:--skipneutralrsi', '__DROP:--rsivol'],
    ['--skipneutralrsi', '--rsivol', '0', '--slots', '5']);
  assert.deepEqual(merged, ['--slots', '5']);
});

test('mergeArgs __DROP: is a no-op when the flag is absent from base', () => {
  const merged = mergeArgs(['__DROP:--nonexistent'], ['--slots', '5']);
  assert.deepEqual(merged, ['--slots', '5']);
});

test('median handles even and odd lengths and empty input', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('calmar divides cagr by mdd and refuses non-positive mdd', () => {
  assert.equal(calmar(40, 20), 2);
  assert.equal(calmar(40, 0), null);
  assert.equal(calmar(null, 20), null);
});

// mcMedian 은 runBacktest 를 주입받으므로 실제 백테스트 없이 테스트한다.
test('mcMedian aggregates injected runs and reports how many seeds survived', () => {
  const rows = [
    { cagr: 40, mdd: 20, final: 100 },
    null,                               // 죽은 시드
    { cagr: 60, mdd: 20, final: 300 },
  ];
  let i = 0;
  const result = mcMedian([], { base: [], seeds: 3, runBacktest: () => rows[i++] });
  assert.equal(result.n, 2);
  assert.equal(result.seeds, 3);
  assert.equal(result.medianFinal, 200);
  assert.equal(result.medianCalmar, 2.5);
});

test('mcMedian passes seed and subsample through to the runner', () => {
  const seen = [];
  mcMedian(['--slots', '5'], {
    base: ['--live-parity'], seeds: 2,
    runBacktest: (args) => { seen.push(args); return { cagr: 1, mdd: 1, final: 1 }; },
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], ['--slots', '5', '--live-parity', '--seed', '1', '--subsample', '0.8']);
  assert.deepEqual(seen[1], ['--slots', '5', '--live-parity', '--seed', '2', '--subsample', '0.8']);
});
