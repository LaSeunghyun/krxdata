import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isThrottleError, backoffDelay, withBackoff, runWithSecondPass, splitWindows, fetchThenFlush, makeDbQuery } from '../lib/retry.mjs';

const noSleep = async () => {};

test('isThrottleError: 실제 9/30 로그 메시지와 KIS 레이트리밋을 잡는다', () => {
  assert.equal(isThrottleError(new Error('ThrottlerException: Too Many Requests')), true);
  assert.equal(isThrottleError(new Error('KIS FHKST01010900: 초당 거래건수를 초과하였습니다.')), true);
  assert.equal(isThrottleError(new Error('DART 020 list: 요청 제한을 초과하였습니다')), true);
});

test('isThrottleError 음성 대조: 권한/파라미터/형식 오류는 throttle 이 아니다', () => {
  assert.equal(isThrottleError(new Error('KIS FHPST04760000: 기간이 만료된 token 입니다 [EGW00123]')), false);
  assert.equal(isThrottleError(new Error('응답 형식 오류: output 배열 없음')), false);
  assert.equal(isThrottleError(new Error('relation "x" does not exist')), false);
  assert.equal(isThrottleError(undefined), false);
});

test('isThrottleError: 일시적 네트워크 오류(ECONNRESET/fetch failed/타임아웃/5xx)는 재시도 대상, 영구 오류는 아니다', () => {
  const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNRESET' };
  assert.equal(isThrottleError(e), true);
  const t = new Error('x'); t.name = 'TimeoutError';
  assert.equal(isThrottleError(t), true);
  assert.equal(isThrottleError(new Error('DART x: 비JSON 응답 HTTP 503')), true);
  // 음성 대조
  assert.equal(isThrottleError(new Error('DART 010 list: 등록되지 않은 키입니다')), false);
  assert.equal(isThrottleError(new Error('HTTP 404 not found')), false);
  const bad = new Error('boom'); bad.cause = { code: 'ERR_INVALID_ARG_TYPE' };
  assert.equal(isThrottleError(bad), false);
});

test('backoffDelay: 지수 증가, 상한 준수', () => {
  const j = () => 0.5; // 배율 1.0
  assert.equal(backoffDelay(0, { base: 500, max: 15000, jitter: j }), 500);
  assert.equal(backoffDelay(1, { base: 500, max: 15000, jitter: j }), 1000);
  assert.equal(backoffDelay(2, { base: 500, max: 15000, jitter: j }), 2000);
  assert.equal(backoffDelay(10, { base: 500, max: 15000, jitter: j }), 15000);
});

test('withBackoff: throttle 은 재시도 후 성공', async () => {
  let n = 0; const waits = [];
  const r = await withBackoff(async () => { if (++n < 3) throw new Error('ThrottlerException: Too Many Requests'); return 'ok'; },
    { retries: 5, sleep: async (ms) => { waits.push(ms); }, jitter: () => 0.5 });
  assert.equal(r, 'ok'); assert.equal(n, 3); assert.deepEqual(waits, [500, 1000]);
});

test('withBackoff 음성 대조: 비-throttle 오류는 재시도 없이 즉시 throw', async () => {
  let n = 0;
  await assert.rejects(withBackoff(async () => { n++; throw new Error('권한 없음'); }, { retries: 5, sleep: noSleep }), /권한 없음/);
  assert.equal(n, 1);
});

test('withBackoff 음성 대조: throttle 이 계속돼도 retries 에서 멈춘다(무한 재시도 금지)', async () => {
  let n = 0;
  await assert.rejects(withBackoff(async () => { n++; throw new Error('Too Many Requests'); }, { retries: 3, sleep: noSleep }), /Too Many/);
  assert.equal(n, 4); // 최초 1 + 재시도 3
});

test('runWithSecondPass: 1차 실패 항목이 2차 패스에서 복구된다', async () => {
  const seen = new Map();
  const res = await runWithSecondPass(['a', 'b', 'c'], async (it) => {
    const k = (seen.get(it) ?? 0) + 1; seen.set(it, k);
    if (it === 'b' && k === 1) throw new Error('Too Many Requests');
  }, { passes: 2, sleep: noSleep });
  assert.equal(res.ok, 3); assert.equal(res.failed.length, 0); assert.equal(res.rate, 1);
});

test('runWithSecondPass 음성 대조: 영구 실패는 failed 에 남고 rate 가 낮아진다', async () => {
  const res = await runWithSecondPass(['a', 'b', 'c', 'd'], async (it) => { if (it === 'c') throw new Error('영구 오류'); }, { passes: 2, sleep: noSleep });
  assert.equal(res.ok, 3); assert.equal(res.failed.length, 1); assert.equal(res.failed[0].item, 'c');
  assert.equal(res.rate, 0.75); assert.ok(res.rate < 0.95);
});

test('fetchThenFlush: DB 호출 수가 항목 수가 아니라 chunk 수다 + flush 실패 chunk 는 실패로 집계', async () => {
  const items = Array.from({ length: 45 }, (_, i) => `s${i}`);
  let flushCalls = 0;
  const res = await fetchThenFlush(items, {
    fetchOne: async (it) => [{ code: it }],
    flushRows: async () => { flushCalls++; },
    chunkSize: 20, sleep: noSleep,
  });
  assert.equal(flushCalls, 3); assert.equal(res.flushed, 45); assert.equal(res.rate, 1);

  // 음성 대조: 두 번째 chunk 의 flush 가 영구 실패하면 그 chunk 항목은 성공으로 세지 않는다
  let call = 0;
  const bad = await fetchThenFlush(items, {
    fetchOne: async (it) => [{ code: it }],
    flushRows: async (rows) => { call++; if (rows.some(r => r.code === 's25')) throw new Error('DB 영구 오류'); },
    chunkSize: 20, sleep: noSleep,
  });
  assert.equal(bad.flushed, 25); assert.equal(bad.failed.length, 20); assert.ok(bad.rate < 0.95);
  assert.match(bad.failed[0].error, /flush/);
});

test('fetchThenFlush 음성 대조: 0행 응답은 성공으로 세지 않고 empty 로 따로 센다', async () => {
  const items = ['a', 'b', 'c', 'd'];
  let flushed = [];
  const res = await fetchThenFlush(items, {
    fetchOne: async (it) => (it === 'a' || it === 'b' ? [] : [{ code: it }]),   // a,b 는 빈 응답
    flushRows: async (rows) => { flushed.push(...rows); }, chunkSize: 20, sleep: noSleep,
  });
  assert.equal(res.empty, 2); assert.equal(res.flushed, 2); assert.equal(res.rows, 2);
  assert.equal(res.rate, 0.5);                 // 빈 응답은 성공률에 포함되지 않는다
  assert.equal(res.rateIncludingEmpty, 1);     // 참고용 수치만 따로
  assert.ok(res.rate < 0.95);
  assert.deepEqual(res.emptyItems, ['a', 'b']);
  // 전부 빈 응답이면 성공 0 (이전 구현은 100% 로 보고했다)
  const all = await fetchThenFlush(['x', 'y'], { fetchOne: async () => [], flushRows: async () => {}, sleep: noSleep });
  assert.equal(all.rate, 0); assert.equal(all.flushed, 0);
});

test('withBackoff shouldRetry: 내부 재시도 계층의 오류는 바깥에서 다시 재시도하지 않는다(호출 곱셈 방지)', async () => {
  const outer = (e) => isThrottleError(e) && !/^KIS \w+:/.test(String(e?.message));
  let n = 0;
  await assert.rejects(withBackoff(async () => { n++; throw new Error('KIS FHKST01010900: 초당 거래건수를 초과하였습니다.'); }, { retries: 1, sleep: noSleep, shouldRetry: outer }));
  assert.equal(n, 1);
  // 네트워크 오류는 바깥에서 1회 재시도
  let m = 0;
  await assert.rejects(withBackoff(async () => { m++; throw new TypeError('fetch failed'); }, { retries: 1, sleep: noSleep, shouldRetry: outer }));
  assert.equal(m, 2);
});

test('makeDbQuery: Throttler 응답 후 재시도해 성공, 오류 응답은 throw', async () => {
  const resp = [{ message: 'ThrottlerException: Too Many Requests' }, { message: 'ThrottlerException: Too Many Requests' }, [{ x: 1 }]];
  let i = 0;
  const db = makeDbQuery({ ref: 'r', key: 'k', sleep: noSleep, fetchImpl: async () => ({ status: 200, json: async () => resp[i++] }) });
  assert.deepEqual(await db('select 1'), [{ x: 1 }]); assert.equal(i, 3);
  // 음성 대조: SQL 오류(비-throttle)는 재시도하지 않고 즉시 throw
  let c = 0;
  const db2 = makeDbQuery({ ref: 'r', key: 'k', sleep: noSleep, fetchImpl: async () => { c++; return { status: 400, json: async () => ({ message: 'syntax error at or near' }) }; } });
  await assert.rejects(db2('bad'), /syntax error/); assert.equal(c, 1);
});

test('splitWindows: 85일 창으로 분할, 경계 중복 없음, 잘못된 입력 거부', () => {
  const w = splitWindows('20231001', '20261001', 85);
  assert.equal(w[0][0], '20231001'); assert.equal(w.at(-1)[1], '20261001');
  for (let i = 1; i < w.length; i++) assert.ok(w[i][0] > w[i - 1][1]);
  assert.equal(splitWindows('20260101', '20260110', 85).length, 1);
  assert.throws(() => splitWindows('2026-01-01', '20260110'));
  assert.throws(() => splitWindows('20260110', '20260101'));
});
