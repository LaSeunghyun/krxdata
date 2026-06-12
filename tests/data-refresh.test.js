import assert from "node:assert/strict";
import { test } from "node:test";

import { parseFinancials } from "../dart-financials-backfill.js";
import {
  buildRankingsRefreshSql,
  getMissingDailyRankingEnv,
  shouldRefresh52w,
  shouldRunPriceUpdate,
} from "../daily-ranking.js";

test("full mode always refreshes 52-week prices", () => {
  assert.equal(shouldRefresh52w([]), true);
  assert.equal(shouldRefresh52w(["--enable-recovery"]), true);
});

test("ranking-only mode keeps 52-week refresh off unless forced", () => {
  assert.equal(shouldRefresh52w(["--skip-price"]), false);
  assert.equal(shouldRefresh52w(["--skip-price", "--refresh-52w"]), true);
});

test("forced 52-week refresh still runs the price update step", () => {
  assert.equal(shouldRunPriceUpdate(["--skip-price"]), false);
  assert.equal(shouldRunPriceUpdate(["--skip-price", "--refresh-52w"]), true);
  assert.equal(shouldRunPriceUpdate([]), true);
});

test("financial parser maps finance-sector revenue aliases", () => {
  const parsed = parseFinancials([
    { sj_div: "IS", account_nm: "이자수익", thstrm_amount: "83,149,506,134", frmtrm_amount: "80,000,000,000", bfefrmtrm_amount: "70,000,000,000" },
    { sj_div: "IS", account_nm: "영업이익(손실)", thstrm_amount: "6,847,926,442", frmtrm_amount: "5,000,000,000", bfefrmtrm_amount: "4,000,000,000" },
    { sj_div: "BS", account_nm: "부채총계", thstrm_amount: "1,017,688,463,958", frmtrm_amount: "900,000,000,000", bfefrmtrm_amount: "800,000,000,000" },
    { sj_div: "BS", account_nm: "자본총계", thstrm_amount: "307,554,471,179", frmtrm_amount: "300,000,000,000", bfefrmtrm_amount: "290,000,000,000" },
  ]);

  assert.equal(parsed.revenue?.current, 83_149_506_134);
  assert.equal(parsed.opIncome?.current, 6_847_926_442);
  assert.equal(parsed.totalDebt?.current, 1_017_688_463_958);
});

test("daily-ranking env validation is explicit and import-safe", () => {
  const missing = getMissingDailyRankingEnv({});
  assert.deepEqual(missing, [
    "SUPABASE_URL",
    "SUPABASE_KEY(또는 SUPABASE_SERVICE_KEY)",
    "PUBLIC_DATA_API_KEY(또는 TOSS_CLIENT_ID/SECRET 짝)",
    "DART_API_KEY",
    "SUPABASE_MANAGEMENT_KEY",
    "SUPABASE_PROJECT_REF",
  ]);

  assert.deepEqual(getMissingDailyRankingEnv({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_KEY: "service-key",
    PUBLIC_DATA_API_KEY: "public-key",
    DART_API_KEY: "dart-key",
    SUPABASE_MANAGEMENT_KEY: "management-key",
    SUPABASE_PROJECT_REF: "project-ref",
  }), []);
});

test("toss credentials satisfy the price-source requirement without PUBLIC_DATA_API_KEY", () => {
  assert.deepEqual(getMissingDailyRankingEnv({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_KEY: "service-key",
    TOSS_CLIENT_ID: "c_test",
    TOSS_CLIENT_SECRET: "s_test",
    DART_API_KEY: "dart-key",
    SUPABASE_MANAGEMENT_KEY: "management-key",
    SUPABASE_PROJECT_REF: "project-ref",
  }), []);

  // TOSS_CLIENT_ID만 있으면(짝 미완성) 공공데이터 키가 여전히 필요
  assert.ok(getMissingDailyRankingEnv({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_KEY: "service-key",
    TOSS_CLIENT_ID: "c_test",
    DART_API_KEY: "dart-key",
    SUPABASE_MANAGEMENT_KEY: "management-key",
    SUPABASE_PROJECT_REF: "project-ref",
  }).some((k) => k.startsWith("PUBLIC_DATA_API_KEY")));
});

test("ranking refresh SQL upserts rows and removes stale rows in one statement", () => {
  const sql = buildRankingsRefreshSql();

  assert.match(sql, /WITH\s+mom\s+AS\s*\(/i);   // v6: 가격 모멘텀 CTE
  assert.match(sql, /,\s*scored\s+AS\s*\(/i);
  assert.match(sql, /upserted\s+AS\s*\(\s*INSERT\s+INTO\s+daily_rankings/i);
  assert.match(sql, /deleted\s+AS\s*\(\s*DELETE\s+FROM\s+daily_rankings\s+d/i);
  assert.match(sql, /NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+upserted\s+u/i);
  assert.match(sql, /SELECT\s+rank,\s*stock_code,\s*corp_name,\s*undervalue_score\s+FROM\s+upserted/i);
});
