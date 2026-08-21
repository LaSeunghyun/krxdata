/**
 * backtest-pit.mjs — Point-in-Time 백테스트 (look-ahead 제거)
 *
 * DB(stock_prices)의 일별시세를 읽어, 각 리밸런스 시점 T에서
 *   - 가치/품질/성장: T 시점에 공시돼 있던(rcept_dt <= T) 최신 연간 재무만 사용
 *   - 어닝모멘텀: T 시점 공시된 최신 분기보고서의 누적 전년동기 YoY
 *   - 가격모멘텀/추세: DB 시세를 T 시점까지만 사용 (미래 미사용)
 * 로 섹터중립 z-score 합성점수를 만들고, 20·60 영업일 포워드 수익률과
 * spearman IC / 분위 스프레드(gross/net) / top분위 hit rate를 산출한다.
 *
 * 한계(주의): 유니버스가 현재 stock_analysis 기준이라 상폐 종목이 빠진 생존 편향 존재.
 * sharesProxy(현재 주식수) 소급 적용은 전구간 갭 가드로 완화하나 완전하지 않음.
 *
 * 모든 위험 수학은 순수함수(normalize.js / backtest.js)에 격리, 골든테스트로 검증됨.
 * 시세 출처: stock_prices 테이블(매일 daily-ranking 잡이 적재). 공공API 미사용.
 *
 * 실행:  node backtest-pit.mjs
 */
import dotenv from "dotenv";
import path from "node:path";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sectorZScores } from "./normalize.js";
import {
  spearmanIC, quantileSpread, latestFinancialAsOf, estimateRceptDt, hasExtremeGap, fundamentalFactors,
} from "./backtest.js";
import { FACTOR_WEIGHTS, BACKTEST_ROUND_TRIP_COST, BACKTEST_MIN_PRICE } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE 미설정"); process.exit(1); }

// ── 설정 ──────────────────────────────────────────────────────
const LOOKBACK_DAYS = 400;         // DB에서 읽을 과거 범위(달력일) — 60일 호라이즌+모멘텀+리밸런스 확보용
const HORIZONS = [20, 60];         // 포워드 수익 영업일
const MOM_LOOKBACKS = [20, 60];    // 모멘텀 영업일
const SMA_WINDOW = 20;             // 추세용 이동평균
const REBALANCE_STEP = 5;          // 리밸런스 간격(영업일) = 주간
const QUANTILE = 0.2;              // 상·하위 분위

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const today = () => ymd(new Date());
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };

/**
 * ★ 2026-08-04 추가 — 시세 원천·구간·유니버스를 분리해 지정할 수 있게 한다. **기본값은 전부 현행과 동일**
 *   (`--candles` 없으면 stock_prices · 400일 · 전 유니버스) 이므로 옵션 없이 돌리면 기존 결과가 나온다.
 *
 * 왜 필요한가: `stock_prices` 는 400일(≈14개월)치만 실용적으로 쓸 수 있어 측정 구간이 짧다.
 *   그 구간에 2026-07 폭락이 통째로 들어 있어 **국면효과와 지속엣지를 구분할 수 없다.**
 *   `candles-daily-toss-clean.jsonl` 은 2021-09~2026-07 이라 구간을 넓힐 수 있다.
 *
 * ⚠️ **소스를 바꾸면 유니버스도 같이 바뀐다** — 이걸 안 나누면 결론이 오염된다.
 *      stock_prices 2,589종목 vs toss-clean 1,105종목(봇 유니버스라 대형주 편중).
 *   그래서 `--restrict <file>` 로 **유니버스만** 맞춘 대조군을 따로 돌릴 수 있게 했다.
 *
 * ⚠️ `stock_prices` 는 날짜가 KRX 거래일 대비 하루 밀려 있고 주말이 앞값으로 채워져 있다(2026-07-30 실측).
 *   toss-clean 은 실제 거래일이므로 **같은 구간이어도 수치가 달라지는 게 정상**이다.
 *
 *   --candles <file>    시세 원천을 jsonl 로 (기본: Supabase stock_prices)
 *   --begin <YYYYMMDD>  시작일 직접 지정 (기본: 오늘-400일)
 *   --restrict <file>   유니버스를 해당 jsonl 에 있는 종목으로 제한 (소스와 무관 — 대조군용)
 *   --subperiods        분기별 IC 분해표 출력 (국면효과 판정용)
 *   --label <str>       리포트 헤더에 표식
 */
const ARGV = process.argv.slice(2);
const argOf = (flag, dflt = null) => { const i = ARGV.indexOf(flag); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : dflt; };
const CANDLES_FILE = argOf("--candles");
const RESTRICT_FILE = argOf("--restrict");
const SUBPERIODS = ARGV.includes("--subperiods");
const LABEL = argOf("--label", "");

/**
 * ★ 2026-08-14 추가 — `--weights k=v,k=v` 로 합성 가중치를 덮어쓴다. 기본값은 config.FACTOR_WEIGHTS라
 *   옵션 없이 돌리면 기존 결과가 그대로 나온다(회귀 없음).
 *
 * 왜: 후보 가중치 조합을 비교하려면 매번 config.js를 고치거나 백테스트를 복제해야 했다.
 *   검증된 엔진(순수함수 골든테스트 대상)을 그대로 쓰면서 조합만 바꿔 끼우려고 뚫는다.
 */
function parseWeights(raw) {
  if (!raw) return { ...FACTOR_WEIGHTS };
  const w = Object.fromEntries(Object.keys(FACTOR_WEIGHTS).map((k) => [k, 0]));
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (!(k in w)) throw new Error(`알 수 없는 팩터: ${k} (가능: ${Object.keys(w).join(",")})`);
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`가중치가 숫자가 아님: ${k}=${v}`);
    w[k] = n;
  }
  return w;
}
const ACTIVE_WEIGHTS = parseWeights(argOf("--weights"));

const BEGIN = argOf("--begin") ?? daysAgo(LOOKBACK_DAYS);
const END = today();

// ── Supabase REST ─────────────────────────────────────────────
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function dbSelect(table, query, attempt = 0) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`${table} HTTP ${r.status}`);
    return r.json();
  } catch (e) {
    if (attempt < 4) { await sleep(500 * (attempt + 1)); return dbSelect(table, query, attempt + 1); }
    throw e;
  }
}

async function loadUniverse() {
  // 페이지네이션으로 전 종목 (sector/mrkt_ctg + 시총 → 주식수 프록시)
  const all = [];
  const PAGE = 1000;
  for (let off = 0; ; off += PAGE) {
    const rows = await dbSelect(
      "stock_analysis",
      `select=stock_code,corp_name,sector,mrkt_ctg,current_price,market_cap_tril&order=stock_code&limit=${PAGE}&offset=${off}`,
    );
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  // 연간 재무 (2023~2025) — 시점별 PIT 선택용. rcept_dt 없으면 보수적 추정일 폴백.
  const fins = [];
  for (let off = 0; ; off += PAGE) {
    const rows = await dbSelect(
      "stock_financials",
      `select=stock_code,analysis_year,rcept_dt,roe,debt_ratio,cur_ratio,cf_ops,revenue_yoy,op_income_yoy,net_income,total_equity` +
      `&analysis_year=in.(2023,2024,2025)&report_code=eq.11011&order=stock_code&limit=${PAGE}&offset=${off}`,
    );
    fins.push(...rows);
    if (rows.length < PAGE) break;
  }
  const finMap = new Map();
  for (const f of fins) {
    f.rcept_dt = f.rcept_dt ?? estimateRceptDt(f.analysis_year, "11011");
    if (!finMap.has(f.stock_code)) finMap.set(f.stock_code, []);
    finMap.get(f.stock_code).push(f);
  }
  // 분기 재무 — earningsMomentum (누적 전년동기 YoY, rcept_dt 기준 PIT)
  const qfins = [];
  for (let off = 0; ; off += PAGE) {
    const rows = await dbSelect(
      "stock_financials",
      `select=stock_code,analysis_year,rcept_dt,report_code,quarter,op_income_yoy` +
      `&report_code=in.(11012,11013,11014)&order=stock_code&limit=${PAGE}&offset=${off}`,
    );
    qfins.push(...rows);
    if (rows.length < PAGE) break;
  }
  const qMap = new Map();
  for (const f of qfins) {
    f.rcept_dt = f.rcept_dt ?? estimateRceptDt(f.analysis_year, f.report_code);
    if (!qMap.has(f.stock_code)) qMap.set(f.stock_code, []);
    qMap.get(f.stock_code).push(f);
  }
  return all
    .filter((s) => s.sector && finMap.has(s.stock_code))
    .map((s) => ({
      ...s,
      finRows: finMap.get(s.stock_code),
      qRows: qMap.get(s.stock_code) ?? [],
      sharesProxy: s.current_price > 0 && s.market_cap_tril > 0
        ? (s.market_cap_tril * 1e12) / s.current_price : null,
    }));
}

// ── DB(stock_prices)에서 일별시세 적재 ───────────────────────
// 공공API 미사용. 매일 daily-ranking 잡이 적재한 stock_prices를 읽는다.
async function buildPriceCacheFromDB() {
  console.log(`[DB] stock_prices 읽는 중 (date >= ${BEGIN})...`);
  const cache = {};
  const PAGE = 1000; // PostgREST 응답 최대 1000행 캡 → 페이지 크기 일치 필수
  let total = 0;
  for (let off = 0; ; off += PAGE) {
    const rows = await dbSelect(
      "stock_prices",
      `select=stock_code,date,close&date=gte.${BEGIN}&order=stock_code.asc,date.asc&limit=${PAGE}&offset=${off}`,
    );
    for (const r of rows) {
      const c = Number(r.close);
      if (!(c > 0)) continue;
      (cache[r.stock_code] ??= []).push({ date: String(r.date), close: c });
    }
    total += rows.length;
    if (rows.length < PAGE) break;
  }
  // date 오름차순 보장 (쿼리 정렬돼 있지만 방어적으로)
  for (const code of Object.keys(cache)) cache[code].sort((a, b) => a.date.localeCompare(b.date));
  console.log(`  → ${Object.keys(cache).length}종목 · ${total}행 적재`);
  return cache;
}

/**
 * ★ 2026-08-04: jsonl 일봉 캐시에서 시세 적재. `{code, d[], o[], h[], l[], c[], v[]}` 병렬배열 포맷.
 *   stock_prices 경로와 **같은 자료구조**({date, close}[] 오름차순)를 돌려줘서 이후 로직이 소스를 모르게 한다.
 *   BEGIN 이전 봉은 버린다(리밸런스 계산은 캘린더 기준이라 과거 봉이 남으면 구간 정의가 흐려진다).
 */
function buildPriceCacheFromJsonl(file) {
  console.log(`[캐시] ${file} 읽는 중 (date >= ${BEGIN})...`);
  const cache = {};
  let total = 0, skipped = 0;
  for (const line of readFileSync(join(__dirname, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { skipped++; continue; }
    const arr = [];
    for (let i = 0; i < j.d.length; i++) {
      const date = String(j.d[i]);
      if (date < BEGIN) continue;
      const c = Number(j.c[i]);
      if (!(c > 0)) continue;
      arr.push({ date, close: c });
    }
    if (!arr.length) continue;
    arr.sort((a, b) => a.date.localeCompare(b.date));
    cache[j.code] = arr;
    total += arr.length;
  }
  console.log(`  → ${Object.keys(cache).length}종목 · ${total}행 적재${skipped ? ` (파싱실패 ${skipped}행)` : ""}`);
  return cache;
}

/** --restrict 용: jsonl 에 존재하는 종목코드 집합만 뽑는다(시세는 안 읽는다). */
function codesInJsonl(file) {
  const set = new Set();
  for (const line of readFileSync(join(__dirname, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { set.add(JSON.parse(line).code); } catch { /* skip */ }
  }
  return set;
}

// 펀더멘털 팩터 계산은 순수 모듈(backtest.js fundamentalFactors)로 격리 — 골든 테스트 대상.

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

let universe = await loadUniverse();
console.log(`[유니버스] sector+연간재무(2023~2025) 보유 ${universe.length}종목`);

// ★ 유니버스 제한 — 시세 원천과 **독립**으로 건다. 소스 교체 효과와 유니버스 축소 효과를 분리하기 위한 대조군용.
if (RESTRICT_FILE) {
  const keep = codesInJsonl(RESTRICT_FILE);
  const before = universe.length;
  universe = universe.filter((s) => keep.has(s.stock_code));
  console.log(`[제한] ${RESTRICT_FILE} 교집합 → ${before} → ${universe.length}종목`);
}

const priceCache = CANDLES_FILE ? buildPriceCacheFromJsonl(CANDLES_FILE) : await buildPriceCacheFromDB();
const MIN_HIST = Math.max(...MOM_LOOKBACKS) + Math.max(...HORIZONS); // 모멘텀+호라이즌 1회분 최소 거래일
const active = universe.filter((s) => priceCache[s.stock_code]?.length >= MIN_HIST);
console.log(`[유효] ${MIN_HIST}거래일+ 시세 보유 ${active.length}종목\n`);

// corporate action 가드용 close 배열 사전 계산
const histCloses = {};
for (const code of Object.keys(priceCache)) histCloses[code] = priceCache[code].map((r) => r.close);

// 전 구간에 액면분할·증자 의심 갭이 있는 종목: value 팩터 차단용.
// sharesProxy(현재 주식수)를 과거로 소급하는 mcap_T 추정이 이런 종목에서 체계적으로 깨지기 때문.
const fullRangeGap = new Set();
for (const code of Object.keys(histCloses)) {
  const c = histCloses[code];
  if (hasExtremeGap(c, 0, c.length - 1)) fullRangeGap.add(code);
}
console.log(`[가드] 전구간 corporate action 의심 ${fullRangeGap.size}종목 — value 팩터 중립 처리`);

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
const FACTOR_KEYS = ["value", "quality", "growth", "earningsMomentum", "priceMomentum", "trend"];

// 시점별 IC 누적
const perHorizon = {};
for (const h of HORIZONS) perHorizon[h] = { ic: [], spread: [], hit: [], factorIC: {}, voidIC: {}, dates: [] };
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
    if (cT < BACKTEST_MIN_PRICE) continue; // 동전주 제외 (유동성·슬리피지)
    const closes = histCloses[s.stock_code];
    if (hasExtremeGap(closes, i - maxMom, i)) continue; // 모멘텀 구간 corporate action 의심 → 제외

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

    // ★PIT: T 시점에 공시돼 있던 최신 연간 재무만 사용 (look-ahead 차단)
    const fin = latestFinancialAsOf(s.finRows, T);
    // mcap_T = 현재 주식수 프록시 × T 종가. 전구간 corporate action 의심 종목은 value 중립.
    const mcapT = s.sharesProxy != null && !fullRangeGap.has(s.stock_code) ? s.sharesProxy * cT : null;
    const f = fundamentalFactors(fin, mcapT);
    // 분기 어닝모멘텀: T 시점 공시된 최신 분기보고서의 누적 전년동기 YoY.
    // 999 = 흑자전환 sentinel(quarterlyYoY) — 크기 정보가 없으므로 중립(null) 처리.
    const qFin = latestFinancialAsOf(s.qRows, T);
    const qYoY = qFin != null ? Number(qFin.op_income_yoy) : NaN;
    const earningsMomentum = Number.isFinite(qYoY) && qYoY < 999 ? qYoY : null;

    // 포워드 수익률 (검증용 라벨). 구간 내 corporate action 갭은 관측 제외.
    const fwd = {};
    for (const h of HORIZONS) {
      if (i + h >= hist.length) { fwd[h] = null; continue; }
      fwd[h] = hasExtremeGap(closes, i, i + h) ? null : hist[i + h].close / cT - 1;
    }

    rows.push({
      stock_code: s.stock_code, sector: s.sector,
      value: f.value, quality: f.quality, growth: f.growth,
      earningsMomentum, priceMomentum, trend, fwd,
    });
  }
  if (rows.length < 30) continue; // 횡단면 표본 부족

  // 팩터별 섹터중립 z-score
  const z = {};
  for (const k of FACTOR_KEYS) z[k] = sectorZScores(rows, k, "sector"); // 결측→0 중립
  /**
   * ★ 2026-08-04: **구조적 결측 계측.** `sectorZScores` 는 결측을 0(중립)으로 채운다. 그래서 해당 시점에
   *   그 팩터 데이터가 **한 종목도 없으면** z 가 전부 0 인데, spearmanIC 는 그걸 조용히 0.000 으로 돌려준다
   *   = "예측력 없음"과 "데이터 없음"이 같은 숫자가 된다.
   *   실제로 물렸다: 분기보고서가 DB 에 rcept_dt 20250414 부터만 있어 2024Q1~2025Q1 의
   *   earningsMomentum 관측 49건이 전부 구조적 0 이었고, 그게 평균을 0 쪽으로 희석했다.
   *   → 시점별로 "전부 동일값(=정보 없음)"인지 표시해 리포트에서 분리한다.
   */
  const voidK = {};
  for (const k of FACTOR_KEYS) voidK[k] = z[k].every((v) => v === z[k][0]);

  // 합성점수 (FACTOR_WEIGHTS)
  rows.forEach((r, idx) => {
    let comp = 0;
    for (const k of FACTOR_KEYS) comp += (ACTIVE_WEIGHTS[k] ?? 0) * z[k][idx];
    r.composite = comp;
    for (const k of FACTOR_KEYS) r[`z_${k}`] = z[k][idx];
  });

  // 호라이즌별 평가
  for (const h of HORIZONS) {
    const valid = rows.filter((r) => Number.isFinite(r.fwd[h]));
    if (valid.length < 30) continue;
    const ret = valid.map((r) => r.fwd[h]);

    // 합성 IC. ★ dates 는 ic·factorIC 와 **같은 블록에서 같은 횟수** push 되므로 인덱스가 정렬돼 있다
    //   (분기 분해가 이 정렬에 의존한다 — 한쪽만 조건부로 push 하면 조용히 어긋난다).
    perHorizon[h].dates.push(T);
    perHorizon[h].ic.push(spearmanIC(valid.map((r) => [r.composite, r.fwd[h]])));
    // 팩터별 IC. voidIC 는 "그 시점에 데이터가 아예 없었다"는 표시 — 평균에서 분리하려고 같이 쌓는다.
    for (const k of FACTOR_KEYS) {
      perHorizon[h].factorIC[k].push(spearmanIC(valid.map((r) => [r[`z_${k}`], r.fwd[h]])));
      (perHorizon[h].voidIC[k] ??= []).push(voidK[k]);
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
console.log(`  시세원천 ${CANDLES_FILE ?? "stock_prices(DB)"}${RESTRICT_FILE ? ` · 유니버스제한 ${RESTRICT_FILE}` : ""}${LABEL ? ` · ${LABEL}` : ""}`);
console.log("════════════════════════════════════════════════════════\n");

for (const h of HORIZONS) {
  const ph = perHorizon[h];
  console.log(`【${h}영업일 호라이즌】 (관측 ${ph.ic.length}회)`);
  console.log(`  합성 IC        평균 ${f3(avg(ph.ic))}  |  IC>0 비율 ${pct(posRate(ph.ic))}`);
  console.log(`  분위 스프레드   gross ${pct(avg(ph.spread))} | net(왕복비용 ${(BACKTEST_ROUND_TRIP_COST * 100).toFixed(1)}%) ${pct(avg(ph.spread) - BACKTEST_ROUND_TRIP_COST)}`);
  console.log(`  top분위 hit    평균 ${pct(avg(ph.hit))}  (>50% 면 예측력 있음)`);
  console.log(`  ── 팩터별 IC (재가중 근거) ──`);
  const ranked = FACTOR_KEYS
    .map((k) => {
      // 구조적 결측(그 시점 데이터 0건) 관측을 뺀 값이 **진짜 측정치**다. 섞으면 0 쪽으로 희석된다.
      const live = ph.factorIC[k].filter((_, i) => !ph.voidIC[k]?.[i]);
      const nVoid = ph.factorIC[k].length - live.length;
      return { k, ic: avg(live), p: posRate(live), n: live.length, nVoid };
    })
    .sort((a, b) => b.ic - a.ic);
  for (const { k, ic, p, n, nVoid } of ranked) {
    console.log(`    ${k.padEnd(15)} IC ${f3(ic)}  (IC>0 ${pct(p)})  weight=${ACTIVE_WEIGHTS[k] ?? 0}` +
      `${nVoid ? `   ★유효 ${n}회 (구조적결측 ${nVoid}회 제외 — 그 시점 데이터 0건)` : ""}`);
  }
  console.log();
}

// ── 분기별 IC 분해 (--subperiods) ─────────────────────────────
/**
 * ★ 2026-08-04: **국면효과 판정용.** 전체 평균 IC 하나로는 "폭락 한 번이 만든 값"과 "지속 엣지"를
 *   구분할 수 없다. 리밸런스 시점을 분기로 묶어 팩터 IC 를 나눠 본다.
 *   판정 기준(사후 조정 금지 — 여기 미리 적는다):
 *     · 지속 엣지 = 분기 대다수(≥70%)에서 같은 부호 + 특정 분기를 빼도 평균 부호 유지
 *     · 국면효과 = 한두 분기가 전체 평균을 만들고, 그 분기를 빼면 부호가 사라지거나 뒤집힘
 */
if (SUBPERIODS) {
  const q = (d) => `${d.slice(0, 4)}Q${Math.floor((Number(d.slice(4, 6)) - 1) / 3) + 1}`;
  for (const h of HORIZONS) {
    const ph = perHorizon[h];
    if (!ph.dates.length) continue;
    const buckets = [...new Set(ph.dates.map(q))].sort();
    console.log(`\n【${h}영업일 · 분기별 IC 분해】`);
    console.log(`  ${"분기".padEnd(8)}${"n".padStart(4)}  ${["composite", ...FACTOR_KEYS].map((k) => k.slice(0, 8).padStart(9)).join("")}`);
    for (const b of buckets) {
      const idx = ph.dates.map((d, i) => (q(d) === b ? i : -1)).filter((i) => i >= 0);
      const cells = [avg(idx.map((i) => ph.ic[i])), ...FACTOR_KEYS.map((k) => avg(idx.map((i) => ph.factorIC[k][i])))];
      console.log(`  ${b.padEnd(8)}${String(idx.length).padStart(4)}  ${cells.map((v) => f3(v).padStart(9)).join("")}`);
    }
    // 제외검정: 각 분기를 하나씩 빼고 전체 평균이 어떻게 변하는지 — 한 분기 의존이면 여기서 드러난다
    console.log(`  ── 분기 1개 제외 시 전체 평균 (부호 유지되는가) ──`);
    for (const k of ["composite", ...FACTOR_KEYS]) {
      const series = k === "composite" ? ph.ic : ph.factorIC[k];
      const full = avg(series);
      const drops = buckets.map((b) => {
        const idx = ph.dates.map((d, i) => (q(d) === b ? -1 : i)).filter((i) => i >= 0);
        return { b, v: avg(idx.map((i) => series[i])) };
      });
      const flips = drops.filter((d) => Number.isFinite(d.v) && Math.sign(d.v) !== Math.sign(full));
      const worst = drops.reduce((a, c) => (Math.abs(c.v - full) > Math.abs(a.v - full) ? c : a), drops[0]);
      console.log(`    ${k.padEnd(16)} 전체 ${f3(full)} · 최대변동 ${worst.b} 제외 시 ${f3(worst.v)}` +
        `${flips.length ? `  ★부호뒤집힘: ${flips.map((d) => d.b).join(",")}` : ""}`);
    }
  }
  console.log();
}

console.log("════════════════════════════════════════════════════════");
console.log("  ※ 가치/품질/성장: 각 시점 T에서 rcept_dt <= T 인 최신 연간 재무 (PIT)");
console.log("  ※ 어닝모멘텀: T 시점 공시된 최신 분기보고서 누적 전년동기 YoY");
console.log("  ※ 가격모멘텀/추세: T 시점까지 시세만 사용 (look-ahead 없음)");
console.log("  ※ |일간변동|>35% corporate action 의심 관측·동전주(<1,000원) 제외");
console.log("  ※ IC = spearman 순위상관. |IC|>0.03 이면 약한 예측력, >0.05 유의미");
console.log("  ※ 팩터별 IC로 config.js FACTOR_WEIGHTS 재가중 → 합성 IC 개선");
console.log("════════════════════════════════════════════════════════");

// ── --save-ic: factor_ic_history 적재 (rolling IC 모니터링) ──
if (process.argv.includes("--save-ic")) {
  const runDate = new Date().toISOString().slice(0, 10);
  const icRows = [];
  for (const h of HORIZONS) {
    const ph = perHorizon[h];
    const push = (factor, ics) => icRows.push({
      run_date: runDate, horizon: h, factor,
      ic: Number.isFinite(avg(ics)) ? +avg(ics).toFixed(4) : null,
      ic_pos_rate: Number.isFinite(posRate(ics)) ? +posRate(ics).toFixed(3) : null,
      n_obs: ics.length, period_begin: BEGIN, period_end: END,
    });
    push("composite", ph.ic);
    for (const k of FACTOR_KEYS) push(k, ph.factorIC[k]);
  }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/factor_ic_history?on_conflict=run_date,horizon,factor`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(icRows),
  });
  console.log(r.ok ? `[factor_ic_history] ${icRows.length}행 저장 (run_date=${runDate})` : `[factor_ic_history] 저장 실패 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
