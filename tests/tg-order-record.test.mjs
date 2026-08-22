/**
 * tg-order-record.test.mjs — 수동 주문 기록이 **실제로 파일에 쓰이는지** 기계 검증 (2026-08-04)
 *
 * 왜 필요한가: executeBuy/executeSell 의 기록 경로는 실주문(dryRun:false)에서만 돈다.
 * 즉 평상시엔 한 줄도 실행되지 않아 "고쳤다"고 믿을 근거가 없다.
 * 08-04 에 forecast-llm 에서 `node --check` 통과 + import 시점 ReferenceError 를 겪었다 —
 * 구문검사는 동작 확인이 아니다. 그래서 남아야 할 흔적을 **파일로** 확인한다.
 *
 * 실행: node --test tests/tg-order-record.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { recordManual, MANUAL_LOG } from '../tg-order.mjs';

const dir = mkdtempSync(join(tmpdir(), 'tgrec-'));
const F = join(dir, 'manual-trades.jsonl');

test('매수 주문이 한 줄로 append 되고 필수 필드가 남는다', () => {
  const ok = recordManual({ ts: '2026-08-04 13:30:00', code: '005930', name: '삼성전자', side: 'BUY', limitPx: 240000, qty: 4, cost: 960000, orderId: 'X1' }, F);
  assert.equal(ok, true, 'recordManual 이 true 를 반환해야 한다(쓰기 성공)');
  assert.ok(existsSync(F), '파일이 생성돼야 한다');
  const lines = readFileSync(F, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const j = JSON.parse(lines[0]);
  assert.equal(j.side, 'BUY');
  assert.equal(j.code, '005930');
  assert.equal(j.qty, 4);
  assert.equal(j.orderId, 'X1');
  // 체결가로 오인되지 않게 표시가 붙어야 한다 — 이게 08-03 결함(지정가를 체결가로 기록)의 재발 방지다
  assert.equal(j.kind, 'order', 'kind=order 로 체결 아님이 명시돼야 한다');
  assert.equal(j.src, 'telegram');
  assert.equal(j.px, undefined, '체결가(px) 필드는 있으면 안 된다 — 모르는 값이다');
});

test('매도 주문에 평단·예상수익률이 남아 사후 실현손익 계산이 가능하다', () => {
  recordManual({ ts: '2026-08-04 13:31:00', code: '030200', name: 'KT', side: 'SELL', limitPx: 52000, qty: 57, entry: 51884, holdQty: 57, full: true, retAtLimit: 0.2, orderId: 'X2' }, F);
  const lines = readFileSync(F, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'append 이므로 기존 줄이 유지돼야 한다');
  const j = JSON.parse(lines[1]);
  assert.equal(j.side, 'SELL');
  assert.equal(j.entry, 51884, '평단이 없으면 실현손익을 낼 수 없다');
  assert.equal(j.qty, 57, 'qty 가 없으면 원화 손익을 낼 수 없다(기존 저널의 실패 지점)');
  assert.equal(j.full, true);
  assert.equal(j.retAtLimit, 0.2);
});

test('append 이므로 여러 번 호출해도 이전 기록을 덮지 않는다', () => {
  for (let i = 0; i < 5; i++) recordManual({ ts: `2026-08-04 14:0${i}:00`, code: '000660', side: 'BUY', qty: i + 1 }, F);
  const lines = readFileSync(F, 'utf8').trim().split('\n');
  assert.equal(lines.length, 7, '2 + 5 = 7 줄이어야 한다(read-modify-write 가 아니라 append)');
  assert.equal(JSON.parse(lines.at(-1)).qty, 5);
});

test('쓰기 불가 경로에서도 예외를 던지지 않는다 (주문을 막으면 안 된다)', () => {
  // 존재하지 않는 디렉터리 → appendFileSync 실패. false 를 반환하고 throw 하지 않아야 한다.
  const bad = join(dir, 'no-such-dir', 'x.jsonl');
  let threw = false, ret = null;
  try { ret = recordManual({ ts: 'x', code: 'y' }, bad); } catch { threw = true; }
  assert.equal(threw, false, '예외가 밖으로 나가면 주문 경로가 죽는다');
  assert.equal(ret, false, '실패는 false 로 알려야 한다');
});

test('운영 기본 경로가 저장소 안을 가리킨다', () => {
  assert.ok(String(MANUAL_LOG).endsWith('manual-trades.jsonl'));
  assert.ok(!String(MANUAL_LOG).includes('tgrec-'), '기본 경로가 테스트 임시경로로 오염되지 않았다');
});

test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });
