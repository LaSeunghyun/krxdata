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

test("daily-ranking workflow passes required env to every ranking invocation", () => {
  const workflow = fs.readFileSync(
    path.join(projectRoot, ".github", "workflows", "daily-ranking.yml"),
    "utf8",
  );

  const requiredEnv = [
    "SUPABASE_URL",
    "SUPABASE_KEY",
    "PUBLIC_DATA_API_KEY",
    "DART_API_KEY",
    "SUPABASE_MANAGEMENT_KEY",
    "SUPABASE_PROJECT_REF",
  ];

  for (const stepName of [
    "Run price update + ranking (full mode)",
    "Run ranking only (ranking mode)",
    "Run backfill (backfill mode)",
  ]) {
    const start = workflow.indexOf(`- name: ${stepName}`);
    assert.notEqual(start, -1, `${stepName} step exists`);
    const next = workflow.indexOf("\n      - name:", start + 1);
    const block = workflow.slice(start, next === -1 ? workflow.length : next);

    assert.match(block, /node daily-ranking\.js/, `${stepName} invokes daily-ranking.js`);
    for (const key of requiredEnv) {
      assert.match(block, new RegExp(`${key}: \\$\\{\\{ secrets\\.${key} \\}\\}`), `${stepName} passes ${key}`);
    }
  }
});

// ── v6 회귀 방지 계약 ─────────────────────────────────────────
const dailyRankingSrc = fs.readFileSync(path.join(projectRoot, "daily-ranking.js"), "utf8");

test("contract: 랭킹 SQL은 연간 행만 사용 (report_code 11011)", () => {
  assert.ok(
    dailyRankingSrc.includes("sf.report_code = '11011'"),
    "stock_financials JOIN에 report_code='11011' 필터 필요 — 분기 행 오염 방지",
  );
});

test("contract: 안티모멘텀 52주 하드필터 제거 유지", () => {
  assert.ok(
    !/price_position[\s\S]*?< 0\.7|low_52w, 0\) < 0\.7/.test(dailyRankingSrc),
    "52주 위치 0.7 하드필터가 부활하면 안 됨 (백테스트 모멘텀 IC 양수와 모순)",
  );
});

test("contract: 미검증 목표가 휴리스틱 미사용", () => {
  assert.ok(
    !dailyRankingSrc.includes("function calcTargetByScore"),
    "점수 기반 목표가는 백테스트 미검증으로 제거됨",
  );
});

test("contract: 가격 모멘텀 컴포넌트 존재", () => {
  assert.ok(dailyRankingSrc.includes("ret60"), "v6 가격 모멘텀(ret60) 점수 컴포넌트 필요");
});
