import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRequest, readRequestsAfter } from '../tg-requests.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'tgreq-'));

test('파일이 없으면 요청 0건이고 커서는 그대로다', () => {
  const r = readRequestsAfter(0, tmp());
  assert.deepEqual(r.items, []);
  assert.equal(r.lines, 0);
});

test('append 한 요청을 읽고 커서가 전진한다', () => {
  const d = tmp();
  appendRequest({ type: 'ai_exit_approve', code: '042660', name: '한화오션' }, d);
  const r = readRequestsAfter(0, d);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].type, 'ai_exit_approve');
  assert.equal(r.items[0].code, '042660');
  assert.equal(r.lines, 1);
});

test('커서 이후만 읽는다 — 이미 소비한 요청을 다시 주지 않는다', () => {
  const d = tmp();
  appendRequest({ type: 'a', code: '1' }, d);
  appendRequest({ type: 'b', code: '2' }, d);
  const first = readRequestsAfter(0, d);
  assert.equal(first.items.length, 2);
  const second = readRequestsAfter(first.lines, d);
  assert.deepEqual(second.items, []);
  assert.equal(second.lines, 2);
});

test('같은 초에 들어온 두 요청이 각각 1회씩 처리된다 (ts 커서였다면 하나가 유실된다)', () => {
  const d = tmp();
  const ts = '2026-08-26 09:00:00';
  appendRequest({ type: 'ai_exit_approve', code: '1', ts }, d);
  appendRequest({ type: 'ai_exit_approve', code: '2', ts }, d);
  const r = readRequestsAfter(0, d);
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map(x => x.code), ['1', '2']);
});

test('깨진 라인 하나가 뒤 라인 처리를 막지 않는다', () => {
  const d = tmp();
  appendRequest({ type: 'a', code: '1' }, d);
  appendFileSync(join(d, '.tg-requests.jsonl'), '{{{ broken\n');
  appendRequest({ type: 'c', code: '3' }, d);
  const r = readRequestsAfter(0, d);
  assert.deepEqual(r.items.map(x => x.code), ['1', '3']);
  assert.equal(r.skipped, 1);
  assert.equal(r.lines, 3, '깨진 줄도 커서를 전진시켜야 무한 재시도가 안 생긴다');
});

test('빈 줄은 무시한다', () => {
  const d = tmp();
  writeFileSync(join(d, '.tg-requests.jsonl'), '\n\n' + JSON.stringify({ type: 'a', code: '1' }) + '\n\n');
  const r = readRequestsAfter(0, d);
  assert.equal(r.items.length, 1);
  assert.equal(r.lines, 1);
});

test('파일이 줄어들면 커서를 재동기화한다 (회전·재생성 대비)', () => {
  const d = tmp();
  writeFileSync(join(d, '.tg-requests.jsonl'), JSON.stringify({ type: 'a', code: '1' }) + '\n');
  const r = readRequestsAfter(99, d);
  assert.deepEqual(r.items, [], '과거 요청을 소급 재실행하지 않는다');
  assert.equal(r.lines, 1);
});

test('append 는 ts 를 자동으로 채운다', () => {
  const d = tmp();
  appendRequest({ type: 'a', code: '1' }, d);
  assert.ok(readRequestsAfter(0, d).items[0].ts, 'ts 가 있어야 사후 추적이 된다');
});
