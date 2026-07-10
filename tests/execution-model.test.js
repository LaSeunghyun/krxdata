import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcBuyCashImpact,
  calcSellCashImpact,
  calcRoundTripPnl,
  getSellTaxBps,
} from '../execution-model.mjs';

test('calcBuyCashImpact includes fee', () => {
  assert.equal(calcBuyCashImpact({ fill: 1000, qty: 10, feeBps: 1.5 }), 10002);
});

test('calcSellCashImpact includes fee and tax', () => {
  assert.equal(calcSellCashImpact({ fill: 1000, qty: 10, feeBps: 1.5, taxBps: 15 }), 9984);
});

test('calcRoundTripPnl matches fee/tax adjusted pnl', () => {
  assert.equal(calcRoundTripPnl({ entry: 1000, exit: 1100, qty: 10, feeBps: 1.5, taxBps: 20 }), 975);
});

test('getSellTaxBps defaults to market-aware stock rate', () => {
  assert.equal(getSellTaxBps('kospi'), 20);
  assert.equal(getSellTaxBps('kosdaq'), 20);
});
