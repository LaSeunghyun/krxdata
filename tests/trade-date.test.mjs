import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays, isWeekend, toIso, kstToday, isKrxSession,
  calendarFromCandles, prevOpenDay, isCopyDay, decideTradeDate,
  mapLoadDatesToTradeDates, ohlcvRows, buildOhlcvUpdateSql,
} from "../trade-date.mjs";

const cal = (obj) => new Map(Object.entries(obj));

test("isWeekend: 2026-09-26 토 / 09-27 일 / 09-28 월", () => {
  assert.equal(isWeekend("20260926"), true);
  assert.equal(isWeekend("20260927"), true);
  assert.equal(isWeekend("20260928"), false); // 음성 대조: 월요일은 주말 아님
});

test("calendarFromCandles: 주말 휴장, 평일 휴장은 일봉 부재로 판정 (추석 9/24·9/25)", () => {
  const bars = [
    { date: "20260922", volume: 100 }, { date: "20260923", volume: 100 },
    { date: "20260928", volume: 100 }, { date: "20260929", volume: 100 },
  ];
  const rows = calendarFromCandles([bars], "20260922", "20260929");
  const m = new Map(rows.map(r => [r.trade_date, r]));
  assert.equal(m.get("2026-09-23").is_open, true);
  assert.equal(m.get("2026-09-24").is_open, false);
  assert.equal(m.get("2026-09-24").source, "toss_no_candle");
  assert.equal(m.get("2026-09-25").is_open, false);
  assert.equal(m.get("2026-09-26").source, "weekend");
  assert.equal(m.get("2026-09-28").is_open, true);
});

test("calendarFromCandles: 거래량 0 봉은 개장으로 세지 않는다 (음성 대조)", () => {
  const rows = calendarFromCandles([[{ date: "20260923", volume: 5 }, { date: "20260924", volume: 0 }, { date: "20260928", volume: 5 }]], "20260923", "20260928");
  assert.equal(rows.find(r => r.trade_date === "2026-09-24").is_open, false);
});

test("calendarFromCandles: 여러 기준 종목은 합집합 (한 종목 거래정지여도 개장)", () => {
  const a = [{ date: "20260923", volume: 5 }, { date: "20260928", volume: 5 }];
  const b = [{ date: "20260923", volume: 5 }, { date: "20260924", volume: 5 }, { date: "20260928", volume: 5 }];
  const rows = calendarFromCandles([a, b], "20260923", "20260928");
  assert.equal(rows.find(r => r.trade_date === "2026-09-24").is_open, true);
});

test("calendarFromCandles: 일봉 커버 이전 평일은 판정 불가라 행을 만들지 않는다", () => {
  const rows = calendarFromCandles([[{ date: "20260923", volume: 5 }]], "20260921", "20260923");
  assert.equal(rows.some(r => r.trade_date === "2026-09-22"), false);
  assert.equal(rows.some(r => r.trade_date === "2026-09-23"), true);
});

test("prevOpenDay: 토요일 적재 -> 금요일", () => {
  assert.equal(prevOpenDay(cal({}), "20260926"), "20260925"); // 캘린더 없음: 직전 평일
  assert.equal(prevOpenDay(cal({ "20260925": true }), "20260926"), "20260925");
});

test("prevOpenDay: 월요일 적재 -> 금요일 (일요일은 건너뜀)", () => {
  assert.equal(prevOpenDay(cal({}), "20260928"), "20260925");
});

test("prevOpenDay: 추석 휴장 9/24·9/25 는 건너뛴다", () => {
  const c = cal({ "20260923": true, "20260924": false, "20260925": false });
  assert.equal(prevOpenDay(c, "20260929"), "20260928");
  assert.equal(prevOpenDay(c, "20260925"), "20260923"); // 9/25 적재 = 9/24 휴장 -> 9/23
  assert.notEqual(prevOpenDay(c, "20260925"), "20260924");
});

test("isCopyDay: 경계 (0.9 초과만 복사본)", () => {
  assert.equal(isCopyDay(1.0), true);
  assert.equal(isCopyDay(0.95), true);
  assert.equal(isCopyDay(0.9), false);
  assert.equal(isCopyDay(0.07), false);
  assert.equal(isCopyDay(NaN), false);
});

test("decideTradeDate: 토요일 적재 행(어제 금요일 종가) -> 금요일", () => {
  const t = decideTradeDate({ loadYmd: "20260926", calendar: cal({ "20260925": true }), claimed: new Set(), sameShare: 0.07 });
  assert.equal(t, "20260925");
});

test("decideTradeDate: 일요일 복사본 행 -> NULL (음성 대조)", () => {
  const t = decideTradeDate({ loadYmd: "20260927", calendar: cal({}), claimed: new Set(["20260925"]), sameShare: 1.0 });
  assert.equal(t, null);
});

test("decideTradeDate: 월요일 적재 = 일요일 복사본 -> NULL (음성 대조: 금요일로 매핑하면 안 됨)", () => {
  const t = decideTradeDate({ loadYmd: "20260928", calendar: cal({}), claimed: new Set(["20260925"]), sameShare: 1.0 });
  assert.equal(t, null);
});

test("decideTradeDate: 복사본이 아니어도 후보 거래일이 이미 배정됐으면 NULL", () => {
  const t = decideTradeDate({ loadYmd: "20260928", calendar: cal({}), claimed: new Set(["20260925"]), sameShare: 0.3 });
  assert.equal(t, null);
});

test("decideTradeDate: 화요일 적재(월요일 종가) -> 월요일", () => {
  const t = decideTradeDate({ loadYmd: "20260929", calendar: cal({ "20260928": true }), claimed: new Set(), sameShare: 0.06 });
  assert.equal(t, "20260928");
});

test("mapLoadDatesToTradeDates: 토요일 적재 -> 금요일, 일·월 복사본 -> NULL, 화요일 -> 월요일", () => {
  const entries = [
    { date: "20260926", shares: { "20260925": 0.77, "20260924": 0.05, "20260923": 0.04 } }, // 토
    { date: "20260927", shares: { "20260925": 0.77, "20260924": 0.05 } },                   // 일 (복사)
    { date: "20260928", shares: { "20260925": 0.77, "20260924": 0.05 } },                   // 월 (복사)
    { date: "20260929", shares: { "20260928": 0.8, "20260925": 0.06 } },                     // 화
  ];
  const m = mapLoadDatesToTradeDates(entries, cal({ "20260925": true, "20260928": true }));
  assert.equal(m.get("20260926").trade, "20260925");
  assert.equal(m.get("20260927").trade, null);
  assert.equal(m.get("20260927").reason, "duplicate_copy");
  assert.equal(m.get("20260928").trade, null);
  assert.equal(m.get("20260929").trade, "20260928");
});

test("mapLoadDatesToTradeDates: 장 마감 후 적재 체제(date == 거래일)는 오프셋 0", () => {
  const entries = [
    { date: "20260611", shares: { "20260611": 1.0, "20260610": 0.06 } },
    { date: "20260612", shares: { "20260612": 0.78, "20260611": 0.07 } },
    { date: "20260613", shares: { "20260612": 0.78, "20260611": 0.07 } }, // 토요일 적재 = 금요일 종가 복사
  ];
  const m = mapLoadDatesToTradeDates(entries, new Map());
  assert.equal(m.get("20260611").trade, "20260611");
  assert.equal(m.get("20260612").trade, "20260612"); // date - 1 규칙이면 틀린다
  assert.equal(m.get("20260613").trade, null);
});

test("mapLoadDatesToTradeDates: 일치율 미달 행(정체·오염 가격)은 NULL", () => {
  const entries = [{ date: "20260618", shares: { "20260618": 0.07, "20260617": 0.04 } }];
  const m = mapLoadDatesToTradeDates(entries, new Map());
  assert.equal(m.get("20260618").trade, null);
  assert.equal(m.get("20260618").reason, "low_match");
});

test("mapLoadDatesToTradeDates: 휴장일(캘린더 closed) 후보는 채택하지 않는다", () => {
  const entries = [{ date: "20260925", shares: { "20260924": 0.9, "20260923": 0.1 } }];
  const m = mapLoadDatesToTradeDates(entries, cal({ "20260924": false, "20260923": true }));
  assert.equal(m.get("20260925").trade, null); // 0.1 < minShare, 휴장 후보 제외
});

test("ohlcvRows: 오늘(미완성) 봉 제외, turnover = close x volume", () => {
  const bars = [
    { timestamp: "2026-10-01T00:00:00.000+09:00", open: 1, high: 2, low: 1, close: 2, volume: 10 },
    { timestamp: "2026-09-30T00:00:00.000+09:00", open: 10680, high: 10970, low: 10470, close: 10770, volume: 5135701 },
    { timestamp: "2026-09-29T00:00:00.000+09:00", open: NaN, high: 1, low: 1, close: 1, volume: 1 },
  ];
  const r = ohlcvRows("036540", bars, "20261001");
  assert.equal(r.length, 1);
  assert.equal(r[0].trade, "20260930");
  assert.equal(r[0].turnover, 10770 * 5135701);
});

test("buildOhlcvUpdateSql: close 를 SET 하지 않고, NULL 칸만·오차 조건이 있다 / 잘못된 코드는 제외", () => {
  const sql = buildOhlcvUpdateSql([
    { code: "036540", trade: "20260930", open: 1, high: 2, low: 1, close: 2, volume: 3, turnover: 6 },
    { code: "x'; DROP TABLE stock_prices;--", trade: "20260930", open: 1, high: 2, low: 1, close: 2, volume: 3, turnover: 6 },
  ]);
  assert.ok(!/SET[^F]*close\s*=/.test(sql.split("FROM")[0]), "SET 절에 close 없음");
  assert.ok(sql.includes("s.open IS NULL"));
  assert.ok(sql.includes("abs(v.c - s.close)"));
  assert.ok(!sql.includes("DROP"));
  assert.equal(buildOhlcvUpdateSql([]), null);
});

test("유틸: addDays/toIso/kstToday/isKrxSession", () => {
  assert.equal(addDays("20260930", 1), "20261001");
  assert.equal(addDays("20260301", -1), "20260228");
  assert.equal(toIso("20261001"), "2026-10-01");
  assert.equal(kstToday(Date.UTC(2026, 8, 30, 19, 0, 0)), "20261001"); // 04:00 KST
  assert.equal(isKrxSession(Date.UTC(2026, 9, 1, 2, 0, 0)), true);   // 11:00 KST 목
  assert.equal(isKrxSession(Date.UTC(2026, 9, 1, 7, 0, 0)), false);  // 16:00 KST
  assert.equal(isKrxSession(Date.UTC(2026, 9, 3, 2, 0, 0)), false);  // 토 11:00 KST
});
