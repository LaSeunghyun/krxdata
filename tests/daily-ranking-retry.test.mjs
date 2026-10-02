import test from "node:test";
import assert from "node:assert/strict";
import { isRetryableDbFailure, withDbRetry } from "../daily-ranking.js";

const noSleep = { sleep: async () => {}, tries: 4, baseMs: 1 };

test("isRetryableDbFailure: 연결 타임아웃·429·5xx·네트워크 실패는 재시도", () => {
  assert.equal(isRetryableDbFailure({ message: "Failed to run sql query: Connection terminated due to connection timeout" }), true);
  assert.equal(isRetryableDbFailure({ message: "ThrottlerException: Too Many Requests" }), true);
  assert.equal(isRetryableDbFailure({ status: 429 }), true);
  assert.equal(isRetryableDbFailure({ status: 503 }), true);
  assert.equal(isRetryableDbFailure({ thrown: true }), true);
});

test("isRetryableDbFailure: SQL 문법·권한 오류는 재시도하지 않는다 (음성 대조)", () => {
  assert.equal(isRetryableDbFailure({ status: 400, message: 'syntax error at or near "SELEC"' }), false);
  assert.equal(isRetryableDbFailure({ status: 400, message: 'relation "x" does not exist' }), false);
  assert.equal(isRetryableDbFailure({ status: 401, message: "Unauthorized" }), false);
});

test("withDbRetry: 일시 실패 2회 뒤 성공하면 값을 돌려준다", async () => {
  let n = 0;
  const v = await withDbRetry(async () => (++n < 3 ? { retry: true, error: new Error("timeout") } : { value: [{ ok: 1 }] }), noSleep);
  assert.deepEqual(v, [{ ok: 1 }]);
  assert.equal(n, 3);
});

test("withDbRetry: 계속 실패하면 횟수 소진 후 마지막 오류를 던진다 (음성 대조)", async () => {
  let n = 0;
  await assert.rejects(
    withDbRetry(async () => { n++; return { retry: true, error: new Error("still timeout") }; }, noSleep),
    /still timeout/,
  );
  assert.equal(n, 4);
});

test("withDbRetry: fatal(문법·권한 오류)은 재시도 없이 즉시 던진다 (음성 대조)", async () => {
  let n = 0;
  await assert.rejects(withDbRetry(async () => { n++; return { fatal: new Error("syntax error") }; }, noSleep), /syntax error/);
  assert.equal(n, 1);
});
