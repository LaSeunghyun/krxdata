/**
 * upbit-api.js — 업비트 API 클라이언트
 *   Quotation(시세): 키 불필요. 캔들·마켓·현재가.
 *   Exchange(잔고·주문): JWT 인증 (UPBIT_ACCESS_KEY / UPBIT_SECRET_KEY in .env).
 *     ※ 원래 "엣지 실증 전 실거래 경로 미구현" 규율이었으나 2026-07-18 사용자 명시 지시로 구현.
 *       76개 검증 채택 0 상태에서의 실거래임을 사용자가 인지하고 결정함 (스펙 기록 참조).
 *
 *   레이트리밋: quotation 캔들 ~10 req/s → 125ms 페이싱 / exchange 주문 8 req/s·비주문 30 req/s.
 *   반환 정규화: { timestamp(KST ISO), open, high, low, close, volume, turnover(원) } 최신순.
 */
import crypto from "node:crypto";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FETCH_TIMEOUT_MS } from "./config.js";

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname2, ".env") });

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

// ── Exchange API (JWT 인증) ──────────────────────────────────
export function isUpbitTradingConfigured(env = process.env) {
  return Boolean(env.UPBIT_ACCESS_KEY && env.UPBIT_SECRET_KEY);
}

function upbitJwt(queryString) {
  const payload = { access_key: process.env.UPBIT_ACCESS_KEY, nonce: crypto.randomUUID() };
  if (queryString) {
    payload.query_hash = crypto.createHash("sha512").update(queryString, "utf8").digest("hex");
    payload.query_hash_alg = "SHA512";
  }
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = crypto.createHmac("sha256", process.env.UPBIT_SECRET_KEY).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

// 주문은 멱등하지 않음 — 429/5xx 자동 재시도 금지(toss-api와 동일 원칙), 실패는 즉시 throw.
async function exchangeReq(method, apiPath, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${UPBIT_BASE}${apiPath}${method !== "POST" && qs ? `?${qs}` : ""}`;
  await rateSlot();
  const res = await fetchT(url, {
    method,
    headers: {
      Authorization: `Bearer ${upbitJwt(qs)}`,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(params) } : {}),
  });
  if (!res.ok) throw new Error(`업비트 Exchange ${method} ${apiPath}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** 전체 잔고 — [{ currency, balance, locked, avg_buy_price, unit_currency }] */
export async function getUpbitAccounts() {
  return exchangeReq("GET", "/v1/accounts");
}

/** 주문 생성 — 시장가 매수: { market, side:'bid', ord_type:'price', price:<KRW금액> }
 *              시장가 매도: { market, side:'ask', ord_type:'market', volume:<수량> }
 *              지정가:      { market, side, ord_type:'limit', price, volume } */
export async function createUpbitOrder(params) {
  return exchangeReq("POST", "/v1/orders", params);
}

/** 개별 주문 조회 */
export async function getUpbitOrder(uuid) {
  return exchangeReq("GET", "/v1/order", { uuid });
}

/** 주문 취소 */
export async function cancelUpbitOrder(uuid) {
  return exchangeReq("DELETE", "/v1/order", { uuid });
}
