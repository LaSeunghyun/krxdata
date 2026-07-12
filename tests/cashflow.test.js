import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCashflowCapex, computeFcf, scoreCashflowQuality, capexCycle } from '../scoring-core.js';

// fnlttSinglAcntAll 현금흐름표(sj_div="CF") 응답을 모사한 fixture (GST FY2025 실측 기반)
const CF_ROWS = [
  { sj_div: 'CF', account_nm: '영업활동으로 인한 현금흐름', thstrm_amount: '41,591,693,861', frmtrm_amount: '38,000,000,000' },
  { sj_div: 'CF', account_nm: '영업활동에서 창출된 현금',   thstrm_amount: '50,000,000,000' }, // 소계 → 제외돼야
  { sj_div: 'CF', account_nm: '투자활동으로 인한 현금흐름', thstrm_amount: '-13,563,928,500' },
  { sj_div: 'CF', account_nm: '유형자산의 취득',           thstrm_amount: '12,756,209,017', frmtrm_amount: '9,000,000,000' },
  { sj_div: 'CF', account_nm: '무형자산의 취득',           thstrm_amount: '150,470,774',    frmtrm_amount: '100,000,000' },
  { sj_div: 'CF', account_nm: '유형자산의 처분',           thstrm_amount: '51,148,635' },     // 처분(유입) → capex 아님
  { sj_div: 'BS', account_nm: '자산총계',                  thstrm_amount: '386,310,986,387' }, // 비CF → 무시
];

test('extractCashflowCapex: 순액 영업CF 선택(창출 소계 제외)', () => {
  const r = extractCashflowCapex(CF_ROWS);
  assert.equal(r.cfOps, 41_591_693_861);
});

test('extractCashflowCapex: 투자CF', () => {
  assert.equal(extractCashflowCapex(CF_ROWS).cfInv, -13_563_928_500);
});

test('extractCashflowCapex: capex = 유형+무형 취득 합(처분 제외)', () => {
  const r = extractCashflowCapex(CF_ROWS);
  assert.equal(r.capex, 12_756_209_017 + 150_470_774); // 12,906,679,791
  assert.equal(r.capexPrev, 9_000_000_000 + 100_000_000);
});

test('extractCashflowCapex: CF 행 없으면 전부 null', () => {
  const r = extractCashflowCapex([{ sj_div: 'BS', account_nm: '자산총계', thstrm_amount: '100' }]);
  assert.deepEqual(r, { cfOps: null, cfInv: null, capex: null, capexPrev: null });
});

test('computeFcf: 영업CF − capex', () => {
  assert.equal(computeFcf({ cfOps: 41_591_693_861, capex: 12_906_679_791 }), 28_685_014_070);
  assert.equal(computeFcf({ cfOps: 100, capex: null }), null);
  assert.equal(computeFcf({ cfOps: null, capex: 100 }), null);
});

test('scoreCashflowQuality: 영업CF+ / FCF+ 배점', () => {
  assert.equal(scoreCashflowQuality({ cfOps: 10, fcf: 5 }).score, 5);
  assert.equal(scoreCashflowQuality({ cfOps: 10, fcf: -1 }).score, 3);
  assert.equal(scoreCashflowQuality({ cfOps: 10, fcf: null }).score, 3);
  assert.equal(scoreCashflowQuality({ cfOps: -1, fcf: -1 }).score, 0);
  assert.equal(scoreCashflowQuality({ cfOps: null, fcf: null }).score, 0);
});

test('capexCycle: capexYoY≥30% → 증설 사이클 플래그', () => {
  const c = capexCycle({ capex: 12_906_679_791, capexPrev: 9_100_000_000, cfOps: 41_591_693_861, fcf: 28_685_014_070 });
  assert.equal(c.capexYoY, 41.8);
  assert.equal(c.capexToOcf, 0.31);
  assert.equal(c.cycle, true);
});

test('capexCycle: capex 감소 → 사이클 false', () => {
  const c = capexCycle({ capex: 5_000_000_000, capexPrev: 9_000_000_000, cfOps: 40_000_000_000 });
  assert.equal(c.cycle, false);
});
