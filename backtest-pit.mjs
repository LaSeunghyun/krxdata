/**
 * backtest-pit.mjs — Point-in-Time 백테스트 (look-ahead 제거)
 *
 * DB(stock_prices)의 일별시세를 읽어, 각 리밸런스 시점 T에서
 *   - 가치/품질/성장: stock_financials(연간 2025, ~3월 공시라 PIT 안전)
 *   - 가격모멘텀/추세: DB 시세를 T 시점까지만 사용 (미래 미사용)
 * 로 섹터중립 z-score 합성점수를 만들고, 20·60 영업일 포워드 수익률과
 * spearman IC / 분위 스프레드 / top분위 hit rate를 산출한다.
 *
 * 모든 위험 수학은 순수함수(normalize.js / backtest.js)에 격리, 골든테스트로 검증됨.
 * 시세 출처: stock_prices 테이블(매일 daily-ranking 잡이 적재). 공공API 미사용.
 *
 * 실행:  node backtest-pit.mjs
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sectorZScores } from "./normalize.js";
import { spearmanIC, quantileSpread, latestFinancialAsOf, estimateRceptDt, hasExtremeGap } from "./backtest.js";
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

const BEGIN = daysAgo(LOOKBACK_DAYS);
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

// ── 팩터 (높을수록 좋음 방향으로 통일) ────────────────────────
// fin = T 시점 PIT 선택된 연간 재무 행. value는 DB의 stale per/pbr 대신
// T 시점 시총(주식수 프록시 × T 종가)으로 직접 계산해 PIT 정합 유지.
function fundamentalFactors(fin, mcapT) {
  if (!fin) return { value: null, quality: null, growth: null };
  const ni = Number(fin.net_income), eq = Number(fin.total_equity);
  const ey = Number.isFinite(ni) && ni > 0 && mcapT > 0 ? ni / mcapT : null; // earnings yield
  const by = Number.isFinite(eq) && eq > 0 && mcapT > 0 ? eq / mcapT : null; // book yield (자본잠식 결측)
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

const priceCache = await buildPriceCacheFromDB();
const MIN_HIST = Math.max(...MOM_LOOKBACKS) + Math.max(...HORIZONS); // 모멘텀+호라이즌 1회분 최소 거래일
const active = universe.filter((s) => priceCache[s.stock_code]?.length >= MIN_HIST);
console.log(`[유효] ${MIN_HIST}거래일+ 시세 보유 ${active.length}종목\n`);

// corporate action 가드용 close 배열 사전 계산
const histCloses = {};
for (const code of Object.keys(priceCache)) histCloses[code] = priceCache[code].map((r) => r.close);

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
    const mcapT = s.sharesProxy != null ? s.sharesProxy * cT : null;
    const f = fundamentalFactors(fin, mcapT);
    // 분기 어닝모멘텀: T 시점 공시된 최신 분기보고서의 누적 전년동기 YoY
    const qFin = latestFinancialAsOf(s.qRows, T);
    const earningsMomentum =
      qFin && Number.isFinite(Number(qFin.op_income_yoy)) ? Number(qFin.op_income_yoy) : null;

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
  console.log(`  분위 스프레드   gross ${pct(avg(ph.spread))} | net(왕복비용 ${(BACKTEST_ROUND_TRIP_COST * 100).toFixed(1)}%) ${pct(avg(ph.spread) - BACKTEST_ROUND_TRIP_COST)}`);
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
