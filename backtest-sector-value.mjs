/**
 * backtest-sector-value.mjs — "순자산 근처 섹터에서 우량 저평가주" 가설 검정 (2026-08-04 신설)
 *
 * ── 왜 새 스크립트인가 ────────────────────────────────────────────────────────
 * `backtest-pit.mjs` 는 모든 팩터를 **섹터중립 z-score** 로 만든다(`sectorZScores`).
 * 즉 "어느 섹터가 싼가"라는 정보를 설계상 **제거**한다. 그래서 이 아이디어는 그 백테로
 * 반증된 적이 없다 — 잰 적이 없다. 섹터 베팅을 살려두고 재려면 별도 엔진이 필요하다.
 *
 * ── 가설 ─────────────────────────────────────────────────────────────────────
 * "시가총액이 순자산에 가까운(=저PBR) 섹터에서 우량주를 고르면 초과수익이 난다."
 *
 * ── 3분기 대조 + 베이스라인 (사전선언 · 사후 조정 금지) ───────────────────────
 *   arm1 싼섹터+우량   : 섹터 book yield 상위 TERCILE ∩ 그 안에서 quality 상위 TOP_Q
 *   arm2 싼섹터+무작위 : 같은 섹터군에서 **동수 무작위** (시드 고정 · RANDOM_DRAWS 회 평균)
 *   arm3 비싼섹터+우량 : 섹터 book yield 하위 TERCILE ∩ quality 상위 TOP_Q
 *   arm4 전체+우량     : 섹터 무관 quality 상위 TOP_Q (섹터 축이 필요한지 분리)
 *   arm5 시장          : 전 종목 동일가중 평균 (벤치마크)
 *
 * ── 판정 기준 (여기 미리 적는다) ──────────────────────────────────────────────
 *   · 가설 성립 = (arm1 − arm2 > 노이즈바닥) **그리고** (arm1 − arm3 > 노이즈바닥)
 *   · arm1 ≈ arm2 → "우량 선별"이 무효 (섹터가 전부다)
 *   · arm1 ≈ arm3 → "싼 섹터" 축이 무효 (우량이 전부다)
 *   · **노이즈 바닥** = arm2 무작위 재추출 RANDOM_DRAWS 회의 리밸런스평균 표준편차.
 *     차이가 이보다 작으면 "차이 없음"이 아니라 **판정 불가**로 적는다.
 *   · 폭락구간(2026Q2 리밸런스 = 포워드가 2026-07 폭락에 걸리는 구간)은 **따로** 본다.
 *     전 구간 평균 하나로 국면효과를 덮지 않기 위해서다.
 *
 * ── 알려진 한계 (결론에 반드시 같이 적을 것) ──────────────────────────────────
 *   · 유니버스가 현재 stock_analysis 기준 = **생존편향**. 상폐 종목이 없다.
 *   · mcap_T = 현재주식수 프록시 × T종가 → 과거로 갈수록 증자·소각으로 부정확해진다.
 *     PBR 이 이 프록시에 직접 의존하므로 **이 실험의 핵심 변수가 가장 약한 고리**다.
 *   · 섹터 라벨은 stock_analysis.sector + SECTOR_OVERRIDE 보정(잔차상관 실측 기반, 14종목).
 *
 * 실행: node backtest-sector-value.mjs --candles candles-daily-toss-clean.jsonl --begin 20240101
 */
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { latestFinancialAsOf, estimateRceptDt, hasExtremeGap, fundamentalFactors } from "./backtest.js";
import { sectorZScores } from "./normalize.js";
import { applySectorOverride } from "./strategy-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env") });
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE 미설정"); process.exit(1); }

const ARGV = process.argv.slice(2);
const argOf = (f, d = null) => { const i = ARGV.indexOf(f); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };

// ── 설정 (사전선언) ───────────────────────────────────────────
const HORIZON = Number(argOf("--horizon", 60));   // 포워드 영업일
const REBALANCE_STEP = 5;                          // 주간
const TERCILE = 1 / 3;                             // 섹터 3분위
const TOP_Q = Number(argOf("--topq", 0.2));        // 섹터군 내 quality 상위 비율
const RANDOM_DRAWS = Number(argOf("--draws", 20)); // 무작위 재추출 횟수(노이즈 바닥 산출)
const MIN_SECTOR_N = 5;                            // 섹터 PBR 산출 최소 종목수
const MIN_PRICE = 1000;
const MAX_MOM = 60;                                // 워밍업(갭 가드 구간 확보)
const QMODE = argOf("--qmode", "raw");            // raw | z | roe  (우량 정의 민감도)
const CANDLES = argOf("--candles", "candles-daily-toss-clean.jsonl");
const BEGIN = argOf("--begin", "20240101");

/** 결정적 PRNG (mulberry32) — 무작위 팔을 **재현 가능**하게 한다. Math.random 이면 재실행마다 결론이 흔들린다. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sampleN(arr, n, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

// ── Supabase ──────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
async function pagedSelect(table, sel) {
  const all = []; const PAGE = 1000;
  for (let off = 0; ; off += PAGE) {
    const rows = await dbSelect(table, `${sel}&order=stock_code&limit=${PAGE}&offset=${off}`);
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

console.log("=== 섹터 저PBR × 우량 가설 검정 ===");
console.log(`구간 ${BEGIN}~ · 시세 ${CANDLES} · 호라이즌 ${HORIZON}영업일 · 섹터 3분위 · 우량 상위 ${(TOP_Q * 100).toFixed(0)}%(정의 ${QMODE}) · 무작위 ${RANDOM_DRAWS}회\n`);

const stocks = await pagedSelect("stock_analysis", "select=stock_code,corp_name,sector,current_price,market_cap_tril");
const fins = await pagedSelect("stock_financials",
  "select=stock_code,analysis_year,rcept_dt,roe,debt_ratio,cur_ratio,cf_ops,revenue_yoy,op_income_yoy,net_income,total_equity" +
  "&analysis_year=in.(2023,2024,2025)&report_code=eq.11011");
const finMap = new Map();
for (const f of fins) {
  f.rcept_dt = f.rcept_dt ?? estimateRceptDt(f.analysis_year, "11011");
  if (!finMap.has(f.stock_code)) finMap.set(f.stock_code, []);
  finMap.get(f.stock_code).push(f);
}
// 섹터 보정 — 라이브 봇과 **같은 함수**를 쓴다(SK스퀘어→금융 등 DB 오분류 교정).
const SECTOR = applySectorOverride(Object.fromEntries(stocks.map((s) => [s.stock_code, s.sector])));

// 시세
const priceCache = {};
for (const line of readFileSync(join(__dirname, CANDLES), "utf8").split("\n")) {
  if (!line.trim()) continue;
  let j; try { j = JSON.parse(line); } catch { continue; }
  const arr = [];
  for (let i = 0; i < j.d.length; i++) {
    const date = String(j.d[i]); if (date < BEGIN) continue;
    const c = Number(j.c[i]); if (!(c > 0)) continue;
    arr.push({ date, close: c });
  }
  if (arr.length) priceCache[j.code] = arr;
}

const universe = stocks
  .filter((s) => SECTOR[s.stock_code] && finMap.has(s.stock_code) && priceCache[s.stock_code]?.length >= MAX_MOM + HORIZON)
  .map((s) => ({
    ...s, sector: SECTOR[s.stock_code], finRows: finMap.get(s.stock_code),
    sharesProxy: s.current_price > 0 && s.market_cap_tril > 0 ? (s.market_cap_tril * 1e12) / s.current_price : null,
  }))
  .filter((s) => s.sharesProxy != null);
console.log(`[유니버스] 섹터+연간재무+시세 보유 ${universe.length}종목`);

const histCloses = {};
for (const s of universe) histCloses[s.stock_code] = priceCache[s.stock_code].map((r) => r.close);
const fullRangeGap = new Set();
for (const s of universe) { const c = histCloses[s.stock_code]; if (hasExtremeGap(c, 0, c.length - 1)) fullRangeGap.add(s.stock_code); }
console.log(`[가드] 전구간 corporate action 의심 ${fullRangeGap.size}종목 제외 (PBR 프록시가 깨진다)`);

const dateFreq = new Map();
for (const s of universe) for (const r of priceCache[s.stock_code]) dateFreq.set(r.date, (dateFreq.get(r.date) || 0) + 1);
const calendar = [...dateFreq.entries()].filter(([, c]) => c >= universe.length * 0.5).map(([d]) => d).sort();
const rebalIdx = [];
for (let i = MAX_MOM; i + HORIZON < calendar.length; i += REBALANCE_STEP) rebalIdx.push(i);
console.log(`[캘린더] 거래일 ${calendar.length}일 · 리밸런스 ${rebalIdx.length}회\n`);

const idxOf = (hist, date) => {
  let lo = 0, hi = hist.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (hist[m].date === date) return m; if (hist[m].date < date) lo = m + 1; else hi = m - 1; }
  return -1;
};
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs) => { if (xs.length < 2) return NaN; const m = avg(xs); return Math.sqrt(avg(xs.map((v) => (v - m) ** 2))); };

// ── 리밸런스 루프 ─────────────────────────────────────────────
const ARMS = ["arm1_싼섹터+우량", "arm2_싼섹터+무작위", "arm3_비싼섹터+우량", "arm4_전체+우량", "arm5_시장"];
const series = {}; for (const a of ARMS) series[a] = [];
const dates = [];
const drawSeries = Array.from({ length: RANDOM_DRAWS }, () => []);   // 노이즈 바닥용: 무작위 추출별 시계열
const sectorLog = [];

for (let ri = 0; ri < rebalIdx.length; ri++) {
  const tIdx = rebalIdx[ri];
  const T = calendar[tIdx];
  const rows = [];
  for (const s of universe) {
    if (fullRangeGap.has(s.stock_code)) continue;
    const hist = priceCache[s.stock_code];
    const i = idxOf(hist, T);
    if (i < 0 || i < MAX_MOM || i + HORIZON >= hist.length) continue;
    const cT = hist[i].close;
    if (cT < MIN_PRICE) continue;
    const closes = histCloses[s.stock_code];
    if (hasExtremeGap(closes, i - MAX_MOM, i)) continue;
    if (hasExtremeGap(closes, i, i + HORIZON)) continue;      // 포워드 구간 CA → 관측 제외
    const fin = latestFinancialAsOf(s.finRows, T);
    if (!fin) continue;                                        // PIT: 공시 전이면 제외
    const eq = Number(fin.total_equity);
    const mcapT = s.sharesProxy * cT;
    if (!(eq > 0) || !(mcapT > 0)) continue;
    const f = fundamentalFactors(fin, mcapT);
    if (f.quality == null) continue;
    rows.push({
      code: s.stock_code, sector: s.sector, equity: eq, mcap: mcapT,
      quality: f.quality, roe: Number.isFinite(Number(fin.roe)) ? Number(fin.roe) : null,
      fwd: hist[i + HORIZON].close / cT - 1,
    });
  }
  if (rows.length < 100) continue;
  // 섹터 내 z-score 표준화 quality (QMODE='z' 용). 결측은 0(중립).
  { const qz = sectorZScores(rows, 'quality', 'sector'); rows.forEach((r, i) => { r.qz = qz[i]; }); }

  // 섹터 book yield = Σ순자산 / Σ시총 (= 1/PBR). 개별 PBR 평균보다 이상치에 강하다.
  const bySector = new Map();
  for (const r of rows) {
    if (!bySector.has(r.sector)) bySector.set(r.sector, []);
    bySector.get(r.sector).push(r);
  }
  const sectorRank = [...bySector.entries()]
    .filter(([, rs]) => rs.length >= MIN_SECTOR_N)
    .map(([sec, rs]) => ({ sec, by: rs.reduce((a, r) => a + r.equity, 0) / rs.reduce((a, r) => a + r.mcap, 0), n: rs.length }))
    .sort((a, b) => b.by - a.by);                              // book yield 높은 순 = 싼 순
  if (sectorRank.length < 6) continue;
  const k = Math.max(1, Math.round(sectorRank.length * TERCILE));
  const cheapSecs = new Set(sectorRank.slice(0, k).map((x) => x.sec));
  const richSecs = new Set(sectorRank.slice(-k).map((x) => x.sec));
  if (ri === 0 || ri === rebalIdx.length - 1) {
    sectorLog.push(`  ${T} 싼섹터(PBR ${(1 / sectorRank[0].by).toFixed(2)}~): ${[...cheapSecs].slice(0, 5).join(", ")}` +
      ` │ 비싼섹터(~${(1 / sectorRank[sectorRank.length - 1].by).toFixed(2)}): ${[...richSecs].slice(0, 5).join(", ")}`);
  }

  /**
   * ★ "우량" 정의 민감도 (--qmode). 이걸 안 나누면 결론이 정의 아티팩트일 수 있다:
   *   `fundamentalFactors.quality` 는 [roe, −debt_ratio, cur_ratio, cf_ops×100] 의 **비정규화 평균**이다.
   *   debt_ratio·cur_ratio 는 수백 단위, roe 는 한자리~두자리라 **스케일 큰 항이 사실상 순위를 지배**한다.
   *   즉 raw 로 재면 "우량주"가 아니라 "저부채주"를 잰 것일 수 있다.
   *     raw : 현행 합성 그대로 (backtest-pit.mjs 와 동일 입력)
   *     z   : 섹터 내 z-score 로 표준화한 quality (스케일 지배 제거)
   *     roe : ROE 단독 (가장 통상적인 '우량' 해석)
   */
  const scoreOf = (r, pool) => {
    if (QMODE === "roe") return r.roe ?? -Infinity;
    if (QMODE === "z") return r.qz;
    return r.quality;
  };
  const topQualityOf = (pool) => {
    const n = Math.max(1, Math.round(pool.length * TOP_Q));
    return [...pool].sort((a, b) => scoreOf(b, pool) - scoreOf(a, pool)).slice(0, n);
  };
  const cheapPool = rows.filter((r) => cheapSecs.has(r.sector));
  const richPool = rows.filter((r) => richSecs.has(r.sector));
  if (cheapPool.length < 20 || richPool.length < 20) continue;

  const a1 = topQualityOf(cheapPool);
  const a3 = topQualityOf(richPool);
  const a4 = topQualityOf(rows);

  // arm2: 싼섹터 안에서 **arm1과 동수** 무작위. 시드는 리밸런스 인덱스+추출번호로 고정.
  const drawMeans = [];
  for (let d = 0; d < RANDOM_DRAWS; d++) {
    const pick = sampleN(cheapPool, a1.length, mulberry32(ri * 1000 + d));
    const m = avg(pick.map((r) => r.fwd));
    drawMeans.push(m);
    drawSeries[d].push(m);
  }

  dates.push(T);
  series["arm1_싼섹터+우량"].push(avg(a1.map((r) => r.fwd)));
  series["arm2_싼섹터+무작위"].push(avg(drawMeans));
  series["arm3_비싼섹터+우량"].push(avg(a3.map((r) => r.fwd)));
  series["arm4_전체+우량"].push(avg(a4.map((r) => r.fwd)));
  series["arm5_시장"].push(avg(rows.map((r) => r.fwd)));
}

// ── 리포트 ────────────────────────────────────────────────────
const pct = (v) => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%" : "  -  ");
console.log(`[섹터 예시]\n${sectorLog.join("\n")}\n`);
console.log("════════════════════════════════════════════════════════");
console.log(`  결과 — 리밸런스 ${dates.length}회 · ${dates[0]}~${dates[dates.length - 1]} · ${HORIZON}영업일 포워드`);
console.log("════════════════════════════════════════════════════════\n");
console.log(`  ${"팔".padEnd(22)}${"평균수익".padStart(10)}${"중위".padStart(10)}${"승률vs시장".padStart(12)}`);
const mkt = series["arm5_시장"];
for (const a of ARMS) {
  const s = series[a];
  const med = [...s].sort((x, y) => x - y)[Math.floor(s.length / 2)];
  const win = s.filter((v, i) => v > mkt[i]).length / s.length;
  console.log(`  ${a.padEnd(22)}${pct(avg(s)).padStart(10)}${pct(med).padStart(10)}${((win * 100).toFixed(1) + "%").padStart(12)}`);
}

// 노이즈 바닥 = 무작위 재추출 20회의 "전구간 평균" 표준편차
const drawFullMeans = drawSeries.map((s) => avg(s));
const noise = sd(drawFullMeans);
console.log(`\n  노이즈 바닥(무작위 ${RANDOM_DRAWS}회 재추출 전구간평균의 표준편차) = ${pct(noise)}`);
console.log(`    무작위 추출별 전구간평균 범위 ${pct(Math.min(...drawFullMeans))} ~ ${pct(Math.max(...drawFullMeans))}`);

const d12 = avg(series["arm1_싼섹터+우량"]) - avg(series["arm2_싼섹터+무작위"]);
const d13 = avg(series["arm1_싼섹터+우량"]) - avg(series["arm3_비싼섹터+우량"]);
const d14 = avg(series["arm1_싼섹터+우량"]) - avg(series["arm4_전체+우량"]);
const verdict = (d, label) => {
  const mag = Math.abs(d);
  if (!Number.isFinite(noise) || mag < noise) return `${label} ${pct(d)} → **판정 불가** (노이즈 바닥 ${pct(noise)} 미만)`;
  return `${label} ${pct(d)} → ${d > 0 ? "가설 방향" : "가설 반대"} (노이즈 초과)`;
};
console.log(`\n  ── 사전선언 판정 ──`);
console.log(`    ${verdict(d12, "arm1−arm2 (우량 선별 효과) ")}`);
console.log(`    ${verdict(d13, "arm1−arm3 (싼 섹터 효과)   ")}`);
console.log(`    ${verdict(d14, "arm1−arm4 (섹터 축 추가효과)")}`);
console.log(`\n    가설 성립 조건 = 위 두 줄(arm1−arm2, arm1−arm3)이 **둘 다** 노이즈 초과 + 양수`);
const pass = Number.isFinite(noise) && d12 > noise && d13 > noise;
console.log(`    → **${pass ? "가설 성립" : "가설 미성립"}**`);

// 분기 분해 + 폭락구간 분리
const q = (d) => `${d.slice(0, 4)}Q${Math.floor((Number(d.slice(4, 6)) - 1) / 3) + 1}`;
const buckets = [...new Set(dates.map(q))].sort();
console.log(`\n  ── 분기별 (국면효과 확인 — 한 분기가 전체를 만들었는지) ──`);
console.log(`  ${"분기".padEnd(8)}${"n".padStart(4)}${ARMS.map((a) => a.split("_")[0].padStart(9)).join("")}`);
for (const b of buckets) {
  const idx = dates.map((d, i) => (q(d) === b ? i : -1)).filter((i) => i >= 0);
  console.log(`  ${b.padEnd(8)}${String(idx.length).padStart(4)}` +
    ARMS.map((a) => pct(avg(idx.map((i) => series[a][i]))).padStart(9)).join(""));
}
console.log(`\n  ※ 2026Q2 리밸런스 = 포워드 ${HORIZON}영업일이 2026-07 폭락에 걸리는 구간이다. 따로 읽을 것.`);
console.log(`  ※ 한계: 생존편향(상폐 없음) · mcap_T=현재주식수×T종가 프록시(과거일수록 부정확, PBR 이 여기 직접 의존)`);
