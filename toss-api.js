/**
 * toss-api.js — 토스증권 Open API 클라이언트 (시세 조회 전용)
 *   OAuth2 client_credentials 토큰 캐시 + MARKET_DATA 10 TPS 페이싱 + 429 Retry-After 재시도.
 *   현재가/종목정보는 200종목 일괄, 일봉은 종목당 최대 200봉 페이지네이션(수정주가).
 *
 * env: TOSS_CLIENT_ID, TOSS_CLIENT_SECRET (WTS 설정 > Open API에서 발급)
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FETCH_TIMEOUT_MS } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const TOSS_BASE = "https://openapi.tossinvest.com";

export function isTossConfigured(env = process.env) {
  return Boolean(env.TOSS_CLIENT_ID && env.TOSS_CLIENT_SECRET);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchT(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
}

let token = null;        // { value, expiresAt }
let tokenInflight = null; // 동시 호출이 토큰 POST를 중복 발급하지 않도록 단일화
async function getToken() {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  tokenInflight ??= issueToken().finally(() => { tokenInflight = null; });
  return tokenInflight;
}

async function issueToken() {
  // 공식 문서: POST /oauth2/token, grant_type=client_credentials, -u 'ID:SECRET' (HTTP Basic Auth)
  const basic = Buffer.from(`${process.env.TOSS_CLIENT_ID}:${process.env.TOSS_CLIENT_SECRET}`).toString("base64");
  const res = await fetchT(`${TOSS_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`토스 토큰 발급 실패: ${res.status} ${await res.text()}`);
  const data = await res.json();
  token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return token.value;
}

// MARKET_DATA 그룹 10 TPS 제한 — 전역 슬롯을 105ms 간격으로 배정해 동시성과 무관하게 페이싱
let nextSlot = 0;
async function rateSlot() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 105;
  if (wait > 0) await sleep(wait);
}

async function tossGet(apiPath, params = {}, extraHeaders = {}) {
  const url = new URL(`${TOSS_BASE}${apiPath}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  let refreshed = false; // 401 재발급은 429/5xx 재시도 예산과 별도 카운트
  for (let attempt = 0; ; attempt++) {
    await rateSlot();
    const res = await fetchT(url.toString(), {
      headers: { Authorization: `Bearer ${await getToken()}`, ...extraHeaders },
    });
    if (res.ok) return (await res.json())?.result;
    if (res.status === 401 && !refreshed) { token = null; refreshed = true; attempt--; continue; }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
      await sleep(retryAfter * 1000 + Math.random() * 300); // 문서 권장: 지수 백오프 + jitter
      continue;
    }
    throw new Error(`토스 API ${apiPath}: ${res.status} ${await res.text()}`);
  }
}

// 주문/취소는 멱등하지 않아 자동 재시도 금지 — 실패는 즉시 throw하고 호출부가 판단
async function tossPost(apiPath, body = {}, extraHeaders = {}) {
  await rateSlot();
  const res = await fetchT(`${TOSS_BASE}${apiPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`토스 API ${apiPath}: ${res.status} ${await res.text()}`);
  return (await res.json())?.result;
}

function accountHeader(accountSeq) {
  return { "X-Tossinvest-Account": String(accountSeq) };
}

/** 계좌 목록 — X-Tossinvest-Account 헤더에는 accountSeq 사용 */
export async function getAccounts() {
  return (await tossGet("/api/v1/accounts")) ?? [];
}

/** 국내 장 운영 캘린더 — 휴장일이면 해당 일자 integrated가 null */
export async function getKrMarketCalendar(date) {
  return tossGet("/api/v1/market-calendar/KR", date ? { date } : {});
}

/** 종목 경고 조회 — 투자경고·단기과열·정리매매 등 [{ warningType, exchange, startDate, endDate }] */
export async function getStockWarnings(symbol) {
  return (await tossGet(`/api/v1/stocks/${symbol}/warnings`)) ?? [];
}

/** 주문 생성 — body: { symbol, side: BUY|SELL, orderType: LIMIT|MARKET, quantity, price? } */
export async function createOrder(accountSeq, body) {
  return tossPost("/api/v1/orders", body, accountHeader(accountSeq));
}

export async function cancelOrder(accountSeq, orderId) {
  return tossPost(`/api/v1/orders/${orderId}/cancel`, {}, accountHeader(accountSeq));
}

/** 주문 상태 — status: PENDING|PARTIAL_FILLED|FILLED|CANCELED|REJECTED 등 */
export async function getOrder(accountSeq, orderId) {
  return tossGet(`/api/v1/orders/${orderId}`, {}, accountHeader(accountSeq));
}

export async function getBuyingPower(accountSeq, params = {}) {
  return tossGet("/api/v1/buying-power", params, accountHeader(accountSeq));
}

/** 보유 주식 조회 */
export async function getHoldings(accountSeq) {
  return tossGet("/api/v1/holdings", {}, accountHeader(accountSeq));
}

/** 호가 조회 — { timestamp, asks:[{price,volume}], bids:[{price,volume}] } (KRX+NXT 통합) */
export async function getOrderbook(symbol) {
  return tossGet("/api/v1/orderbook", { symbol });
}

/** 최근 체결 조회 — [{ price, volume, timestamp }] 최신순 (KRX+NXT 통합) */
export async function getTrades(symbol) {
  return (await tossGet("/api/v1/trades", { symbol })) ?? [];
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 현재가 일괄 조회 — Map(symbol → { price, timestamp }) */
export async function getPricesMap(symbols) {
  const map = new Map();
  for (const part of chunk(symbols, 200)) {
    const rows = (await tossGet("/api/v1/prices", { symbols: part.join(",") })) ?? [];
    for (const r of rows) map.set(r.symbol, { price: Number(r.lastPrice), timestamp: r.timestamp });
  }
  return map;
}

/** 종목 기본 정보 일괄 조회 — Map(symbol → { sharesOutstanding }) — 시총 = 발행주식수 × 현재가 */
export async function getStocksMap(symbols) {
  const map = new Map();
  for (const part of chunk(symbols, 200)) {
    const rows = (await tossGet("/api/v1/stocks", { symbols: part.join(",") })) ?? [];
    for (const r of rows) map.set(r.symbol, { sharesOutstanding: Number(r.sharesOutstanding) });
  }
  return map;
}

/** 1분봉 조회 — 최신순. before(ISO 8601)로 과거 시점 페이지네이션 가능 */
export async function getCandles1m(symbol, total = 30, before = null) {
  return getCandlesPaged(symbol, "1m", total, before);
}

/** 일봉 조회(수정주가) — 최신순 [{ timestamp, open, high, low, close, volume }] */
export async function getDailyCandles(symbol, total = 252) {
  return getCandlesPaged(symbol, "1d", total, null);
}

async function getCandlesPaged(symbol, interval, total, before) {
  const candles = [];
  while (candles.length < total) {
    const r = await tossGet("/api/v1/candles", {
      symbol,
      interval,
      count: Math.min(200, total - candles.length),
      before,
    });
    const page = r?.candles ?? [];
    if (!page.length) break;
    candles.push(...page);
    if (!r.nextBefore) break;
    before = r.nextBefore;
  }
  return candles
    .map((c) => ({
      timestamp: c.timestamp,
      open: Number(c.openPrice),
      high: Number(c.highPrice),
      low: Number(c.lowPrice),
      close: Number(c.closePrice),
      volume: Number(c.volume),
    }))
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, total);
}
