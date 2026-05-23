import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ANALYSIS_YEAR,
  ANALYSIS_YEAR_FALLBACK,
  SCORE_BATCH_SIZE,
  SCORE_DELAY_MS,
  TOP_STOCK_LIMIT,
  FETCH_TIMEOUT_MS,
  BATCH_TIMEOUT_MS,
} from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

test("project exposes npm scripts for the main workflows", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));

  assert.equal(pkg.scripts.start, "node mcp-server.js");
  assert.equal(pkg.scripts.batch, "node batch.js");
  assert.equal(pkg.scripts["score:kospi"], "node score-kospi-full.js");
  assert.equal(pkg.scripts["score:kosdaq"], "node score-kosdaq.js");
  assert.equal(pkg.scripts["score:top100"], "node score-top100.js");
  assert.equal(pkg.scripts["db:upsert"], "node db-upsert.js --both");
  assert.equal(pkg.scripts.check, "node scripts/check-syntax.js");
  assert.equal(pkg.scripts.test, "node --test tests/**/*.test.js");
});

test("runtime config has safe defaults for repeatable local runs", () => {
  assert.equal(ANALYSIS_YEAR, "2025");
  assert.equal(ANALYSIS_YEAR_FALLBACK, "2024");
  assert.equal(SCORE_BATCH_SIZE, 100);
  assert.equal(SCORE_DELAY_MS, 300);
  assert.equal(TOP_STOCK_LIMIT, 100);
  assert.equal(FETCH_TIMEOUT_MS, 10_000);
  assert.equal(BATCH_TIMEOUT_MS, 30_000);
});
