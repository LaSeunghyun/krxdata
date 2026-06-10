import assert from "node:assert/strict";
import { test } from "node:test";

import {
  escapeSqlLiteral,
  parseFinancialYear,
  parseMarket,
  parseOptionalSqlText,
  parseRankingLimit,
} from "../mcp-input.js";

test("MCP market filters allow only supported markets", () => {
  assert.equal(parseMarket("KOSPI"), "KOSPI");
  assert.equal(parseMarket(" kosdaq "), "KOSDAQ");
  assert.equal(parseMarket(undefined), null);
  assert.throws(() => parseMarket("KONEX"), /market은 KOSPI 또는 KOSDAQ/);
});

test("MCP numeric inputs are bounded integers", () => {
  assert.equal(parseFinancialYear(undefined), 2024);
  assert.equal(parseFinancialYear("2025"), 2025);
  assert.throws(() => parseFinancialYear("2025;DROP"), /year는 2000~2100 사이/);

  assert.equal(parseRankingLimit(undefined), 20);
  assert.equal(parseRankingLimit("7"), 7);
  assert.equal(parseRankingLimit(500), 100);
  assert.throws(() => parseRankingLimit(0), /top은 1~100 사이/);
});

test("MCP free-text filters are escaped before SQL interpolation", () => {
  assert.equal(escapeSqlLiteral("O'Reilly"), "O''Reilly");
  assert.equal(parseOptionalSqlText(" 반도체·전자부품 "), "반도체·전자부품");
  assert.equal(parseOptionalSqlText("x' OR '1'='1"), "x'' OR ''1''=''1");
  assert.throws(() => parseOptionalSqlText("a".repeat(101)), /100자 이하/);
});
