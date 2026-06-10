# KRXDATA 수익성 개선 (PIT 수정 + 스코어링 v6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 백테스트의 look-ahead 누수를 제거해 신뢰 가능한 팩터 IC를 확보하고, 그 증거에 맞춰 라이브 스코어를 v6로 재배분하며, 분기 어닝모멘텀·포트폴리오 원장·rolling IC 모니터링을 추가한다.

**Architecture:** 위험 수학은 전부 순수 함수(`backtest.js`)에 격리하고 골든 테스트로 검증(기존 스펙 SCORING_V2_SPEC.md 원칙 유지). DB 스키마는 `stock_financials`에 `rcept_dt/report_code/quarter`를 추가해 연간·분기 행이 공존. 백테스트(`backtest-pit.mjs`)는 각 리밸런스 시점 T에서 `rcept_dt <= T`인 최신 재무만 사용.

**Tech Stack:** Node 18+ ESM, node:test, Supabase (PostgREST + Management API SQL), OpenDART API.

**작업 디렉토리:** `C:\claudeT\files` (브랜치 `feature/pit-v6`, main에 기존 uncommitted 변경 있음 — 건드리지 않는다)

---

## 사전 확인 사항 (구현자가 알아야 할 도메인 지식)

1. **look-ahead 누수란:** 백테스트 구간 2025-05~2026-05 전체에 FY2025 재무(2026년 3월 공시)를 적용 중. 2026-03 이전 리밸런스 시점은 그 시점 기준 최신 공시분(FY2024)을 써야 한다.
2. **rcept_dt 소스:** DART `fnlttMultiAcnt.json` 응답의 각 행 `rcept_no` 앞 8자리가 접수일(YYYYMMDD). 별도 list API 불필요.
3. **분기 YoY:** 분기보고서의 `thstrm_add_amount`(당기 누적) vs `frmtrm_add_amount`(전년동기 누적) 비교 — 계절성 자동 제거. `factors.js`의 `quarterlyYoY()` 재사용.
4. **한국 가격제한폭 ±30%:** 일간 종가 변동 |35%| 초과는 액면분할·무상증자 등 corporate action으로 간주(수정주가 미보유이므로 해당 관측 제외).
5. **DB 유니크 제약:** 현재 `(stock_code, analysis_year)` 유니크. 분기 행 공존을 위해 `(stock_code, analysis_year, report_code)`로 교체 — **기존 ON CONFLICT 절을 쓰는 모든 코드를 같이 고쳐야 한다** (`dart-financials-backfill.js`, `populate-financials.js` 확인).
6. **report_code:** `11011`=사업보고서(연간), `11013`=1분기, `11012`=반기, `11014`=3분기.

---

### Task 1: 순수 함수 3종 — `latestFinancialAsOf`, `hasExtremeGap`, `estimateRceptDt`

**Files:**
- Modify: `C:\claudeT\files\backtest.js` (끝에 추가)
- Test: `C:\claudeT\files\tests\backtest.test.js` (끝에 추가)

- [ ] **Step 1: 브랜치 생성 + 기존 테스트 green 확인**

```bash
cd C:\claudeT\files
git checkout -b feature/pit-v6
npm test
```
Expected: 기존 골든 테스트 전부 PASS.

- [ ] **Step 2: 실패하는 테스트 작성** — `tests/backtest.test.js` 끝에 추가:

```js
import { latestFinancialAsOf, hasExtremeGap, estimateRceptDt } from '../backtest.js';

test('latestFinancialAsOf: asOf 이전 최신 공시분 선택 (look-ahead 차단)', () => {
  const rows = [
    { analysis_year: 2024, rcept_dt: '20250331', v: 'fy24' },
    { analysis_year: 2025, rcept_dt: '20260331', v: 'fy25' },
  ];
  assert.equal(latestFinancialAsOf(rows, '20250801').v, 'fy24'); // FY2025는 미래
  assert.equal(latestFinancialAsOf(rows, '20260401').v, 'fy25');
  assert.equal(latestFinancialAsOf(rows, '20260331').v, 'fy25'); // 경계 포함
  assert.equal(latestFinancialAsOf(rows, '20250101'), null);     // 둘 다 미래
});

test('latestFinancialAsOf: rcept_dt 없는 행 무시, 빈 입력 null', () => {
  assert.equal(latestFinancialAsOf([{ analysis_year: 2025, rcept_dt: null }], '20260601'), null);
  assert.equal(latestFinancialAsOf([], '20260601'), null);
  assert.equal(latestFinancialAsOf(null, '20260601'), null);
});

test('hasExtremeGap: |일간변동| > 35% → corporate action 의심', () => {
  assert.equal(hasExtremeGap([100, 130, 130], 0, 2), false);  // 상한가 30%는 정상
  assert.equal(hasExtremeGap([100, 50, 50], 0, 2), true);     // -50% 액면분할 의심
  assert.equal(hasExtremeGap([100, 100, 100, 200], 0, 2), false); // 구간 밖 갭 무시
  assert.equal(hasExtremeGap([100, 0, 100], 0, 2), true);     // 비정상가 0
});

test('estimateRceptDt: 보고서별 보수적 공시 추정일', () => {
  assert.equal(estimateRceptDt(2024, '11011'), '20250401'); // 사업보고서 → 익년 4/1
  assert.equal(estimateRceptDt(2025, '11013'), '20250516'); // 1분기 → 5/16
  assert.equal(estimateRceptDt(2025, '11012'), '20250815'); // 반기 → 8/15
  assert.equal(estimateRceptDt(2025, '11014'), '20251115'); // 3분기 → 11/15
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npm test`
Expected: FAIL — `latestFinancialAsOf is not a function` 류.

- [ ] **Step 4: 구현** — `backtest.js` 끝에 추가:

```js
// 한 종목의 재무 행들 중 rcept_dt <= asOf 인 최신 행. 동률이면 analysis_year 큰 쪽.
export function latestFinancialAsOf(rows, asOf) {
  if (!Array.isArray(rows)) return null;
  let best = null;
  for (const r of rows) {
    if (r?.rcept_dt == null) continue;
    const d = String(r.rcept_dt);
    if (d > String(asOf)) continue;
    if (
      best === null ||
      d > String(best.rcept_dt) ||
      (d === String(best.rcept_dt) && (r.analysis_year ?? 0) > (best.analysis_year ?? 0))
    ) best = r;
  }
  return best;
}

// closes[startIdx..endIdx] 구간에 |일간변동| > threshold 또는 비정상가(<=0) 존재 여부.
// 수정주가 미보유 환경에서 액면분할·무상증자 왜곡 관측 제외용. KR 가격제한폭 ±30% → 기본 0.35.
export function hasExtremeGap(closes, startIdx, endIdx, threshold = 0.35) {
  const lo = Math.max(1, startIdx + 1);
  const hi = Math.min(closes.length - 1, endIdx);
  for (let i = lo; i <= hi; i++) {
    const a = closes[i - 1], b = closes[i];
    if (!(a > 0) || !(b > 0)) return true;
    if (Math.abs(b / a - 1) > threshold) return true;
  }
  return false;
}

// rcept_dt 미보유 행의 보수적(법정기한+여유) 공시 추정일
export function estimateRceptDt(analysisYear, reportCode = "11011") {
  const y = Number(analysisYear);
  switch (String(reportCode)) {
    case "11013": return `${y}0516`; // 1분기보고서
    case "11012": return `${y}0815`; // 반기보고서
    case "11014": return `${y}1115`; // 3분기보고서
    default:      return `${y + 1}0401`; // 사업보고서
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npm test`  → Expected: 전부 PASS.

- [ ] **Step 6: Commit**

```bash
git add backtest.js tests/backtest.test.js
git commit -m "feat: PIT 선택·corporate action 가드·공시일 추정 순수 함수 (golden tests)"
```

---

### Task 2: DB 마이그레이션 — rcept_dt/report_code/quarter + 신규 테이블 2개

**Files:**
- Create: `C:\claudeT\files\migration-v6.sql`
- Create: `C:\claudeT\files\run-migration.mjs`
- Modify: `C:\claudeT\files\dart-financials-backfill.js` (ON CONFLICT 대상 + export 추가)

- [ ] **Step 1: migration-v6.sql 작성**

```sql
-- v6: PIT 컬럼 + 분기 행 공존 + IC 이력 + 포트폴리오 원장
ALTER TABLE public.stock_financials ADD COLUMN IF NOT EXISTS report_code TEXT NOT NULL DEFAULT '11011';
ALTER TABLE public.stock_financials ADD COLUMN IF NOT EXISTS rcept_dt    TEXT;
ALTER TABLE public.stock_financials ADD COLUMN IF NOT EXISTS quarter     SMALLINT;

-- 기존 PK/유니크 제약을 (stock_code, analysis_year, report_code)로 교체
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.stock_financials'::regclass AND contype IN ('p','u')
  LOOP
    EXECUTE format('ALTER TABLE public.stock_financials DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.stock_financials
  ADD CONSTRAINT stock_financials_code_year_report_uniq
  UNIQUE (stock_code, analysis_year, report_code);

CREATE TABLE IF NOT EXISTS public.factor_ic_history (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  horizon      SMALLINT NOT NULL,
  factor       TEXT NOT NULL,        -- 'composite' 또는 팩터 키
  ic           NUMERIC,
  ic_pos_rate  NUMERIC,
  n_obs        INT,
  period_begin TEXT,
  period_end   TEXT,
  UNIQUE (run_date, horizon, factor)
);

CREATE TABLE IF NOT EXISTS public.portfolio_positions (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stock_code  TEXT NOT NULL,
  corp_name   TEXT,
  entry_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  entry_price NUMERIC NOT NULL,
  weight_pct  NUMERIC NOT NULL DEFAULT 5,
  status      TEXT NOT NULL DEFAULT 'open',  -- open | half_exited | closed
  exit_date   DATE,
  exit_price  NUMERIC,
  exit_reason TEXT,                          -- stop_loss | half_profit | manual | rescreen
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portfolio_active ON public.portfolio_positions (status) WHERE status != 'closed';
```

- [ ] **Step 2: run-migration.mjs 작성** (Management API로 SQL 파일 실행)

```js
// 실행: node run-migration.mjs migration-v6.sql
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const MGMT_KEY = process.env.SUPABASE_MANAGEMENT_KEY;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
if (!MGMT_KEY || !PROJECT_REF) { console.error("SUPABASE_MANAGEMENT_KEY / SUPABASE_PROJECT_REF 미설정"); process.exit(1); }

const file = process.argv[2];
if (!file) { console.error("사용법: node run-migration.mjs <file.sql>"); process.exit(1); }
const sql = fs.readFileSync(path.join(__dirname, file), "utf8");

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${MGMT_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
});
const data = await res.json();
if (!res.ok) { console.error("마이그레이션 실패:", JSON.stringify(data)); process.exit(1); }
console.log(`✅ ${file} 적용 완료`, Array.isArray(data) ? `(rows: ${data.length})` : "");
```

- [ ] **Step 3: ON CONFLICT 사용처 전수 조사 후 수정**

Run: `grep -rn "ON CONFLICT (stock_code, analysis_year)" --include="*.js" --include="*.mjs" C:\claudeT\files`

각 결과의 conflict 대상을 `(stock_code, analysis_year, report_code)`로 변경. `dart-financials-backfill.js`의 upsertRows는 INSERT 컬럼에 `report_code`를 명시('11011')하고 conflict 대상 교체:

```js
// INSERT 컬럼 목록에 report_code 추가, VALUES 각 행 끝에 ,'11011'
// ON CONFLICT (stock_code, analysis_year) → ON CONFLICT (stock_code, analysis_year, report_code)
```

`populate-financials.js`도 같은 패턴이면 동일 수정.

- [ ] **Step 4: dart-financials-backfill.js 재사용 export 추가**

```js
// 변경: 시그니처에 reprtCode 추가 + export
export async function getMultiFinancials(corpCodes, year, fsdiv, reprtCode = "11011") {
  // ...기존 코드에서 url.searchParams.set("reprt_code", reprtCode); 로 교체
}
export async function fetchYearFinancials(corpCodes, year, reprtCode = "11011") { /* reprtCode 전달 */ }
export async function buildCorpCodeMap() { /* 기존 그대로, export만 추가 */ }
export async function loadCompanies() { /* 기존 그대로, export만 추가 */ }
export { dbQuery };
```

- [ ] **Step 5: 마이그레이션 실행 + 검증**

```bash
node run-migration.mjs migration-v6.sql
```
검증 쿼리(run-migration으로 임시 SQL 파일 또는 mcp/dbQuery): `SELECT column_name FROM information_schema.columns WHERE table_name='stock_financials' AND column_name IN ('rcept_dt','report_code','quarter')` → 3행.

- [ ] **Step 6: 문법 체크 + Commit**

```bash
npm run check
git add migration-v6.sql run-migration.mjs dart-financials-backfill.js populate-financials.js
git commit -m "feat: stock_financials PIT 컬럼·분기 유니크 + factor_ic_history·portfolio_positions 테이블"
```

---

### Task 3: rcept_dt 백필 — 연간 재무 공시일 채우기

**Files:**
- Create: `C:\claudeT\files\rcept-backfill.js`

- [ ] **Step 1: rcept-backfill.js 작성**

핵심: `fnlttMultiAcnt` 응답 행의 `rcept_no.slice(0,8)`이 접수일. 연도별 100개 배치 ≈ 27콜/년.

```js
/**
 * rcept-backfill.js — stock_financials.rcept_dt 백필 (연간 11011)
 * 실행: node rcept-backfill.js --years 2023,2024,2025
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchYearFinancials, buildCorpCodeMap, loadCompanies, dbQuery } from "./dart-financials-backfill.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const args = process.argv.slice(2);
const yearsArg = args.find(a => a.startsWith("--years"))?.split("=")[1] ?? args[args.indexOf("--years") + 1];
const YEARS = yearsArg ? yearsArg.split(",").map(y => y.trim()) : ["2023", "2024", "2025"];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const companies = await loadCompanies();
  const byCorp = new Map(companies.map(c => [c.corp_code, c]));
  console.log(`대상 ${companies.length}개 기업 / 연도 ${YEARS.join(",")}`);

  for (const year of YEARS) {
    console.log(`\n[${year}] rcept_dt 수집...`);
    const updates = new Map(); // stock_code -> rcept_dt
    for (let i = 0; i < companies.length; i += 100) {
      const batch = companies.slice(i, i + 100);
      const rows = await fetchYearFinancials(batch.map(c => c.corp_code), year);
      for (const r of rows) {
        const c = byCorp.get(r.corp_code);
        if (!c || !r.rcept_no) continue;
        const dt = String(r.rcept_no).slice(0, 8);
        if (/^\d{8}$/.test(dt)) updates.set(c.stock_code, dt);
      }
      process.stdout.write(`\r  배치 ${Math.min(i + 100, companies.length)}/${companies.length} (확보 ${updates.size})`);
      await sleep(300);
    }
    console.log("");
    // 배치 UPDATE
    const entries = [...updates.entries()];
    for (let i = 0; i < entries.length; i += 500) {
      const vals = entries.slice(i, i + 500)
        .filter(([code]) => /^[A-Za-z0-9]{5,6}$/.test(code))
        .map(([code, dt]) => `('${code}','${dt}')`).join(",");
      if (!vals) continue;
      await dbQuery(`
        UPDATE stock_financials sf SET rcept_dt = v.dt
        FROM (VALUES ${vals}) AS v(stock_code, dt)
        WHERE sf.stock_code = v.stock_code
          AND sf.analysis_year = ${Number(year)}
          AND sf.report_code = '11011'
      `);
    }
    console.log(`  ✅ [${year}] ${entries.length}건 rcept_dt 업데이트`);
  }
  const left = await dbQuery(`SELECT analysis_year, COUNT(*) cnt FROM stock_financials WHERE report_code='11011' AND rcept_dt IS NULL GROUP BY 1 ORDER BY 1`);
  console.log("\n잔여 NULL:", JSON.stringify(left));
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 실행**

```bash
node rcept-backfill.js --years 2023,2024,2025
```
Expected: 연도별 ~2,500건 내외 업데이트, 잔여 NULL 소수(상폐·미제출). 잔여는 백테스트에서 `estimateRceptDt` 폴백 처리.

- [ ] **Step 3: Commit**

```bash
git add rcept-backfill.js
git commit -m "feat: DART rcept_no 기반 연간 재무 rcept_dt 백필 스크립트"
```

---

### Task 4: 분기 재무 백필 — earningsMomentum 데이터

**Files:**
- Create: `C:\claudeT\files\dart-quarterly-backfill.js`

- [ ] **Step 1: 스크립트 작성**

분기보고서의 `thstrm_add_amount`(당기 누적) vs `frmtrm_add_amount`(전년동기 누적)로 YoY 산출(`factors.js quarterlyYoY` 재사용) 후 분기 행 upsert.

```js
/**
 * dart-quarterly-backfill.js — 분기/반기 재무 적재 (report_code 11013/11012/11014)
 * 실행: node dart-quarterly-backfill.js --periods 2025:11013,2025:11012,2025:11014,2026:11013
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchYearFinancials, loadCompanies, dbQuery } from "./dart-financials-backfill.js";
import { quarterlyYoY } from "./factors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const QUARTER_OF = { "11013": 1, "11012": 2, "11014": 3 };
const args = process.argv.slice(2);
const periodsArg = args.find(a => a.startsWith("--periods"))?.split("=")[1] ?? args[args.indexOf("--periods") + 1];
const PERIODS = (periodsArg ?? "2025:11013,2025:11012,2025:11014,2026:11013")
  .split(",").map(p => { const [y, rc] = p.trim().split(":"); return { year: y, reprtCode: rc }; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const numAmt = v => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) && n !== 0 ? n : null; };
const esc = v => v == null ? "NULL" : typeof v === "number" ? (Number.isFinite(v) ? String(v) : "NULL") : `'${String(v).replace(/'/g, "''")}'`;

function pickAccount(rows, names, useAdd) {
  for (const nm of names) {
    const row = rows.find(r => r.sj_div !== "CF" && r.account_nm?.replace(/\s/g, "") === nm.replace(/\s/g, ""));
    if (row) {
      const cur = numAmt(useAdd ? (row.thstrm_add_amount ?? row.thstrm_amount) : row.thstrm_amount);
      const prv = numAmt(useAdd ? (row.frmtrm_add_amount ?? row.frmtrm_amount) : row.frmtrm_amount);
      return { cur, prv };
    }
  }
  return { cur: null, prv: null };
}

async function main() {
  const companies = await loadCompanies();
  const byCorp = new Map(companies.map(c => [c.corp_code, c]));

  for (const { year, reprtCode } of PERIODS) {
    const quarter = QUARTER_OF[reprtCode];
    console.log(`\n[${year} Q-rep ${reprtCode} (분기 ${quarter})] 수집...`);
    const records = [];
    for (let i = 0; i < companies.length; i += 100) {
      const batch = companies.slice(i, i + 100);
      const rows = await fetchYearFinancials(batch.map(c => c.corp_code), year, reprtCode);
      const grouped = {};
      for (const r of rows) (grouped[r.corp_code] ??= []).push(r);
      for (const [corpCode, list] of Object.entries(grouped)) {
        const c = byCorp.get(corpCode);
        if (!c) continue;
        const op  = pickAccount(list, ["영업이익", "영업이익(손실)"], true);
        const rev = pickAccount(list, ["매출액", "영업수익", "수익(매출액)", "매출"], true);
        const rceptDt = list[0]?.rcept_no ? String(list[0].rcept_no).slice(0, 8) : null;
        records.push({
          stock_code: c.stock_code, corp_name: c.corp_name, mrkt_ctg: c.mrkt_ctg,
          analysis_year: Number(year), report_code: reprtCode, quarter,
          rcept_dt: rceptDt,
          op_income: op.cur, revenue: rev.cur,
          op_income_yoy: op.cur != null && op.prv != null ? +quarterlyYoY(op.cur, op.prv)?.toFixed(1) || null : null,
          revenue_yoy:   rev.cur != null && rev.prv != null && rev.prv > 0 ? +((rev.cur - rev.prv) / rev.prv * 100).toFixed(1) : null,
        });
      }
      process.stdout.write(`\r  배치 ${Math.min(i + 100, companies.length)}/${companies.length} (확보 ${records.length})`);
      await sleep(300);
    }
    console.log("");
    for (let i = 0; i < records.length; i += 500) {
      const vals = records.slice(i, i + 500).map(r =>
        `(${esc(r.stock_code)},${esc(r.corp_name)},${esc(r.mrkt_ctg)},${r.analysis_year},${esc(r.report_code)},${r.quarter},` +
        `${esc(r.rcept_dt)},${esc(r.op_income)},${esc(r.revenue)},${esc(r.op_income_yoy)},${esc(r.revenue_yoy)},NOW())`
      ).join(",\n");
      await dbQuery(`
        INSERT INTO stock_financials
          (stock_code,corp_name,mrkt_ctg,analysis_year,report_code,quarter,rcept_dt,op_income,revenue,op_income_yoy,revenue_yoy,updated_at)
        VALUES ${vals}
        ON CONFLICT (stock_code, analysis_year, report_code) DO UPDATE SET
          rcept_dt = EXCLUDED.rcept_dt, quarter = EXCLUDED.quarter,
          op_income = EXCLUDED.op_income, revenue = EXCLUDED.revenue,
          op_income_yoy = EXCLUDED.op_income_yoy, revenue_yoy = EXCLUDED.revenue_yoy,
          updated_at = NOW()
      `);
    }
    console.log(`  ✅ ${records.length}건 upsert`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 실행** — `node dart-quarterly-backfill.js` (기본 4개 기간, ~110콜, 수 분)

- [ ] **Step 3: Commit** — `git add dart-quarterly-backfill.js && git commit -m "feat: DART 분기 재무 백필 — 누적 YoY 어닝모멘텀 데이터"`

---

### Task 5: backtest-pit.mjs PIT 재작성 (핵심)

**Files:**
- Modify: `C:\claudeT\files\backtest-pit.mjs`
- Modify: `C:\claudeT\files\config.js` (`BACKTEST_ROUND_TRIP_COST` 추가)

변경 요점:
1. 연간 재무를 2023/2024/2025 모두 적재(+`rcept_dt`,`analysis_year`,`net_income`,`total_equity`) → 시점 T마다 `latestFinancialAsOf`
2. value 팩터는 DB의 stale per/pbr 대신 **PIT 시총으로 직접 계산**: `sharesProxy = market_cap_now / price_now`, `mcap_T = sharesProxy × close_T` → `ey = net_income/mcap_T`, `by = total_equity/mcap_T`
3. 분기 행 적재 → `earningsMomentum` = T 시점 최신 분기 `op_income_yoy`
4. `hasExtremeGap` 가드: 모멘텀 구간 갭 → 종목 제외, 포워드 구간 갭 → 해당 호라이즌 관측 제외
5. 동전주(`close < 1000`) 제외
6. 분위 스프레드 gross/net(왕복비용 차감) 병기
7. `--save-ic` 플래그 → `factor_ic_history` upsert

- [ ] **Step 1: config.js에 상수 추가**

```js
export const BACKTEST_ROUND_TRIP_COST = 0.005; // 왕복 거래비용 0.5% (수수료+거래세+슬리피지 보수 추정)
export const BACKTEST_MIN_PRICE = 1000;        // 동전주 제외 (유동성·슬리피지 방어)
```

- [ ] **Step 2: backtest-pit.mjs 수정** — 기존 구조 유지, 아래 부분 교체:

```js
// import 추가
import { spearmanIC, quantileSpread, latestFinancialAsOf, estimateRceptDt, hasExtremeGap } from "./backtest.js";
import { FACTOR_WEIGHTS, BACKTEST_ROUND_TRIP_COST, BACKTEST_MIN_PRICE } from "./config.js";

// loadUniverse() 교체: 다년도 연간 + 분기 행 + 현재 시총(주식수 프록시)
async function loadUniverse() {
  const all = [];
  const PAGE = 1000;
  for (let off = 0; ; off += PAGE) {
    const rows = await dbSelect("stock_analysis",
      `select=stock_code,corp_name,sector,mrkt_ctg,current_price,market_cap_tril&order=stock_code&limit=${PAGE}&offset=${off}`);
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  // 연간 재무 (2023~2025) — PIT 선택용
  const fins = [];
  for (let off = 0; ; off += PAGE) {
    const rows = await dbSelect("stock_financials",
      `select=stock_code,analysis_year,rcept_dt,report_code,per,pbr,roe,debt_ratio,cur_ratio,cf_ops,revenue_yoy,op_income_yoy,net_income,total_equity` +
      `&analysis_year=in.(2023,2024,2025)&report_code=eq.11011&order=stock_code&limit=${PAGE}&offset=${off}`);
    fins.push(...rows);
    if (rows.length < PAGE) break;
  }
  const finMap = new Map();
  for (const f of fins) {
    f.rcept_dt = f.rcept_dt ?? estimateRceptDt(f.analysis_year, "11011"); // 폴백
    (finMap.get(f.stock_code) ?? finMap.set(f.stock_code, []).get(f.stock_code)).push(f);
  }
  // 분기 재무 — earningsMomentum
  const qfins = [];
  for (let off = 0; ; off += PAGE) {
    const rows = await dbSelect("stock_financials",
      `select=stock_code,analysis_year,rcept_dt,report_code,quarter,op_income_yoy` +
      `&report_code=in.(11012,11013,11014)&order=stock_code&limit=${PAGE}&offset=${off}`);
    qfins.push(...rows);
    if (rows.length < PAGE) break;
  }
  const qMap = new Map();
  for (const f of qfins) {
    f.rcept_dt = f.rcept_dt ?? estimateRceptDt(f.analysis_year, f.report_code);
    (qMap.get(f.stock_code) ?? qMap.set(f.stock_code, []).get(f.stock_code)).push(f);
  }
  return all
    .filter(s => s.sector && finMap.has(s.stock_code))
    .map(s => ({
      ...s,
      finRows: finMap.get(s.stock_code),
      qRows: qMap.get(s.stock_code) ?? [],
      sharesProxy: s.current_price > 0 && s.market_cap_tril > 0
        ? (s.market_cap_tril * 1e12) / s.current_price : null,
    }));
}

// fundamentalFactors 교체: PIT fin 행 + T시점 시총으로 직접 계산
function fundamentalFactors(fin, mcapT) {
  if (!fin) return { value: null, quality: null, growth: null };
  const ni = Number(fin.net_income), eq = Number(fin.total_equity);
  const ey = Number.isFinite(ni) && ni > 0 && mcapT > 0 ? ni / mcapT : null;
  const by = Number.isFinite(eq) && eq > 0 && mcapT > 0 ? eq / mcapT : null;
  const value = ey != null && by != null ? (ey + by) / 2 : (ey ?? by);
  const roe = Number.isFinite(Number(fin.roe)) ? Number(fin.roe) : null;
  const debtPenalty = Number.isFinite(Number(fin.debt_ratio)) ? -Number(fin.debt_ratio) : null;
  const cur = Number.isFinite(Number(fin.cur_ratio)) ? Number(fin.cur_ratio) : null;
  const cf = Number.isFinite(Number(fin.cf_ops)) ? (Number(fin.cf_ops) > 0 ? 1 : 0) : null;
  const qParts = [roe, debtPenalty, cur, cf == null ? null : cf * 100].filter(v => v != null);
  const quality = qParts.length ? qParts.reduce((a, b) => a + b, 0) / qParts.length : null;
  const rg = Number.isFinite(Number(fin.revenue_yoy)) ? Number(fin.revenue_yoy) : null;
  const og = Number.isFinite(Number(fin.op_income_yoy)) ? Number(fin.op_income_yoy) : null;
  const gParts = [rg, og].filter(v => v != null);
  const growth = gParts.length ? gParts.reduce((a, b) => a + b, 0) / gParts.length : null;
  return { value, quality, growth };
}

// 리밸런스 루프 내부 교체 (rows 구성부)
const FACTOR_KEYS = ["value", "quality", "growth", "earningsMomentum", "priceMomentum", "trend"];
// ...
for (const s of active) {
  const hist = priceCache[s.stock_code];
  const i = indexOfDate(hist, T);
  if (i < 0 || i < maxMom) continue;
  const cT = hist[i].close;
  if (cT < BACKTEST_MIN_PRICE) continue;                       // 동전주 제외
  const closes = histCloses[s.stock_code];                     // 사전 계산된 close 배열
  if (hasExtremeGap(closes, i - maxMom, i)) continue;          // 모멘텀 구간 corporate action

  // PIT 재무 선택 (T는 'YYYYMMDD')
  const fin = latestFinancialAsOf(s.finRows, T);
  const mcapT = s.sharesProxy != null ? s.sharesProxy * cT : null;
  const f = fundamentalFactors(fin, mcapT);
  const qFin = latestFinancialAsOf(s.qRows, T);
  const earningsMomentum = qFin && Number.isFinite(Number(qFin.op_income_yoy)) ? Number(qFin.op_income_yoy) : null;

  // (가격 모멘텀/추세/sma 계산은 기존 그대로)
  const fwd = {};
  for (const h of HORIZONS) {
    if (i + h >= hist.length) { fwd[h] = null; continue; }
    fwd[h] = hasExtremeGap(closes, i, i + h) ? null : hist[i + h].close / cT - 1; // 포워드 구간 갭 제외
  }
  rows.push({ stock_code: s.stock_code, sector: s.sector, ...f, earningsMomentum, priceMomentum, trend, fwd });
}
```

histCloses 사전 계산(메인 시작부, priceCache 적재 직후):

```js
const histCloses = {};
for (const code of Object.keys(priceCache)) histCloses[code] = priceCache[code].map(r => r.close);
```

리포트부: 분위 스프레드 net 병기 + `--save-ic`:

```js
console.log(`  분위 스프레드   gross ${pct(avg(ph.spread))} | net(왕복 ${BACKTEST_ROUND_TRIP_COST*100}%) ${pct(avg(ph.spread) - BACKTEST_ROUND_TRIP_COST)}`);

// --save-ic
if (process.argv.includes("--save-ic")) {
  const rows = [];
  const runDate = new Date().toISOString().slice(0, 10);
  for (const h of HORIZONS) {
    const ph = perHorizon[h];
    rows.push({ run_date: runDate, horizon: h, factor: "composite", ic: avg(ph.ic), ic_pos_rate: posRate(ph.ic), n_obs: ph.ic.length, period_begin: BEGIN, period_end: END });
    for (const k of FACTOR_KEYS)
      rows.push({ run_date: runDate, horizon: h, factor: k, ic: avg(ph.factorIC[k]), ic_pos_rate: posRate(ph.factorIC[k]), n_obs: ph.factorIC[k].length, period_begin: BEGIN, period_end: END });
  }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/factor_ic_history?on_conflict=run_date,horizon,factor`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows.map(x => ({ ...x, ic: Number.isFinite(x.ic) ? +x.ic.toFixed(4) : null, ic_pos_rate: Number.isFinite(x.ic_pos_rate) ? +x.ic_pos_rate.toFixed(3) : null }))),
  });
  console.log(r.ok ? `\n[factor_ic_history] ${rows.length}행 저장` : `\n[factor_ic_history] 저장 실패 ${r.status}`);
}
```

- [ ] **Step 3: 문법 체크 + 골든 테스트**

```bash
npm run check && npm test
```
Expected: PASS (백테스트 자체는 DB 필요 — Task 9에서 실행).

- [ ] **Step 4: Commit**

```bash
git add backtest-pit.mjs config.js
git commit -m "feat: backtest-pit PIT 재무 선택 + corporate action 가드 + 비용 차감 + IC 이력 저장"
```

---

### Task 6: 포트폴리오 원장 — portfolio.js

**Files:**
- Create: `C:\claudeT\files\portfolio.js`
- Test: `C:\claudeT\files\tests\portfolio.test.js`
- Modify: `C:\claudeT\files\config.js`, `C:\claudeT\files\daily-ranking.js` (알림 통합)

- [ ] **Step 1: 실패 테스트 작성** — `tests/portfolio.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { evalPosition } from '../portfolio.js';

test('evalPosition: -25% 이하 → stop_loss', () => {
  assert.deepEqual(evalPosition(10000, 7500, 'open'), { ret: -25, action: 'stop_loss' });
  assert.equal(evalPosition(10000, 7600, 'open').action, 'hold');
});

test('evalPosition: +100% 이상 & open → half_profit (이미 half_exited면 hold)', () => {
  assert.deepEqual(evalPosition(10000, 20000, 'open'), { ret: 100, action: 'half_profit' });
  assert.equal(evalPosition(10000, 20000, 'half_exited').action, 'hold');
  assert.equal(evalPosition(10000, 6000, 'half_exited').action, 'stop_loss'); // 스톱은 상태 무관
});

test('evalPosition: 비정상 입력 → null', () => {
  assert.equal(evalPosition(0, 100, 'open'), null);
  assert.equal(evalPosition(100, null, 'open'), null);
});
```

- [ ] **Step 2: 실패 확인** — `npm test` → FAIL.

- [ ] **Step 3: config.js 상수 + portfolio.js 구현**

config.js:
```js
export const STOP_LOSS_PCT = -25;   // 즉시청산
export const HALF_PROFIT_PCT = 100; // 절반익절
```

portfolio.js:
```js
/**
 * portfolio.js — 포트폴리오 원장 (portfolio_positions)
 * node portfolio.js enter 005930 [--weight 10] [--price 60000]
 * node portfolio.js check | report | close 005930 [--reason manual] [--price 60000]
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STOP_LOSS_PCT, HALF_PROFIT_PCT } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

// ── 순수 로직 ──
export function evalPosition(entryPrice, currentPrice, status) {
  if (!(entryPrice > 0) || !(currentPrice > 0)) return null;
  const ret = +((currentPrice / entryPrice - 1) * 100).toFixed(2);
  if (ret <= STOP_LOSS_PCT) return { ret, action: "stop_loss" };
  if (ret >= HALF_PROFIT_PCT && status === "open") return { ret, action: "half_profit" };
  return { ret, action: "hold" };
}

// ── IO ──
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
const H = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });

async function rest(pathQ, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathQ}`, { headers: H(), ...opts, headers: { ...H(), ...(opts.headers ?? {}) } });
  if (!r.ok) throw new Error(`${pathQ}: HTTP ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function currentPriceOf(code) {
  const rows = await rest(`stock_analysis?stock_code=eq.${code}&select=corp_name,current_price`);
  return rows[0] ?? null;
}

export async function checkOpenPositions() {
  const open = await rest(`portfolio_positions?status=neq.closed&select=*`);
  const results = [];
  for (const p of open) {
    const cur = await currentPriceOf(p.stock_code);
    if (!cur) continue;
    const ev = evalPosition(Number(p.entry_price), Number(cur.current_price), p.status);
    if (ev) results.push({ ...p, current_price: cur.current_price, ...ev });
  }
  return results;
}

function printCheck(results) {
  if (!results.length) { console.log("[포트폴리오] 보유 포지션 없음"); return; }
  console.log("\n========== 포트폴리오 점검 ==========");
  console.log("종목명            코드    진입가      현재가     수익률    상태         조치");
  for (const r of results) {
    const act = r.action === "stop_loss" ? "🔴 스톱로스 청산!" : r.action === "half_profit" ? "🟢 절반 익절!" : "—";
    console.log(`${(r.corp_name ?? "").slice(0, 12).padEnd(14)} ${r.stock_code}  ${String(r.entry_price).padStart(8)}  ${String(r.current_price).padStart(8)}  ${String(r.ret + "%").padStart(8)}  ${r.status.padEnd(12)} ${act}`);
  }
}

async function main() {
  const [cmd, code] = process.argv.slice(2);
  const argVal = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

  if (cmd === "enter") {
    const cur = await currentPriceOf(code);
    if (!cur && !argVal("--price")) throw new Error(`${code}: stock_analysis에 없음 — --price 필수`);
    const price = Number(argVal("--price") ?? cur.current_price);
    await rest(`portfolio_positions`, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ stock_code: code, corp_name: cur?.corp_name ?? null, entry_price: price, weight_pct: Number(argVal("--weight") ?? 5) }),
    });
    console.log(`✅ 진입 기록: ${code} @ ${price.toLocaleString()}원`);
  } else if (cmd === "check") {
    printCheck(await checkOpenPositions());
  } else if (cmd === "close") {
    const cur = await currentPriceOf(code);
    const price = Number(argVal("--price") ?? cur?.current_price ?? 0);
    await rest(`portfolio_positions?stock_code=eq.${code}&status=neq.closed`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "closed", exit_date: new Date().toISOString().slice(0, 10), exit_price: price, exit_reason: argVal("--reason") ?? "manual" }),
    });
    console.log(`✅ 청산 기록: ${code} @ ${price.toLocaleString()}원`);
  } else if (cmd === "report") {
    const all = await rest(`portfolio_positions?select=*&order=entry_date`);
    let wRet = 0, wSum = 0;
    for (const p of all) {
      const px = p.status === "closed" ? Number(p.exit_price) : Number((await currentPriceOf(p.stock_code))?.current_price ?? 0);
      const ret = p.entry_price > 0 && px > 0 ? (px / p.entry_price - 1) * 100 : null;
      if (ret != null) { wRet += ret * Number(p.weight_pct); wSum += Number(p.weight_pct); }
      console.log(`${p.status === "closed" ? "✔" : "●"} ${(p.corp_name ?? "").padEnd(12)} ${p.stock_code} ${p.entry_date} ${String(p.entry_price).padStart(8)} → ${String(px).padStart(8)} (${ret?.toFixed(1) ?? "-"}%) ${p.exit_reason ?? ""}`);
    }
    if (wSum > 0) console.log(`\n가중 평균 수익률: ${(wRet / wSum).toFixed(2)}%`);
  } else {
    console.log("사용법: node portfolio.js enter <code> [--weight N] [--price P] | check | close <code> | report");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error("[오류]", e.message); process.exit(1); });
}
```

- [ ] **Step 4: 테스트 통과 확인** — `npm test` → PASS.

- [ ] **Step 5: daily-ranking.js main()에 알림 통합** — `printChangeReport()` 호출 다음에:

```js
// 포트폴리오 스톱로스/익절 점검 (포지션 있을 때만 출력)
try {
  const { checkOpenPositions } = await import("./portfolio.js");
  const positions = await checkOpenPositions();
  const alerts = positions.filter(p => p.action !== "hold");
  if (alerts.length) {
    console.log("\n⚠️  [포트폴리오 알림]");
    for (const a of alerts)
      console.log(`  ${a.action === "stop_loss" ? "🔴 스톱로스" : "🟢 절반익절"}: ${a.corp_name}(${a.stock_code}) ${a.ret}% — node portfolio.js close ${a.stock_code} --reason ${a.action}`);
  }
} catch (e) { console.log(`[포트폴리오 점검 생략] ${e.message}`); }
```

- [ ] **Step 6: Commit**

```bash
git add portfolio.js tests/portfolio.test.js config.js daily-ranking.js
git commit -m "feat: 포트폴리오 원장 — 진입/청산 기록 + 스톱로스·익절 자동 알림"
```

---

### Task 7: 라이브 스코어 v6 — daily-ranking.js

**Files:**
- Modify: `C:\claudeT\files\daily-ranking.js`

변경 목록 (`buildRankingsRefreshSql`):
1. **52주 위치 >70% 제외 하드필터 삭제** (안티-모멘텀 — 백테스트 증거와 모순)
2. **[가격 모멘텀 15pt] 신설** — `stock_prices` 60거래일 수익률
3. **가치 비중 절반**: PBR 20→10pt (10/8/6/3/1), PER 10→5pt (5/4/2/1)
4. JOIN에 `AND sf.report_code = '11011'` (분기 행 오염 방지) — `calcOpIncomeYoy`·`detectBigBathRecovery`의 stock_financials 참조 전부 동일 적용
5. `calcTargetByScore`·`getSectorMultiplier` 제거, 리포트에서 목표가 컬럼 삭제 (검증 안 된 휴리스틱)
6. 레짐 게이트 출력 라벨 "KODEX200" → "삼성전자(KOSPI 프록시)"

- [ ] **Step 1: 모멘텀 CTE + 스코어 수정** — `buildRankingsRefreshSql()`의 SQL:

```sql
WITH mom AS (
  SELECT stock_code,
         (MAX(CASE WHEN rn = 1  THEN close END)::NUMERIC
          / NULLIF(MAX(CASE WHEN rn = 60 THEN close END), 0) - 1) * 100 AS ret60
  FROM (
    SELECT stock_code, close,
           ROW_NUMBER() OVER (PARTITION BY stock_code ORDER BY date DESC) AS rn
    FROM stock_prices
  ) t
  WHERE rn IN (1, 60)
  GROUP BY stock_code
),
scored AS (
  SELECT
    ... (기존 SELECT 목록 유지, m.ret60 추가) ...
    ROUND((
      -- [PBR 할인 10pt] (v6: 20→10 — PIT 백테스트에서 value 역방향 증거)
      CASE
        WHEN sf.pbr IS NULL OR ss.avg_pbr IS NULL OR ss.avg_pbr = 0 THEN 0
        WHEN sf.pbr <= ss.avg_pbr * 0.3  THEN 10
        WHEN sf.pbr <= ss.avg_pbr * 0.5  THEN 8
        WHEN sf.pbr <= ss.avg_pbr * 0.7  THEN 6
        WHEN sf.pbr <= ss.avg_pbr * 0.9  THEN 3
        WHEN sf.pbr <= ss.avg_pbr        THEN 1
        ELSE 0
      END
      -- [PER 할인 5pt] (v6: 10→5)
      + CASE
        WHEN sf.per IS NULL OR ss.avg_per IS NULL OR ss.avg_per = 0 OR sf.per <= 0 THEN 0
        WHEN sf.per <= ss.avg_per * 0.3  THEN 5
        WHEN sf.per <= ss.avg_per * 0.5  THEN 4
        WHEN sf.per <= ss.avg_per * 0.7  THEN 2
        WHEN sf.per <= ss.avg_per        THEN 1
        ELSE 0
      END
      -- [가격 모멘텀 15pt] (v6 신설 — 60거래일 수익률, NULL은 중립 5)
      + CASE
        WHEN m.ret60 IS NULL    THEN 5
        WHEN m.ret60 >= 30      THEN 15
        WHEN m.ret60 >= 15      THEN 12
        WHEN m.ret60 >= 5       THEN 8
        WHEN m.ret60 >= 0       THEN 5
        WHEN m.ret60 >= -10     THEN 2
        ELSE 0
      END
      -- [PCR 10pt] / [ROE 15pt] / [영업이익률 10pt] / [이익추세 15pt] / [이익YoY 15pt]
      -- [이익안정성 5pt] / [부채 페널티] / [이자보상 페널티] : 기존 그대로
      ...
    ...
  FROM stock_analysis sa
  JOIN stock_financials sf ON sa.stock_code = sf.stock_code
       AND sf.analysis_year = ${YEAR} AND sf.report_code = '11011'
  LEFT JOIN sector_stats ss ON sa.sector = ss.sector AND sa.mrkt_ctg = ss.mrkt_ctg
  LEFT JOIN mom m ON m.stock_code = sa.stock_code
  WHERE ... (기존 하드필터 유지하되 아래 블록 삭제:)
    -- ❌ 삭제: 52주 위치 70% 초과 제거 필터
)
```

- [ ] **Step 2: report_code 필터 전수 적용**

`calcOpIncomeYoy`의 f25/f24/f23 모두 `AND fXX.report_code = '11011'`, remaining 카운트 쿼리도 동일. `detectBigBathRecovery`의 sf25/sf24 JOIN도 동일.

- [ ] **Step 3: 목표가 제거 + 라벨 수정**

- `getSectorMultiplier`, `calcTargetByScore` 함수 삭제.
- `printChangeReport`: 헤더/행에서 1M/3M/1Y 목표 컬럼 삭제 → `PBR  PER  점수  비중` 형태로 단순화.
- 레짐 게이트 출력 두 곳: `KODEX200:` → `삼성전자(KOSPI 프록시):`.

- [ ] **Step 4: 검증**

```bash
npm run check && npm test
node daily-ranking.js --skip-price
```
Expected: 랭킹 정상 산출(건수 v5 대비 증가 — 52주 필터 제거분), 목표가 컬럼 없음, 라벨 수정 확인.

- [ ] **Step 5: Commit**

```bash
git add daily-ranking.js
git commit -m "feat: 스코어링 v6 — 가격모멘텀 15pt 신설·안티모멘텀 필터 제거·value 비중 절반·미검증 목표가 제거"
```

---

### Task 8: 회귀 방지 — project-contract 테스트 보강

**Files:**
- Modify: `C:\claudeT\files\tests\project-contract.test.js` (스타일 확인 후 동일 패턴 추가)

- [ ] **Step 1: 계약 테스트 추가** — daily-ranking.js 소스를 읽어 다음을 정적으로 검증:

```js
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../daily-ranking.js', import.meta.url), 'utf8');

test('contract: 랭킹 SQL은 연간 행만 사용 (report_code 11011)', () => {
  assert.ok(src.includes("report_code = '11011'"), "stock_financials JOIN에 report_code 필터 필요");
});
test('contract: 안티모멘텀 52주 하드필터 제거 유지', () => {
  assert.ok(!src.includes('< 0.7'), '52주 위치 0.7 하드필터가 부활하면 안 됨');
});
test('contract: 미검증 목표가 휴리스틱 미사용', () => {
  assert.ok(!src.includes('calcTargetByScore'), '점수 기반 목표가는 백테스트 미검증으로 제거됨');
});
```

- [ ] **Step 2: `npm test` PASS 확인 후 Commit**

```bash
git add tests/project-contract.test.js
git commit -m "test: v6 계약 테스트 — report_code 필터·안티모멘텀 필터 제거·목표가 미사용 고정"
```

---

### Task 9: 실행 & 재캘리브레이션 (Loop B)

**Files:**
- Modify: `C:\claudeT\files\config.js` (FACTOR_WEIGHTS — 측정값으로)
- Modify: `C:\claudeT\files\README.md` (점수식·운영 절차 갱신)

- [ ] **Step 1: PIT 백테스트 실행**

```bash
node backtest-pit.mjs --save-ic 2>&1 | tee backtest-pit-v2.log
```
Expected: 호라이즌별 팩터 IC 출력 + factor_ic_history 저장. **growth IC>0 비율이 100%에서 내려오면 누수 제거가 작동한 것.**

- [ ] **Step 2: FACTOR_WEIGHTS 기계적 재설정** — 규칙(자의성 제거):

```
w_k = clamp(round(mean(IC20_k, IC60_k), 2), -0.2, +0.2)
단, |w_k| < 0.01 → 0 (노이즈 컷)
```

config.js의 FACTOR_WEIGHTS를 측정값으로 교체하고 주석에 측정 기간·관측 횟수 기록. earningsMomentum도 이번부터 측정값 반영.

- [ ] **Step 3: 합성 IC 확인 재실행** — `node backtest-pit.mjs` → 합성 IC가 재가중 후 개선(>0)되는지 확인. 음수면 가중치만으론 부족 — 결과를 기록하고 다음 의사결정(팩터 제거)으로 넘긴다 (코드 버그 아님, SCORING_V2_SPEC §6 Loop B 원칙).

- [ ] **Step 4: README 갱신** — 점수식(v6), 신규 스크립트(rcept-backfill, dart-quarterly-backfill, portfolio, run-migration), 운영 절차(분기마다 quarterly backfill + backtest --save-ic) 반영.

- [ ] **Step 5: 최종 Commit**

```bash
git add config.js README.md backtest-pit-v2.log
git commit -m "chore: PIT 재측정 IC 기반 FACTOR_WEIGHTS 재캘리브레이션 + README v6"
```

---

## Self-Review 체크 결과

- **Spec coverage:** PIT 수정(Task 1,2,3,5) / 라이브 재배분(Task 7) / corporate action 가드(Task 1,5) / 분기 earningsMomentum(Task 4,5) / 포트폴리오 원장(Task 2,6) / rolling IC(Task 2,5,9) / 버그 수정(Task 7) — 전 항목 커버.
- **Placeholder:** Task 5의 "기존 그대로" 표기는 기존 파일에 실재하는 코드 참조(생략 아님), Task 7의 `...`는 변경 없는 기존 SQL 블록 참조 — 구현자는 해당 파일을 열어 그대로 둔다.
- **Type consistency:** `latestFinancialAsOf(rows, asOf)` — Task 1 정의·Task 5 사용 일치. `evalPosition(entry, current, status)` — Task 6 내 일치. `fetchYearFinancials(codes, year, reprtCode)` — Task 2 수정·Task 3/4 사용 일치.

## 실행 순서 의존성

```
Task 1 (순수함수) ─┐
Task 2 (마이그레이션) ─┬→ Task 3 (rcept 백필) ─┬→ Task 5 (백테스트) → Task 9 (실행·재캘리브레이션)
                      └→ Task 4 (분기 백필) ──┘
Task 6 (포트폴리오) — Task 2 이후 아무 때나
Task 7 (라이브 v6) — Task 2 이후 (report_code 필터 의존), Task 8이 뒤따름
```
