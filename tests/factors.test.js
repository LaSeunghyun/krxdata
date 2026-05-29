import test from 'node:test';
import assert from 'node:assert/strict';
import { valueFactors, qualityFactors, quarterlyYoY, sameQuarterYoY } from '../factors.js';

test('valueFactors: PER/PBR 정상', () => {
  const fin = { netIncome: { current: 100 }, totalEquity: { current: 500 } };
  assert.deepEqual(valueFactors(fin, 1000), { per: 10, pbr: 2 });
});

test('valueFactors: 자본잠식 → pbr null', () => {
  const fin = { netIncome: { current: 100 }, totalEquity: { current: -50 } };
  assert.equal(valueFactors(fin, 1000).pbr, null);
});

test('valueFactors: 적자 → per null', () => {
  const fin = { netIncome: { current: -10 }, totalEquity: { current: 500 } };
  assert.equal(valueFactors(fin, 1000).per, null);
});

test('valueFactors: 시총0 → 둘다 null', () => {
  const fin = { netIncome: { current: 100 }, totalEquity: { current: 500 } };
  assert.deepEqual(valueFactors(fin, 0), { per: null, pbr: null });
});

test('qualityFactors: 정상값', () => {
  const fin = {
    netIncome: { current: 100 }, totalEquity: { current: 500 },
    totalDebt: { current: 300 }, curAsset: { current: 200 }, curLiab: { current: 100 },
    cfOps: 5,
  };
  const q = qualityFactors(fin);
  assert.equal(q.roe, 20);
  assert.equal(q.debtRatio, 60);  // 300/500*100
  assert.equal(q.curRatio, 200);
  assert.equal(q.cfPositive, 1);
});

test('qualityFactors: 자본잠식 → roe·debtRatio null', () => {
  const fin = {
    netIncome: { current: 100 }, totalEquity: { current: -10 },
    totalDebt: { current: 300 }, curAsset: { current: 200 }, curLiab: { current: 0 },
    cfOps: -3,
  };
  const q = qualityFactors(fin);
  assert.equal(q.roe, null);
  assert.equal(q.debtRatio, null);
  assert.equal(q.curRatio, null);  // curLiab 0
  assert.equal(q.cfPositive, 0);
});

test('qualityFactors: cfOps null → cfPositive null', () => {
  const fin = { cfOps: null };
  assert.equal(qualityFactors(fin).cfPositive, null);
});

test('quarterlyYoY: 표준/흑자전환/분모0/적자', () => {
  assert.equal(quarterlyYoY(120, 100), 20);
  assert.equal(quarterlyYoY(50, -10), 999);   // 흑자전환
  assert.equal(quarterlyYoY(50, 0), null);     // 분모 0
  assert.equal(quarterlyYoY(-5, -10), 50);     // 적자축소
  assert.equal(quarterlyYoY(-15, -10), -50);   // 적자확대
});

test('sameQuarterYoY: 전년 동분기 비교 (직전분기 무시 — 계절성 제거)', () => {
  const rows = [
    { year: 2026, quarter: 1, value: 120 },
    { year: 2025, quarter: 1, value: 100 },
    { year: 2025, quarter: 4, value: 200 }, // 직전분기 — 절대 짝지으면 안 됨
  ];
  assert.deepEqual(sameQuarterYoY(rows), { current: 120, yearAgo: 100 });
});

test('sameQuarterYoY: 전년 동분기 없으면 null', () => {
  const rows = [
    { year: 2026, quarter: 1, value: 120 },
    { year: 2025, quarter: 4, value: 200 },
  ];
  assert.equal(sameQuarterYoY(rows), null);
});
