import test from 'node:test';
import assert from 'node:assert/strict';
import { recentPeriods } from '../dart-quarterly-backfill.js';

/**
 * dart-quarterly-backfill.js 의 대상 기간 산출 회귀 테스트.
 *
 * 왜 필요한가: 기존에는 대상 기간이 코드에 하드코딩돼 있었고, 그 탓에 2026 반기(11012)가
 * 통째로 누락된 채 방치돼 있었다(2026-08-14 발견). 날짜 유도로 바꿨으므로 경계일 동작을
 * 고정해 둔다. 이 로직이 조용히 틀리면 "적재는 성공했는데 엉뚱한 분기" 가 되어 무음 실패한다.
 *
 * 법정 제출기한: 1분기 5/15 · 반기 8/14 · 3분기 11/14 (12월 결산 기준).
 */
const at = (iso) => new Date(`${iso}T12:00:00+09:00`);
const codes = (arr) => arr.map((p) => `${p.year}:${p.reprtCode}`);

test('recentPeriods: 반기 마감일 당일이면 반기(11012)가 1순위', () => {
  const p = recentPeriods(3, at('2026-08-14'));
  assert.deepEqual(codes(p), ['2026:11012', '2026:11013', '2025:11014']);
});

test('recentPeriods: 반기 마감 전날이면 아직 1분기(11013)가 1순위', () => {
  const p = recentPeriods(3, at('2026-08-13'));
  assert.deepEqual(codes(p), ['2026:11013', '2025:11014', '2025:11012']);
});

test('recentPeriods: 1분기 마감일 당일 경계', () => {
  assert.equal(codes(recentPeriods(1, at('2026-05-15')))[0], '2026:11013');
  assert.equal(codes(recentPeriods(1, at('2026-05-14')))[0], '2025:11014');
});

test('recentPeriods: 3분기 마감일 당일 경계', () => {
  assert.equal(codes(recentPeriods(1, at('2026-11-14')))[0], '2026:11014');
  assert.equal(codes(recentPeriods(1, at('2026-11-13')))[0], '2026:11012');
});

test('recentPeriods: 연초(5/15 이전)는 전년 3분기부터 역순', () => {
  const p = recentPeriods(3, at('2026-03-01'));
  assert.deepEqual(codes(p), ['2025:11014', '2025:11012', '2025:11013']);
});

test('recentPeriods: 연말은 해가 넘어가도 순서가 끊기지 않는다', () => {
  const p = recentPeriods(4, at('2026-12-31'));
  assert.deepEqual(codes(p), ['2026:11014', '2026:11012', '2026:11013', '2025:11014']);
});

test('recentPeriods: 사업보고서(11011)는 절대 포함하지 않는다', () => {
  // 연간 재무는 dart-financials-backfill.js 담당. 섞이면 stock_financials 연간 행을 덮어쓴다.
  const p = recentPeriods(12, at('2026-08-14'));
  assert.ok(p.every((x) => x.reprtCode !== '11011'), '11011이 섞였다');
});

test('recentPeriods: count 만큼 정확히, 중복 없이 반환', () => {
  const p = recentPeriods(9, at('2026-08-14'));
  assert.equal(p.length, 9);
  assert.equal(new Set(codes(p)).size, 9, '중복 기간이 있다');
});

test('recentPeriods: 시간이 과거로만 진행한다(역순 보장)', () => {
  const p = recentPeriods(9, at('2026-08-14'));
  const ORDER = { '11013': 0, '11012': 1, '11014': 2 };
  for (let i = 1; i < p.length; i++) {
    const prev = Number(p[i - 1].year) * 10 + ORDER[p[i - 1].reprtCode];
    const cur = Number(p[i].year) * 10 + ORDER[p[i].reprtCode];
    assert.ok(cur < prev, `${codes(p)[i]} 가 ${codes(p)[i - 1]} 보다 미래다`);
  }
});
