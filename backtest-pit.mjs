/**
 * backtest-pit.mjs — Point-in-Time 백테스트 (look-ahead 제거)
 *
 * 과거 3개월 일별시세를 받아와, 각 리밸런스 시점 T에서
 *   - 가치/품질/성장: stock_financials(연간 2025, ~3월 공시라 4~5월 어느 T든 PIT 안전)
 *   - 가격모멘텀/추세: 받아온 시세를 T 시점까지만 사용 (미래 미사용)
 * 로 섹터중립 z-score 합성점수를 만들고, 20·60 영업일 포워드 수익률과
 * spearman IC / 분위 스프레드 / top분위 hit rate를 산출한다.
 *
 * 모든 위험 수학은 순수함수(normalize.js / backtest.js)에 격리, 골든테스트로 검증됨.
 * 캐시: 시세는 backtest-cache-<begin>-<end>.json 에 저장 → 재실행 시 재수집 생략.
 *
 * 실행:  node backtest-pit.mjs            (캐시 있으면 사용)
 *        node backtest-pit.mjs --refresh  (시세 강제 재수집)
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sectorZScores } from "./normalize.js";
import { spearmanIC, quantileSpread } from "./backtest.js";
import { FACTOR_WEIGHTS } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PUBLIC_KEY = process.env.PUBLIC_DATA_API_KEY;
const PUBLIC_BASE =
  "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE 미설정"); process.exit(1); }
if (!PUBLIC_KEY) { console.error("PUBLIC_DATA_API_KEY 미설정"); process.exit(1); }

const REFRESH = process.argv.includes("--refresh");

// ── 설정 ──────────────────────────────────────────────────────
const LOOKBACK_DAYS = 90;          // 과거 시세 범위(달력일)
const HORIZONS = [20, 60];         // 포워드 수익 영업일
const MOM_LOOKBACKS = [20, 60];    // 모멘텀 영업일
const SMA_WINDOW = 20;             // 추세용 이동평균
const REBALANCE_STEP = 5;          // 리밸런스 간격(영업일) = 주간
const QUANTILE = 0.2;              // 상·하위 분위
const FETCH_DELAY_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const today = () => ymd(new Date());
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };

const BEGIN = daysAgo(LOOKBACK_DAYS);
const END = today();
const CACHE_FILE = path.join(__dirname, `backtest-cache-${BEGIN}-${END}.json`);

// ── Supabase REST ─────────────────────────────────────────────
async function dbSelect(table, query) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error(`${table} HTTP ${r.status}`);
  return r.json();
}

async function loadUniverse() {
  // 페이지네이션으로 전 종목 (sector/mrkt_ctg)
  const all = [];
  const PAGE = 1000;
  for (let off = 0; ; off += PAGE) {
    const rows = await dbSelect(
      "stock_analysis",
      `select=stock_code,corp_name,sector,mrkt_ctg&order=stock_code&limit=${PAGE}&offset=${off}`,
    );
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  // 재무(2025) 맵
  const fins = [];
  for (let off = 0; ; off += PAGE) {
    const rows = await dbSelect(
      "stock_financials",
      `select=stock_code,per,pbr,roe,debt_ratio,cur_ratio,cf_ops,revenue_yoy,op_income_yoy&analysis_year=eq.2025&order=stock_code&limit=${PAGE}&offset=${off}`,
    );
    fins.push(...rows);
    if (rows.length < PAGE) break;
  }
  const finMap = new Map(fins.map((f) => [f.stock_code, f]));
  return all
    .filter((s) => s.sector && finMap.has(s.stock_code))
    .map((s) => ({ ...s, fin: finMap.get(s.stock_code) }));
}

// ── 공공데이터 과거 일별시세 ──────────────────────────────────
async function fetchHistory(stockCode) {
  const url = new URL(PUBLIC_BASE);
  url.searchParams.set("serviceKey", PUBLIC_KEY);
  url.searchParams.set("resultType", "json");
  url.searchParams.set("numOfRows", "200");
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("beginBasDt", BEGIN);
  url.searchParams.set("endBasDt", END);
  url.searchParams.set("likeIsinCd", `KR7${stockCode}`);
  try {
    const r = await fetch(url.toString(), {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10_000),
    });
    const data = await r.json();
    const items = data?.response?.body?.items?.item ?? [];
    const arr = Array.isArray(items) ? items : [items];
    return arr
      .filter((i) => i.srtnCd === stockCode && Number(i.clpr) > 0)
      .map((i) => ({ date: i.basDt, close: Number(i.clpr) }))
      .sort((a, b) => a.date.localeCompare(b.date)); // 오름차순
  } catch {
    return [];
  }
}

async function buildPriceCache(universe) {
  if (!REFRESH && fs.existsSync(CACHE_FILE)) {
    console.log(`[캐시] ${path.basename(CACHE_FILE)} 사용`);
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  }
  console.log(`[시세] ${universe.length}종목 × ~0.25s 수집 중 (~${Math.round(universe.length * 0.25 / 60)}분)...`);
  const cache = {};
  let done = 0, ok = 0;
  for (const s of universe) {
    const hist = await fetchHistory(s.stock_code);
    if (hist.length > 0) { cache[s.stock_code] = hist; ok++; }
    if (++done % 100 === 0) process.stdout.write(`  ${done}/${universe.length} (유효 ${ok})\n`);
    await sleep(FETCH_DELAY_MS);
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  console.log(`  → 시세 ${ok}종목 확보, 캐시 저장`);
  return cache;
}

// ── 팩터 (높을수록 좋음 방향으로 통일) ────────────────────────
const inv = (x) => (Number.isFinite(x) && x > 0 ? 1 / x : null);

function fundamentalFactors(fin) {
  // value: earnings/book yield (per·pbr 역수, 적자/자본잠식은 결측)
  const ey = inv(Number(fin.per));   // per>0만 유효 → 적자 결측
  const by = inv(Number(fin.pbr));   // pbr>0만 유효 → 자본잠식 결측
  const value = ey != null && by != null ? (ey + by) / 2 : (ey ?? by);
  // quality: roe↑, debt_ratio↓, cur_ratio↑, cf_ops>0
  const roe = Number.isFinite(Number(fin.roe)) ? Number(fin.roe) : null;
  const debtPenalty = Number.isFinite(Number(fin.debt_ratio)) ? -Number(fin.debt_ratio) : null;
  const cur = Number.isFinite(Number(fin.cur_ratio)) ? Number(fin.cur_ratio) : null;
  const cf = Number.isFinite(Number(fin.cf_ops)) ? (Number(fin.cf_ops) > 0 ? 1 : 0) : null;
  const qParts = [roe, debtPenalty, cur, cf == null ? null : cf * 100].filter((v) => v != null);
  const quality = qParts.length ? qParts.reduce((a, b) => a + b, 0) / qParts.length : null;
  // growth: revenue_yoy, op_income_yoy
  const rg = Number.isFinite(Number(fin.revenue_yoy)) ? Number(fin.revenue_yoy) : null;
  const og = Number.isFinite(Number(fin.op_income_yoy)) ? Number(fin.op_income_yoy) : null;
  const gParts = [rg, og].filter((v) => v != null);
  const growth = gParts.length ? gParts.reduce((a, b) => a + b, 0) / gParts.length : null;
  return { value, quality, growth };
}

// 종목 시세 배열에서 date의 로컬 인덱스 (정확히 일치하는 거래일)
function indexOfDate(hist, date) {
  // hist 오름차순. 이진탐색.
  let lo = 0, hi = hist.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hist[mid].date === date) return mid;
    if (hist[mid].date < date) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

// ── MAIN ──────────────────────────────────────────────────────
console.log("=== KRXDATA Point-in-Time 백테스트 ===");
console.log(`기간: ${BEGIN} ~ ${END} (${LOOKBACK_DAYS}일) / 호라이즌 ${HORIZONS.join(",")} 영업일\n`);

const universe = await loadUniverse();
console.log(`[유니버스] sector+2025재무 보유 ${universe.length}종목`);

const priceCache = await buildPriceCache(universe);
const active = universe.filter((s) => priceCache[s.stock_code]?.length >= 60);
console.log(`[유효] 60거래일+ 시세 보유 ${active.length}종목\n`);

// 글로벌 거래일 캘린더 (시세 보유 종목들의 날짜 합집합, 빈도 상위)
const dateFreq = new Map();
for (const s of active) for (const r of priceCache[s.stock_code]) dateFreq.set(r.date, (dateFreq.get(r.date) || 0) + 1);
const calendar = [...dateFreq.entries()]
  .filter(([, c]) => c >= active.length * 0.5) // 절반 이상 거래된 날만
  .map(([d]) => d)
  .sort();
console.log(`[캘린더] 거래일 ${calendar.length}일`);

// 리밸런스 시점: 최대 호라이즌+여유 만큼 미래가 남는 인덱스만, 주간 간격
const maxH = Math.max(...HORIZONS);
const maxMom = Math.max(...MOM_LOOKBACKS);
const rebalIdx = [];
for (let i = maxMom; i + maxH < calendar.length; i += REBALANCE_STEP) rebalIdx.push(i);
console.log(`[리밸런스] ${rebalIdx.length}개 시점 (주간)\n`);

if (rebalIdx.length === 0) {
  console.error("리밸런스 시점 0 — 기간이 너무 짧거나 시세 부족. LOOKBACK_DAYS를 늘리세요.");
  process.exit(1);
}

// 팩터 키 (FACTOR_WEIGHTS 중 이 백테스트가 산출 가능한 것만)
const FACTOR_KEYS = ["value", "quality", "growth", "priceMomentum", "trend"];

// 시점별 IC 누적
const perHorizon = {};
for (const h of HORIZONS) perHorizon[h] = { ic: [], spread: [], hit: [], factorIC: {} };
for (const h of HORIZONS) for (const k of FACTOR_KEYS) perHorizon[h].factorIC[k] = [];

for (const tIdx of rebalIdx) {
  const T = calendar[tIdx];

  // 횡단면 구성
  const rows = [];
  for (const s of active) {
    const hist = priceCache[s.stock_code];
    const i = indexOfDate(hist, T);
    if (i < 0 || i < maxMom) continue; // T에 거래 없거나 모멘텀 lookback 부족
    const cT = hist[i].close;

    // 가격팩터 (T 시점까지만)
    const mom20 = i - 20 >= 0 ? cT / hist[i - 20].close - 1 : null;
    const mom60 = i - 60 >= 0 ? cT / hist[i - 60].close - 1 : null;
    const priceMomentum = mom20 != null && mom60 != null ? (mom20 + mom60) / 2 : (mom20 ?? mom60);
    let sma = null;
    if (i - SMA_WINDOW + 1 >= 0) {
      let sum = 0;
      for (let k = i - SMA_WINDOW + 1; k <= i; k++) sum += hist[k].close;
      sma = sum / SMA_WINDOW;
    }
    const trend = sma && sma > 0 ? cT / sma - 1 : null;

    // 포워드 수익률 (미래 인덱스 — look-ahead 아님: 검증용 라벨)
    const fwd = {};
    for (const h of HORIZONS) fwd[h] = i + h < hist.length ? hist[i + h].close / cT - 1 : null;

    const f = fundamentalFactors(s.fin);
    rows.push({
      stock_code: s.stock_code, sector: s.sector,
      value: f.value, quality: f.quality, growth: f.growth,
      priceMomentum, trend, fwd,
    });
  }
  if (rows.length < 30) continue; // 횡단면 표본 부족

  // 팩터별 섹터중립 z-score
  const z = {};
  for (const k of FACTOR_KEYS) z[k] = sectorZScores(rows, k, "sector"); // 결측→0 중립

  // 합성점수 (FACTOR_WEIGHTS)
  rows.forEach((r, idx) => {
    let comp = 0;
    for (const k of FACTOR_KEYS) comp += (FACTOR_WEIGHTS[k] ?? 0) * z[k][idx];
    r.composite = comp;
    for (const k of FACTOR_KEYS) r[`z_${k}`] = z[k][idx];
  });

  // 호라이즌별 평가
  for (const h of HORIZONS) {
    const valid = rows.filter((r) => Number.isFinite(r.fwd[h]));
    if (valid.length < 30) continue;
    const ret = valid.map((r) => r.fwd[h]);

    // 합성 IC
    perHorizon[h].ic.push(spearmanIC(valid.map((r) => [r.composite, r.fwd[h]])));
    // 팩터별 IC
    for (const k of FACTOR_KEYS) {
      perHorizon[h].factorIC[k].push(spearmanIC(valid.map((r) => [r[`z_${k}`], r.fwd[h]])));
    }
    // 분위 스프레드 (상위20% - 하위20% 평균 포워드수익)
    perHorizon[h].spread.push(
      quantileSpread(valid.map((r) => ({ s: r.composite, ret: r.fwd[h] })), "s", "ret", QUANTILE),
    );
    // top분위 hit rate (상위20%가 횡단면 중앙값 초과 비율)
    const sorted = [...valid].sort((a, b) => b.composite - a.composite);
    const kq = Math.max(1, Math.round(valid.length * QUANTILE));
    const med = [...ret].sort((a, b) => a - b)[Math.floor(ret.length / 2)];
    const topHit = sorted.slice(0, kq).filter((r) => r.fwd[h] > med).length / kq;
    perHorizon[h].hit.push(topHit);
  }
}

// ── 리포트 ────────────────────────────────────────────────────
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const posRate = (xs) => (xs.length ? xs.filter((v) => v > 0).length / xs.length : NaN);
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : "  -  ");
const pct = (v) => (Number.isFinite(v) ? (v * 100).toFixed(1) + "%" : "-");

console.log("\n════════════════════════════════════════════════════════");
console.log("  Point-in-Time 백테스트 결과");
console.log(`  유니버스 ${active.length}종목 · 리밸런스 ${rebalIdx.length}회 · ${BEGIN}~${END}`);
console.log("════════════════════════════════════════════════════════\n");

for (const h of HORIZONS) {
  const ph = perHorizon[h];
  console.log(`【${h}영업일 호라이즌】 (관측 ${ph.ic.length}회)`);
  console.log(`  합성 IC        평균 ${f3(avg(ph.ic))}  |  IC>0 비율 ${pct(posRate(ph.ic))}`);
  console.log(`  분위 스프레드   평균 ${pct(avg(ph.spread))}  (상위20% − 하위20% 포워드수익)`);
  console.log(`  top분위 hit    평균 ${pct(avg(ph.hit))}  (>50% 면 예측력 있음)`);
  console.log(`  ── 팩터별 IC (재가중 근거) ──`);
  const ranked = FACTOR_KEYS
    .map((k) => ({ k, ic: avg(ph.factorIC[k]), p: posRate(ph.factorIC[k]) }))
    .sort((a, b) => b.ic - a.ic);
  for (const { k, ic, p } of ranked) {
    console.log(`    ${k.padEnd(15)} IC ${f3(ic)}  (IC>0 ${pct(p)})  weight=${FACTOR_WEIGHTS[k] ?? 0}`);
  }
  console.log();
}

console.log("════════════════════════════════════════════════════════");
console.log("  ※ 가치/품질/성장: 연간 2025 재무 (PIT 안전)");
console.log("  ※ 가격모멘텀/추세: T 시점까지 시세만 사용 (look-ahead 없음)");
console.log("  ※ IC = spearman 순위상관. |IC|>0.03 이면 약한 예측력, >0.05 유의미");
console.log("  ※ 팩터별 IC로 config.js FACTOR_WEIGHTS 재가중 → 합성 IC 개선");
console.log("  ※ 3개월은 60일 호라이즌 관측이 적음 → 6개월(LOOKBACK_DAYS=180) 권장");
console.log("════════════════════════════════════════════════════════");
