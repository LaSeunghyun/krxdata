/**
 * trade-date.mjs - stock_prices 거래일(trade_date)·거래 캘린더 판정 순수 함수 모음.
 *   save-prices.mjs(일 크론) / backfill-trade-date.mjs(1회성 백필) / tests 가 공유한다. 부작용(DB·네트워크) 없음.
 *
 *   배경(2026-10-01 실측)
 *   - stock_prices.date 는 "적재일"이다. 2026-06-13(토) 이후엔 04:00 KST 크론이 전날 종가를 그날 날짜로 넣는다
 *     (date=20261001 행 = 9/30 종가). 주말·휴장 다음날 행은 직전 행의 복사본이다.
 *   - 그 이전(2025-05-29 ~ 2026-06-12)은 장 마감 후 적재라 date == 거래일이었다 (3종목 x 243일 오프셋 0 일치).
 *     따라서 "trade_date = date - 1" 단일 규칙은 틀리고, 일자별로 토스 일봉과 대조해 거래일을 정한다.
 */

export const REF_STOCKS = ["005930", "000660", "035420", "005380", "051910"]; // 휴장 판정 기준 대형주(합집합)
export const COPY_THRESHOLD = 0.9; // 전 종목 90% 초과가 직전 행과 같으면 휴장/정체 복사본
export const MIN_MATCH_SHARE = 0.5; // 일봉 대조 최소 일치율 (KRX/토스 종가 차이로 정상일도 ~0.75)
export const MAX_LOOKBACK = 6; // 적재일 D 기준 거래일 후보 창 (D-0 ~ D-6)
export const CLOSE_TOLERANCE = 0.01; // OHLCV 채움 시 일봉 종가 vs DB 종가 허용 오차(분할·수정주가 방어)

const DAY = 86400000;

/** 'YYYYMMDD' 또는 'YYYY-MM-DD' -> 'YYYYMMDD' */
export function toYmd(s) {
  return String(s).slice(0, 10).replace(/-/g, "");
}
/** 'YYYYMMDD' -> 'YYYY-MM-DD' */
export function toIso(ymd) {
  const y = toYmd(ymd);
  return `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;
}
function toDate(ymd) {
  const y = toYmd(ymd);
  return new Date(Date.UTC(+y.slice(0, 4), +y.slice(4, 6) - 1, +y.slice(6, 8)));
}
function fromDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
export function addDays(ymd, n) {
  return fromDate(new Date(toDate(ymd).getTime() + n * DAY));
}
export function isWeekend(ymd) {
  const dow = toDate(ymd).getUTCDay();
  return dow === 0 || dow === 6;
}
/** KST 기준 오늘 YYYYMMDD */
export function kstToday(now = Date.now()) {
  return fromDate(new Date(now + 9 * 3600 * 1000));
}
/** KST 09:00~15:30 (장중, 평일) 여부 - 대량 호출 금지 구간 */
export function isKrxSession(now = Date.now()) {
  const k = new Date(now + 9 * 3600 * 1000);
  const dow = k.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const m = k.getUTCHours() * 60 + k.getUTCMinutes();
  return m >= 9 * 60 && m < 15 * 60 + 30;
}

/**
 * 기준 종목 일봉으로 캘린더 행 생성.
 * @param {Array<Array<{date:string, volume:number}>>} refBarsList 종목별 일봉 (date: YYYYMMDD|ISO)
 * @param {string} fromYmd 포함 시작일
 * @param {string} toYmd_ 포함 종료일
 * @returns {Array<{trade_date:string(ISO), is_open:boolean, source:string}>}
 *   주말 = 휴장('weekend'). 평일 = 기준 종목 중 하나라도 거래량>0 봉이 있으면 개장('toss_candle'), 없으면 휴장('toss_no_candle').
 *   기준 일봉이 덮지 못하는 구간(가장 늦게 시작하는 시리즈의 시작일 이전)은 판정 불가이므로 평일 행을 만들지 않는다.
 */
export function calendarFromCandles(refBarsList, fromYmd, toYmd_) {
  const openSet = new Set();
  let coverFrom = "00000000";
  for (const bars of refBarsList) {
    if (!bars?.length) continue;
    let mn = "99999999";
    for (const b of bars) {
      const d = toYmd(b.date);
      if (d < mn) mn = d;
      if (Number(b.volume) > 0) openSet.add(d);
    }
    if (mn > coverFrom) coverFrom = mn;
  }
  const out = [];
  for (let d = toYmd(fromYmd); d <= toYmd(toYmd_); d = addDays(d, 1)) {
    if (isWeekend(d)) out.push({ trade_date: toIso(d), is_open: false, source: "weekend" });
    else if (d < coverFrom) continue;
    else if (openSet.has(d)) out.push({ trade_date: toIso(d), is_open: true, source: "toss_candle" });
    else out.push({ trade_date: toIso(d), is_open: false, source: "toss_no_candle" });
  }
  return out;
}

/**
 * 적재일 loadYmd 보다 "앞선" 마지막 개장일. calendar: Map<YYYYMMDD, boolean>.
 * 캘린더에 없는 날짜는 주말 아니면 개장으로 간주(휴장은 복사본 판정이 따로 걸러준다).
 */
export function prevOpenDay(calendar, loadYmd) {
  for (let i = 1; i <= 21; i++) {
    const d = addDays(loadYmd, -i);
    const known = calendar?.get(d);
    if (known === true) return d;
    if (known === undefined && !isWeekend(d)) return d;
  }
  return null;
}

/** 직전 행과 같은 종가 비율이 임계 초과면 복사본(휴장·정체) */
export function isCopyDay(sameShare, threshold = COPY_THRESHOLD) {
  return Number.isFinite(sameShare) && sameShare > threshold;
}

/**
 * 일 크론 신규 행의 trade_date 결정.
 *  - 복사본(휴장 다음날·정체) = null
 *  - 후보(직전 개장일)가 이미 다른 적재일 행에 배정돼 있으면 null (중복 거래일 방지)
 * @param {{loadYmd:string, calendar:Map<string,boolean>, claimed:Set<string>, sameShare:number}} p
 * @returns {string|null} YYYYMMDD
 */
export function decideTradeDate({ loadYmd, calendar, claimed, sameShare }) {
  if (isCopyDay(sameShare)) return null;
  const t = prevOpenDay(calendar, loadYmd);
  if (!t) return null;
  if (claimed?.has(t)) return null;
  return t;
}

/**
 * 1회성 이력 매핑: 적재일 -> 거래일. 일자별 "DB 종가 == 후보일 일봉 종가" 일치율로 거래일을 고른다.
 *  - 후보 = D-0 ~ D-6 중 개장일. 최대 일치율 >= minShare 인 후보 채택.
 *  - 오름차순으로 훑으며 같은 거래일을 이미 앞선 적재일이 차지했으면 null (복사본/중복).
 * @param {Array<{date:string, shares:Record<string, number>}>} entries shares: 후보 거래일(YYYYMMDD) -> 일치율
 * @param {Map<string,boolean>} calendar
 * @returns {Map<string, {trade:string|null, reason:string, share:number}>} 키 = 적재일(YYYYMMDD)
 */
export function mapLoadDatesToTradeDates(entries, calendar, minShare = MIN_MATCH_SHARE) {
  const claimed = new Set();
  const out = new Map();
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  for (const e of sorted) {
    let best = null;
    for (const [t, share] of Object.entries(e.shares)) {
      const isOpen = calendar.get(t) ?? !isWeekend(t);
      if (!isOpen || t > e.date) continue;
      if (!best || share > best.share || (share === best.share && t > best.t)) best = { t, share };
    }
    if (!best || best.share < minShare) {
      out.set(e.date, { trade: null, reason: "low_match", share: best?.share ?? 0 });
      continue;
    }
    if (claimed.has(best.t)) {
      out.set(e.date, { trade: null, reason: "duplicate_copy", share: best.share });
      continue;
    }
    claimed.add(best.t);
    out.set(e.date, { trade: best.t, reason: "matched", share: best.share });
  }
  return out;
}

/**
 * 일봉 -> OHLCV 채움 후보. 오늘(미완성 봉)·종가 없는 봉 제외.
 * turnover = close x volume (daily-ranking.js 와 같은 관례. 토스 일봉에 거래대금 필드 없음)
 * @returns {Array<{code,trade,open,high,low,close,volume,turnover}>} trade = YYYYMMDD
 */
export function ohlcvRows(code, bars, todayYmd) {
  const rows = [];
  for (const b of bars) {
    const trade = toYmd(b.timestamp ?? b.date);
    if (!(trade < todayYmd)) continue;
    const { open, high, low, close, volume } = b;
    if (![open, high, low, close, volume].every(Number.isFinite) || !(close > 0) || volume < 0) continue;
    rows.push({ code, trade, open, high, low, close, volume, turnover: Math.round(close * volume) });
  }
  return rows;
}

/** OHLCV 채움 UPDATE SQL (NULL 인 칸만, 종가 오차 이내일 때만, close 는 건드리지 않음). 결과: [{n: 갱신 행 수}] */
export function buildOhlcvUpdateSql(rows) {
  const vals = rows
    .filter(r => /^[A-Za-z0-9]{5,6}$/.test(r.code) && /^\d{8}$/.test(r.trade))
    .map(r => `('${r.code}','${toIso(r.trade)}'::date,${r.open},${r.high},${r.low},${r.close},${r.volume},${r.turnover})`)
    .join(",");
  if (!vals) return null;
  return `WITH u AS (UPDATE stock_prices s SET open=v.o, high=v.h, low=v.l, volume=v.vol, turnover=v.tv
FROM (VALUES ${vals}) AS v(code,td,o,h,l,c,vol,tv)
WHERE s.stock_code=v.code AND s.trade_date=v.td AND s.open IS NULL
  AND abs(v.c - s.close) <= s.close * ${CLOSE_TOLERANCE}
  RETURNING 1) SELECT count(*)::int AS n FROM u`;
}
