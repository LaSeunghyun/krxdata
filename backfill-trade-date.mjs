/**
 * backfill-trade-date.mjs - stock_prices 거래일·OHLCV 이력 백필 (1회성, 멱등, 추가 전용).
 *
 *   서브커맨드 (순서대로)
 *     fetch <cacheFile> [--bars 700] [--limit N]   토스 일봉을 JSONL 캐시로 저장 (VM 전용·IP 화이트리스트, 재개 가능)
 *                                                   KST 09:00~15:30 평일은 거부(--force-hours 로만 우회)
 *     calendar <cacheFile> [--dry-run]              기준 종목 일봉으로 trading_calendar 2023-01-01~어제 채움 + 교차 검증 리포트
 *     trade-date <cacheFile> [--dry-run]            적재일별 일봉 일치율로 거래일 매핑 후 stock_prices.trade_date 채움 (NULL 인 행만)
 *     ohlcv <cacheFile> [--dry-run]                 일봉 OHLCV 를 (stock_code, trade_date) 행에 채움 (NULL 칸만, close 불변)
 *
 *   불변 규칙: stock_prices.date·close 는 절대 수정하지 않는다. trade_date/open/high/low/volume/turnover 만 쓴다.
 *   캐시 형식(JSONL, 1행 1종목): {"code","d":["YYYYMMDD"..],"o":[],"h":[],"l":[],"c":[],"v":[]}  (오름차순)
 */
import dotenv from "dotenv";
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REF_STOCKS, calendarFromCandles, mapLoadDatesToTradeDates, ohlcvRows, buildOhlcvUpdateSql,
  addDays, toIso, toYmd, isKrxSession, kstToday, MAX_LOOKBACK, COPY_THRESHOLD,
} from "./trade-date.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const MGMT_KEY = process.env.SUPABASE_MANAGEMENT_KEY;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
const [cmd, cacheFile, ...rest] = process.argv.slice(2);
const flag = (n) => rest.includes(n);
const opt = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };
const DRY = flag("--dry-run");
const CAL_FROM = "20230101";

async function dbQuery(sql) {
  if (!MGMT_KEY || !PROJECT_REF) throw new Error("SUPABASE_MANAGEMENT_KEY/PROJECT_REF 미설정");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${MGMT_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(300_000),
    });
    const data = await res.json();
    if (Array.isArray(data)) return data;
    if (attempt < 3) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
    throw new Error(data?.message ?? "DB 쿼리 오류");
  }
}

async function loadCache(file, onlyCodes) {
  const map = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  for await (const line of rl) {
    if (!line) continue;
    const j = JSON.parse(line);
    if (onlyCodes && !onlyCodes.has(j.code)) continue;
    map.set(j.code, j);
  }
  return map;
}

// ── fetch ───────────────────────────────────────────────
async function cmdFetch() {
  if (isKrxSession() && !flag("--force-hours")) {
    console.error("[fetch] KST 09:00~15:30 장중 대량 호출 금지 - 장 마감 후 실행하세요.");
    process.exit(2);
  }
  const { isTossConfigured, getDailyCandles } = await import("./toss-api.js");
  if (!isTossConfigured()) { console.error("TOSS_CLIENT_ID/SECRET 미설정"); process.exit(1); }
  const bars = Number(opt("--bars", 700));
  const limit = Number(opt("--limit", 0));
  const done = new Set();
  if (fs.existsSync(cacheFile)) {
    const rl = readline.createInterface({ input: fs.createReadStream(cacheFile) });
    for await (const line of rl) { if (line) done.add(JSON.parse(line).code); }
  }
  let codes = (await dbQuery(`SELECT stock_code FROM stock_analysis WHERE current_price > 0 ORDER BY stock_code`)).map(r => r.stock_code);
  for (const r of REF_STOCKS) if (!codes.includes(r)) codes.unshift(r);
  codes = [...new Set([...REF_STOCKS, ...codes])];
  if (limit) codes = codes.slice(0, limit);
  const out = fs.createWriteStream(cacheFile, { flags: "a" });
  let n = 0, fail = 0;
  const t0 = Date.now();
  for (const code of codes) {
    if (done.has(code)) continue;
    if (isKrxSession() && !flag("--force-hours")) { console.error("[fetch] 장 시작 - 중단(재개 가능)"); break; }
    try {
      const total = REF_STOCKS.includes(code) ? 1500 : bars;
      const b = (await getDailyCandles(code, total)).slice().reverse(); // 오름차순
      out.write(JSON.stringify({
        code, d: b.map(x => toYmd(x.timestamp)), o: b.map(x => x.open), h: b.map(x => x.high),
        l: b.map(x => x.low), c: b.map(x => x.close), v: b.map(x => x.volume),
      }) + "\n");
    } catch (e) { fail++; console.error(`[fetch] ${code} 실패: ${String(e.message).slice(0, 80)}`); }
    n++;
    if (n % 200 === 0) console.log(`[fetch] ${n}/${codes.length - done.size} (${Math.round((Date.now() - t0) / 1000)}s, 실패 ${fail})`);
  }
  out.end();
  console.log(`[fetch] 완료 ${n}종목 (실패 ${fail}) -> ${cacheFile}`);
}

// ── calendar ────────────────────────────────────────────
async function cmdCalendar() {
  const cache = await loadCache(cacheFile, new Set(REF_STOCKS));
  const refBars = [...cache.values()].map(j => j.d.map((d, i) => ({ date: d, volume: j.v[i] })));
  if (!refBars.length) throw new Error("캐시에 기준 종목 없음");
  const yesterday = addDays(kstToday(), -1);
  const rows = calendarFromCandles(refBars, CAL_FROM, yesterday);
  const open = rows.filter(r => r.is_open).length;
  console.log(`[calendar] 생성 ${rows.length}행 (개장 ${open} / 휴장 ${rows.length - open}), 기준 종목 ${[...cache.keys()].join(",")}`);

  // 교차 검증: stock_prices 복사본 판정(전 종목 90% 초과가 직전 행과 동일, 적재일 평일) vs 일봉 판정
  const ratios = await dbQuery(`SELECT a.date, avg((a.close=b.close)::int)::float r FROM stock_prices a JOIN stock_prices b
    ON b.stock_code=a.stock_code AND b.date=to_char(to_date(a.date,'YYYYMMDD')-1,'YYYYMMDD') GROUP BY a.date`);
  const copyDates = new Set(ratios.filter(x => x.r > COPY_THRESHOLD).map(x => x.date));
  const calMap = new Map(rows.map(r => [toYmd(r.trade_date), r.is_open]));
  const disagree = [];
  // 2026-06-13 이전은 적재일 == 거래일 체제라 복사본 규칙(D-1 비교)의 의미가 달라 제외
  for (const D of copyDates) {
    if (D < "20260613") continue;
    const T = addDays(D, -1);
    const wk = calMap.get(T);
    if (wk === undefined || wk === false) continue; // 주말·휴장: 복사본이 정상
    disagree.push(`${D}(적재) 복사본인데 ${T} 은 일봉상 개장`);
  }
  const closedButFresh = [];
  for (const r of rows) {
    if (r.is_open || r.source === "weekend") continue;
    const D = addDays(toYmd(r.trade_date), 1);
    if (D >= "20260613" && D <= kstToday() && !copyDates.has(D) && ratios.some(x => x.date === D)) closedButFresh.push(`${r.trade_date} 휴장(일봉)인데 적재일 ${D} 은 복사본 아님`);
  }
  console.log(`[calendar] 교차검증 불일치 A (복사본 판정 vs 일봉 개장) ${disagree.length}건:`);
  for (const x of disagree) console.log("   " + x);
  console.log(`[calendar] 교차검증 불일치 B (일봉 휴장 vs 복사본 아님) ${closedButFresh.length}건:`);
  for (const x of closedButFresh) console.log("   " + x);

  if (DRY) { console.log("[calendar] dry-run - DB 미기록"); return; }
  const CH = 500;
  for (let i = 0; i < rows.length; i += CH) {
    const vals = rows.slice(i, i + CH).map(r => `('${r.trade_date}',${r.is_open},'${r.source}')`).join(",");
    await dbQuery(`INSERT INTO trading_calendar (trade_date, is_open, source) VALUES ${vals} ON CONFLICT (trade_date) DO NOTHING`);
  }
  const [c] = await dbQuery(`SELECT count(*)::int n, min(trade_date) mn, max(trade_date) mx FROM trading_calendar`);
  console.log(`[calendar] trading_calendar ${c.n}행 ${c.mn} ~ ${c.mx}`);
}

// ── trade-date ──────────────────────────────────────────
async function loadDbCloses() {
  const dates = (await dbQuery(`SELECT DISTINCT date FROM stock_prices ORDER BY date`)).map(r => r.date);
  const byDate = new Map();
  for (let i = 0; i < dates.length; i += 12) {
    const from = dates[i], to = dates[Math.min(i + 11, dates.length - 1)];
    const rows = await dbQuery(`SELECT stock_code, date, close FROM stock_prices WHERE date >= '${from}' AND date <= '${to}'`);
    for (const r of rows) {
      let m = byDate.get(r.date);
      if (!m) byDate.set(r.date, (m = new Map()));
      m.set(r.stock_code, Number(r.close));
    }
  }
  return byDate;
}

async function cmdTradeDate() {
  const cache = await loadCache(cacheFile);
  const candle = new Map(); // code -> Map(date -> close)
  for (const [code, j] of cache) candle.set(code, new Map(j.d.map((d, i) => [d, j.c[i]])));
  const calRows = await dbQuery(`SELECT to_char(trade_date,'YYYYMMDD') d, is_open FROM trading_calendar`);
  const calendar = new Map(calRows.map(r => [r.d, r.is_open]));
  if (!calendar.size) throw new Error("trading_calendar 비어 있음 - calendar 먼저 실행");
  const byDate = await loadDbCloses();

  const entries = [];
  for (const [D, rows] of byDate) {
    const shares = {};
    for (let k = 0; k <= MAX_LOOKBACK; k++) {
      const T = addDays(D, -k);
      let hit = 0, n = 0;
      for (const [code, close] of rows) {
        const cm = candle.get(code);
        if (!cm || !cm.has(T)) continue;
        n++; if (cm.get(T) === close) hit++;
      }
      shares[T] = n ? hit / n : 0;
    }
    entries.push({ date: D, shares });
  }
  const mapping = mapLoadDatesToTradeDates(entries, calendar);
  const stat = { matched: 0, duplicate_copy: 0, low_match: 0 };
  const offsets = {};
  for (const [D, v] of mapping) {
    stat[v.reason]++;
    if (v.trade) { const k = Math.round((Date.parse(toIso(D)) - Date.parse(toIso(v.trade))) / 86400000); offsets[k] = (offsets[k] ?? 0) + 1; }
  }
  console.log(`[trade-date] 적재일 ${mapping.size}개: 매핑 ${stat.matched} / 중복복사본 NULL ${stat.duplicate_copy} / 일치율 미달 NULL ${stat.low_match}`);
  console.log(`[trade-date] 적재일 - 거래일 오프셋 분포: ${JSON.stringify(offsets)}`);
  const low = [...mapping].filter(([, v]) => v.reason === "low_match").map(([d, v]) => `${d}(${v.share.toFixed(2)})`);
  console.log(`[trade-date] 일치율 미달(NULL 유지) 적재일: ${low.join(" ") || "없음"}`);
  const lost = [...calendar].filter(([d, o]) => o && d >= [...mapping.keys()][0] && d <= addDays(kstToday(), -1) && ![...mapping.values()].some(v => v.trade === d)).map(([d]) => d);
  console.log(`[trade-date] 개장일인데 유효 행이 없는 거래일 ${lost.length}건: ${lost.join(" ")}`);

  if (DRY) { console.log("[trade-date] dry-run - DB 미기록"); return; }
  const pairs = [...mapping].filter(([, v]) => v.trade).map(([d, v]) => [d, v.trade]);
  for (let i = 0; i < pairs.length; i += 20) {
    const vals = pairs.slice(i, i + 20).map(([d, t]) => `('${d}','${toIso(t)}'::date)`).join(",");
    await dbQuery(`UPDATE stock_prices s SET trade_date = m.t FROM (VALUES ${vals}) AS m(d,t) WHERE s.date = m.d AND s.trade_date IS NULL`);
  }
  console.log(`[trade-date] 갱신 완료 (${pairs.length}개 적재일)`);
}

// ── ohlcv ───────────────────────────────────────────────
async function cmdOhlcv() {
  const cache = await loadCache(cacheFile);
  const today = kstToday();
  let total = 0, filled = 0, batches = 0;
  let buf = [];
  const flush = async () => {
    if (!buf.length) return;
    const sql = buildOhlcvUpdateSql(buf);
    if (sql && !DRY) { const [r] = await dbQuery(sql); filled += r?.n ?? 0; }
    batches++;
    buf = [];
  };
  for (const [code, j] of cache) {
    const bars = j.d.map((d, i) => ({ date: d, open: j.o[i], high: j.h[i], low: j.l[i], close: j.c[i], volume: j.v[i] }));
    for (const r of ohlcvRows(code, bars, today)) {
      buf.push(r); total++;
      if (buf.length >= 2000) { await flush(); if (batches % 50 === 0) console.log(`[ohlcv] 후보 ${total} / 채움 ${filled}`); }
    }
  }
  await flush();
  console.log(`[ohlcv] 후보 ${total}행 중 채움 ${filled}행 ${DRY ? "(dry-run, 미기록)" : ""}`);
}

const cmds = { fetch: cmdFetch, calendar: cmdCalendar, "trade-date": cmdTradeDate, ohlcv: cmdOhlcv };
if (!cmds[cmd] || !cacheFile) {
  console.error("usage: node backfill-trade-date.mjs {fetch|calendar|trade-date|ohlcv} <cacheFile> [--dry-run]");
  process.exit(1);
}
await cmds[cmd]();
