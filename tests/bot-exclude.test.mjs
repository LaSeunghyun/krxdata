import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readBotExclude, readBotExcludeManual, readBotExcludeAuto,
  addBotExclude, removeBotExclude, addBotExcludeAuto, removeBotExcludeAuto,
} from '../bot-exclude.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'botexcl-'));

test('두 파일의 합집합을 읽는다', () => {
  const d = tmp();
  writeFileSync(join(d, '.bot-exclude.json'), JSON.stringify(['000270']));
  writeFileSync(join(d, '.bot-exclude-auto.json'), JSON.stringify(['052690']));
  assert.deepEqual([...readBotExclude(d)].sort(), ['000270', '052690']);
});

test('파일이 없어도 빈 집합을 준다', () => {
  assert.equal(readBotExclude(tmp()).size, 0);
});

test('addBotExclude 는 수동 파일에만 쓴다', () => {
  const d = tmp();
  addBotExclude('000270', d);
  assert.deepEqual([...readBotExcludeManual(d)], ['000270']);
  assert.equal(readBotExcludeAuto(d).size, 0);
  assert.equal(existsSync(join(d, '.bot-exclude-auto.json')), false);
});

test('addBotExcludeAuto 는 자동 파일에만 쓴다', () => {
  const d = tmp();
  addBotExcludeAuto('052690', d);
  assert.deepEqual([...readBotExcludeAuto(d)], ['052690']);
  assert.equal(readBotExcludeManual(d).size, 0);
});

test('removeBotExclude 는 자동 파일을 건드리지 않는다 (D6 — writer 1개 원칙)', () => {
  const d = tmp();
  addBotExclude('999999', d);
  addBotExcludeAuto('999999', d);
  removeBotExclude('999999', d);
  assert.equal(readBotExcludeManual(d).size, 0);
  assert.deepEqual([...readBotExcludeAuto(d)], ['999999'], '자동 파일이 남아 있어야 한다');
});

test('removeBotExcludeAuto 는 수동 파일을 건드리지 않는다', () => {
  const d = tmp();
  addBotExclude('999999', d);
  addBotExcludeAuto('999999', d);
  removeBotExcludeAuto('999999', d);
  assert.deepEqual([...readBotExcludeManual(d)], ['999999'], '수동 파일이 남아 있어야 한다');
  assert.equal(readBotExcludeAuto(d).size, 0);
});

test('손상된 JSON 은 빈 집합으로 읽되 다른 파일은 살린다', () => {
  const d = tmp();
  writeFileSync(join(d, '.bot-exclude.json'), '{{{ broken');
  writeFileSync(join(d, '.bot-exclude-auto.json'), JSON.stringify(['052690']));
  assert.deepEqual([...readBotExclude(d)], ['052690']);
});

test('addBotExcludeAuto 는 쓰기 실패를 삼키지 않는다', () => {
  // 존재하지 않는 디렉터리 = 쓰기 실패. 호출부가 경보를 낼 수 있어야 한다.
  assert.throws(() => addBotExcludeAuto('000270', join(tmpdir(), 'no-such-dir-xyz-9999')));
});

test('중복 추가는 멱등이다', () => {
  const d = tmp();
  addBotExcludeAuto('052690', d);
  addBotExcludeAuto('052690', d);
  assert.deepEqual(JSON.parse(readFileSync(join(d, '.bot-exclude-auto.json'), 'utf8')), ['052690']);
});
