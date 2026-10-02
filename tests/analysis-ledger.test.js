import test from 'node:test';
import assert from 'node:assert/strict';
import { nthTradingDay, scoreRow } from '../score-analysis-ledger.mjs';

// 2026-09 달력 가정: 9/24(목)~9/28(월)은 추석 연휴 휴장, 주말 제외
const OPEN = [
  '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
  '2026-09-21', '2026-09-22', '2026-09-23',
  '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02',
  '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08',
];

test('주말을 건너뛴다: 금요일 기준 +1 거래일은 월요일', () => {
  assert.equal(nthTradingDay(OPEN, '2026-09-18', 1), '2026-09-21');
});

test('휴장 연휴를 건너뛴다: 9/23 기준 +1 은 9/29, +5 는 10/5', () => {
  assert.equal(nthTradingDay(OPEN, '2026-09-23', 1), '2026-09-29');
  assert.equal(nthTradingDay(OPEN, '2026-09-23', 5), '2026-10-05');
});

test('음성 대조: 달력일 +5 (9/28)로 세면 틀린다', () => {
  assert.notEqual(nthTradingDay(OPEN, '2026-09-23', 5), '2026-09-28');
});

test('ref 가 비거래일이어도 이후 첫 거래일부터 센다', () => {
  assert.equal(nthTradingDay(OPEN, '2026-09-26', 1), '2026-09-29');
});

test('데이터가 모자라면 null', () => {
  assert.equal(nthTradingDay(OPEN, '2026-10-05', 5), null);
});

const mk = (closes) => new Map(Object.entries(closes));

test('scoreRow: 5거래일만 지난 행은 ret_5d 만 채우고 scored_at 없음', () => {
  const row = { ref_trade_date: '2026-09-23', ref_close: 100, short_target: 110, ret_5d: null, ret_20d: null };
  const p = scoreRow(row, OPEN, mk({ '2026-10-05': 105 }));
  assert.deepEqual(p, { ret_5d: 5 });
});

test('scoreRow: 20거래일 채점 + hit_short(목표가 도달)', () => {
  const days = [];
  for (let i = 0; i < 30; i++) days.push(`d${String(i).padStart(2, '0')}`);
  const closes = {};
  days.forEach((d, i) => { closes[d] = 100 + i; });
  const row = { ref_trade_date: 'd00', ref_close: 100, short_target: 110, ret_5d: null, ret_20d: null };
  // closes d01=101 ... d20=120
  const p = scoreRow(row, days, mk(closes));
  assert.equal(p.ret_5d, 5);
  assert.equal(p.ret_20d, 20);
  assert.equal(p.hit_short, true);
  assert.equal(p.scored_at, 'now');
});

test('scoreRow 음성 대조: 목표가에 못 닿으면 hit_short=false', () => {
  const days = Array.from({ length: 25 }, (_, i) => `d${String(i).padStart(2, '0')}`);
  const closes = Object.fromEntries(days.map((d) => [d, 100]));
  const row = { ref_trade_date: 'd00', ref_close: 100, short_target: 130, ret_5d: null, ret_20d: null };
  const p = scoreRow(row, days, mk(closes));
  assert.equal(p.hit_short, false);
  assert.equal(p.ret_20d, 0);
});

test('scoreRow: 종가 데이터가 없으면 패치 없음 (거짓 채점 금지)', () => {
  const row = { ref_trade_date: '2026-09-23', ref_close: 100, short_target: 110, ret_5d: null, ret_20d: null };
  assert.deepEqual(scoreRow(row, OPEN, new Map()), {});
});
