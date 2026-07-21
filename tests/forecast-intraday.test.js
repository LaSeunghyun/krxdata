import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupByDate, priceAt, lastBarHm, intervalReturn, historyIntervalReturns,
  basketSessionSeries, basketLiveMove,
} from '../forecast-intraday.mjs';

const bar = (date, hm, close) => ({ timestamp: `${date}T${hm.slice(0, 2)}:${hm.slice(2)}:00.000+09:00`, close });

test('groupByDate — 날짜별 그룹·hm 오름차순·0가 제거', () => {
  const by = groupByDate([
    bar('2026-07-18', '1030', 100), bar('2026-07-18', '0900', 98),
    bar('2026-07-17', '1500', 95), bar('2026-07-18', '1200', 0),
  ]);
  assert.deepEqual([...by.keys()].sort(), ['20260717', '20260718']);
  assert.deepEqual(by.get('20260718').map(b => b.hm), ['0900', '1030']);
});

test('priceAt — 해당 시각 이전 마지막 체결가', () => {
  const bars = groupByDate([bar('2026-07-18', '0900', 98), bar('2026-07-18', '1030', 100)]).get('20260718');
  assert.equal(priceAt(bars, '0930'), 98);
  assert.equal(priceAt(bars, '1030'), 100);
  assert.equal(priceAt(bars, '0859'), null); // 세션 전
  assert.equal(lastBarHm(bars), '1030');
});

test('intervalReturn — 완결 확인 가드', () => {
  const bars = groupByDate([
    bar('2026-07-18', '1030', 100), bar('2026-07-18', '1129', 102),
  ]).get('20260718');
  // 당일(미과거)이고 마지막 봉(11:29) < 종료(11:30) → 미완결 null
  assert.equal(intervalReturn(bars, '1030', '1130', { dateIsPast: false }), null);
  // 과거 날짜면 마지막 체결가로 완결 처리
  assert.ok(Math.abs(intervalReturn(bars, '1030', '1130', { dateIsPast: true }) - 2) < 1e-9);
  // 종료 시각 봉 존재 시 당일도 완결
  const done = groupByDate([
    bar('2026-07-18', '1030', 100), bar('2026-07-18', '1130', 103),
  ]).get('20260718');
  assert.ok(Math.abs(intervalReturn(done, '1030', '1130', { dateIsPast: false }) - 3) < 1e-9);
});

test('historyIntervalReturns — 대상일 제외, 미완결일 제외', () => {
  const by = groupByDate([
    bar('2026-07-16', '1030', 100), bar('2026-07-16', '1130', 101),
    bar('2026-07-17', '1030', 200), bar('2026-07-17', '1130', 198),
    bar('2026-07-18', '1030', 300), bar('2026-07-18', '1100', 330), // 오늘: 미완결
  ]);
  const rs = historyIntervalReturns(by, '1030', '1130', { excludeDate: '20260718', todayKey: '20260718' });
  assert.equal(rs.length, 2);
  assert.ok(Math.abs(rs[0] - 1) < 1e-9 && Math.abs(rs[1] - (-1)) < 1e-9);
});

test('basketSessionSeries — 시총가중·유효종목수·커버리지', () => {
  const byDateBySymbol = {
    A: groupByDate([bar('2026-07-17', '1530', 100), bar('2026-07-17', '2000', 102)]),
    B: groupByDate([bar('2026-07-17', '1530', 50), bar('2026-07-17', '2000', 49)]),
    C: groupByDate([]), // 체결 없음
  };
  const s = basketSessionSeries(byDateBySymbol, { A: 3, B: 1, C: 1 }, '1530', '2000', { todayKey: '20260718' });
  assert.equal(s.length, 1);
  // 가중평균: (2%*3 + -2%*1) / 4 = 1%
  assert.ok(Math.abs(s[0].ret - 1) < 1e-9);
  assert.equal(s[0].n, 2);
  assert.equal(s[0].coverage, 0.8); // (3+1)/5
});

test('basketLiveMove — 기준일 종가 대비 현재가 (관측)', () => {
  const byDateBySymbol = {
    A: groupByDate([bar('2026-07-17', '1530', 100), bar('2026-07-18', '0840', 103)]),
  };
  const m = basketLiveMove(byDateBySymbol, { A: 1 }, '1530', '20260718', { baseDate: '20260717' });
  assert.ok(Math.abs(m.ret - 3) < 1e-9);
  assert.equal(m.n, 1);
  assert.equal(basketLiveMove(byDateBySymbol, { A: 1 }, '1530', '20260719', { baseDate: '20260717' }), null);
});

test('relabelStampsToTradingDays — 적재일→실거래일, 주말·휴일 중복 제거', async () => {
  const { relabelStampsToTradingDays } = await import('../forecast-intraday.mjs');
  // 실거래일: 0715, 0716, 0720, 0721 (0717 휴일, 주말)
  const trading = ['20260715', '20260716', '20260720', '20260721'];
  const stamps = [
    { date: '20260716', ret: 0.5 },  // → true 0715
    { date: '20260717', ret: -6.6 }, // → true 0716
    { date: '20260718', ret: 0 },    // 주말 중복 → true 0716 이미 사용 → 제거
    { date: '20260719', ret: 0 },    // 제거
    { date: '20260720', ret: 0 },    // 휴일 뒤 중복 → true 0716 사용됨 → 제거
    { date: '20260721', ret: -4.5 }, // → true 0720
  ];
  const out = relabelStampsToTradingDays(stamps, trading);
  assert.deepEqual(out.map(x => [x.date, x.ret]), [['20260715', 0.5], ['20260716', -6.6], ['20260720', -4.5]]);
  assert.deepEqual(relabelStampsToTradingDays(stamps, []), []);
});
