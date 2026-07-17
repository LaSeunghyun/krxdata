/**
 * upbit-api.js — 업비트 공개(Quotation) API 클라이언트 (시세 조회 전용, 키 불필요)
 *   캔들·마켓·현재가만 구현. 인증 API(주문·잔고)는 의도적 미구현 —
 *   백테스트로 엣지가 실증되기 전까지 코인 실거래 경로를 만들지 않는다 (PLAN-100M.md 규율).
 *
 *   레이트리밋: quotation 캔들 그룹 ~10 req/s per IP → 125ms 슬롯 페이싱 + 429 백오프.
 *   반환 정규화: { timestamp(KST ISO), open, high, low, close, volume, turnover(원) } 최신순.
 */
import { FETCH_TIMEOUT_MS } from "./config.js";

const UPBIT_BASE = "https://api.upbit.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchT(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
}

// 캔들 그룹 10 req/s 제한 — 전역 슬롯 125ms 간격 (toss-api.js rateSlot과 동일 패턴)
let nextSlot = 0;
async function rateSlot() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 125;
  if (wait > 0) await sleep(wait);
}

async function upbitGet(apiPath, params = {}) {
  const url = new URL(`${UPBIT_BASE}${apiPath}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; ; attempt++) {
    await rateSlot();
    const res = await fetchT(url.toString(), { headers: { Accept: "application/json" } });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(1000 * 2 ** attempt + Math.random() * 300);
      continue;
    }
    throw new Error(`업비트 API ${apiPath}: ${res.status} ${await res.text()}`);
  }
}

/** KRW 마켓 목록 — [{ market, korean_name, english_name, warning }] (유의종목 플래그 포함) */
export async function getKrwMarkets() {
  const all = await upbitGet("/v1/market/all", { is_details: true });
  return all
    .filter((m) => m.market.startsWith("KRW-"))
    .map((m) => ({
      market: m.market,
      korean_name: m.korean_name,
      english_name: m.english_name,
      warning: m.market_event?.warning === true,
    }));
}

/** 현재가 일괄 — Map(market → { price, timestamp }) */
export async function getTickers(markets) {
  const map = new Map();
  const rows = await upbitGet("/v1/ticker", { markets: markets.join(",") });
  for (const r of rows) map.set(r.market, { price: Number(r.trade_price), timestamp: r.trade_timestamp });
  return map;
}

function normCandle(c) {
  return {
    timestamp: c.candle_date_time_kst,
    open: Number(c.opening_price),
    high: Number(c.high_price),
    low: Number(c.low_price),
    close: Number(c.trade_price),
    volume: Number(c.candle_acc_trade_volume),
    turnover: Number(c.candle_acc_trade_price), // 원화 거래대금 — 유동성 필터에 바로 사용
  };
}

async function getCandlesPaged(apiPath, market, total, to) {
  const candles = [];
  while (candles.length < total) {
    const page = await upbitGet(apiPath, {
      market,
      count: Math.min(200, total - candles.length),
      to, // ISO8601, 이 시각 이전 캔들 반환 (exclusive)
    });
    if (!page.length) break;
    candles.push(...page.map(normCandle));
    if (page.length < Math.min(200, total)) break;
    to = page[page.length - 1].candle_date_time_utc;
  }
  return candles.slice(0, total); // 최신순 유지 (toss getDailyCandles와 동일 방향)
}

/** 일봉 — 최신순 [{ timestamp, open, high, low, close, volume, turnover }] */
export async function getDailyCandles(market, total = 200, to = null) {
  return getCandlesPaged("/v1/candles/days", market, total, to);
}

/** 분봉 — unit ∈ {1,3,5,15,10,30,60,240} */
export async function getMinuteCandles(market, unit = 60, total = 200, to = null) {
  return getCandlesPaged(`/v1/candles/minutes/${unit}`, market, total, to);
}
