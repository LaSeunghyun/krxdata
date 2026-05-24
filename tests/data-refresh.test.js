import assert from "node:assert/strict";
import { test } from "node:test";

import { parseFinancials } from "../dart-financials-backfill.js";
import { shouldRefresh52w, shouldRunPriceUpdate } from "../daily-ranking.js";

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
