/**
 * forecast-intraday.mjs — 1분봉 기반 장중 구간·NXT 세션 합성 계산 (Phase 2·3)
 *
 * 실측 사실 (2026-07-21 프로브):
 *  - 토스 1분봉은 종목의 경우 KRX 정규장 + NXT 프리마켓(08:00~08:50) + NXT 애프터(15:30~20:00) 통합
 *  - ETF(069500 등)는 KRX 정규장(09:00~15:30)만 존재
 *  - 이력 깊이: 200개/페이지 페이징, ETF 8,000개 ≈ 20거래일 / 종목은 하루 ~710분봉이라 동일 총량 시 ~11일
 *
 * NXT 합성 바스켓은 "NXT 대상종목 합성시장"이며 공식 KOSPI/KOSDAQ 지수가 아니다.
 * 유효 체결 종목 수와 시총 커버리지를 항상 함께 계산한다 (커버리지 낮으면 평가 보류).
 */
import { getCandles1m } from './toss-api.js';

export const NXT_PRE = { start: '0800', end: '0850' };
export const NXT_AFTER = { start: '1530', end: '2000' };

const hmOf = (ts) => String(ts).slice(11, 16).replace(':', '');
const dateOf = (ts) => String(ts).slice(0, 10).replace(/-/g, '');

/** 1분봉 배열(순서 무관) → Map<dateKey, [{hm, close}]> (hm 오름차순) */
export function groupByDate(candles) {
  const by = new Map();
  for (const c of candles) {
    if (!(c.close > 0)) continue;
    const d = dateOf(c.timestamp);
    if (!by.has(d)) by.set(d, []);
    by.get(d).push({ hm: hmOf(c.timestamp), close: c.close });
  }
  for (const arr of by.values()) arr.sort((a, b) => (a.hm < b.hm ? -1 : 1));
  return by;
}

/** 해당 시각 이전(포함) 마지막 체결가 */
export function priceAt(dayBars, hm) {
  if (!dayBars?.length) return null;
  let best = null;
  for (const b of dayBars) { if (b.hm <= hm) best = b.close; else break; }
  return best;
}

export function lastBarHm(dayBars) {
  return dayBars?.length ? dayBars[dayBars.length - 1].hm : null;
}

/**
 * 구간 수익률(%) — 완결 확인: 세션 종료 시각 이후 봉이 있거나 과거 날짜여야 한다.
 * (미완결 구간을 완결로 채점하면 원장이 오염된다 — 일봉과 동일 원칙)
 */
export function intervalReturn(dayBars, startHm, endHm, { dateIsPast = false } = {}) {
  if (!dayBars?.length) return null;
  if (!dateIsPast && lastBarHm(dayBars) < endHm) return null;
  const s = priceAt(dayBars, startHm);
  const e = priceAt(dayBars, endHm);
  if (!s || !e) return null;
  // 시작 시각 이전에 체결이 없으면(세션 미개시) 구간 수익률이 성립하지 않는다
  if (dayBars[0].hm > startHm && dayBars[0].hm > endHm) return null;
  return (e / s - 1) * 100;
}

/** 과거 날짜들의 동일 구간 수익률 이력 (오름차순, 대상일 제외) */
export function historyIntervalReturns(byDate, startHm, endHm, { excludeDate, todayKey } = {}) {
  const out = [];
  const dates = [...byDate.keys()].sort();
  for (const d of dates) {
    if (d === excludeDate) continue;
    const r = intervalReturn(byDate.get(d), startHm, endHm, { dateIsPast: todayKey ? d < todayKey : true });
    if (r != null) out.push(r);
  }
  return out;
}

/**
 * 시총가중 바스켓 세션 수익률 시계열
 * @param byDateBySymbol {code: Map<date, bars>}
 * @param weights {code: 시총}
 * @returns [{date, ret, n, coverage}] — n=유효 체결 종목 수, coverage=유효 종목 시총 비중
 */
export function basketSessionSeries(byDateBySymbol, weights, startHm, endHm, { todayKey } = {}) {
  const totalW = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const allDates = new Set();
  for (const m of Object.values(byDateBySymbol)) for (const d of m.keys()) allDates.add(d);
  const out = [];
  for (const d of [...allDates].sort()) {
    let wSum = 0, wRet = 0, n = 0;
    for (const [code, m] of Object.entries(byDateBySymbol)) {
      const r = intervalReturn(m.get(d), startHm, endHm, { dateIsPast: todayKey ? d < todayKey : true });
      if (r == null) continue;
      const w = weights[code] ?? 0;
      wSum += w; wRet += r * w; n += 1;
    }
    if (n > 0 && wSum > 0) {
      out.push({ date: d, ret: wRet / wSum, n, coverage: Math.round((wSum / totalW) * 100) / 100 });
    }
  }
  return out;
}

/** 진행 중 세션의 현재까지 변화율 (관측용 — 채점 금지) */
export function basketLiveMove(byDateBySymbol, weights, baseHm, dateKey, { baseDate } = {}) {
  const totalW = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  let wSum = 0, wRet = 0, n = 0;
  for (const [code, m] of Object.entries(byDateBySymbol)) {
    const base = priceAt(m.get(baseDate ?? dateKey), baseHm);
    const bars = m.get(dateKey);
    const now = bars?.length ? bars[bars.length - 1].close : null;
    if (!base || !now) continue;
    const w = weights[code] ?? 0;
    wSum += w; wRet += ((now / base - 1) * 100) * w; n += 1;
  }
  if (!n || !wSum) return null;
  return { ret: Math.round((wRet / wSum) * 100) / 100, n, coverage: Math.round((wSum / totalW) * 100) / 100 };
}

/**
 * 적재일(stamp) 기준 시계열 → 실거래일 기준 재라벨링
 *
 * stock_prices.date는 "적재일"이고 close는 "직전 거래일 종가"다 (04:00 배치 실측, 2026-07-21):
 *  - stamp D 행의 값 = D 이전 마지막 거래일의 종가 → 진짜 날짜 = max(거래일 < D)
 *  - 주말·휴일 stamp는 직전 값의 중복(가짜 0% 수익률) → 같은 진짜 날짜로 매핑되므로 첫 stamp만 유지
 * 재라벨 없이 쓰면 검증이 하루 이른 수익률로 오채점되고 분포에 0%가 섞인다.
 *
 * @param items [{date: stampKey, ...}] 오름차순
 * @param tradingDates 실거래일 키 배열 (ETF 일봉 날짜, 오름차순)
 * @returns [{...item, date: 실거래일}] — 매핑 불가·중복 stamp 제거
 */
export function relabelStampsToTradingDays(items, tradingDates) {
  if (!tradingDates?.length) return [];
  const out = [];
  const used = new Set();
  for (const item of items) {
    let trueDate = null;
    for (let i = tradingDates.length - 1; i >= 0; i--) {
      if (tradingDates[i] < item.date) { trueDate = tradingDates[i]; break; }
    }
    if (!trueDate || used.has(trueDate)) continue;
    used.add(trueDate);
    out.push({ ...item, date: trueDate });
  }
  return out;
}

/** 1분봉 수집 → Map<date, bars>. 일시 오류 1회 재시도, 최종 실패 시 빈 Map (호출부가 품질 강등) */
export async function fetch1mByDate(code, total) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return groupByDate(await getCandles1m(code, total));
    } catch {
      if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
    }
  }
  return new Map();
}

export async function fetchBasket1m(codes, total) {
  const out = {};
  for (const code of codes) out[code] = await fetch1mByDate(code, total);
  return out;
}
