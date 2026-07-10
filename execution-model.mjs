export const DEFAULT_FEE_BPS = 1.5;
export const DEFAULT_SELL_TAX_BPS = 20;

const SELL_TAX_BPS_BY_MARKET = {
  KOSPI: 20,
  KOSDAQ: 20,
  KONEX: 20,
  DEFAULT: DEFAULT_SELL_TAX_BPS,
};

const normalizeMarket = (market) => String(market ?? 'DEFAULT').trim().toUpperCase();

export function getSellTaxBps(market) {
  return SELL_TAX_BPS_BY_MARKET[normalizeMarket(market)] ?? DEFAULT_SELL_TAX_BPS;
}

export function calcBuyCashImpact({ fill, qty, feeBps = DEFAULT_FEE_BPS }) {
  return Math.round(fill * qty * (1 + feeBps / 10_000));
}

export function calcSellCashImpact({ fill, qty, feeBps = DEFAULT_FEE_BPS, taxBps = DEFAULT_SELL_TAX_BPS }) {
  return Math.round(fill * qty * (1 - feeBps / 10_000 - taxBps / 10_000));
}

export function calcRoundTripPnl({ entry, exit, qty, feeBps = DEFAULT_FEE_BPS, taxBps = DEFAULT_SELL_TAX_BPS }) {
  const gross = (exit - entry) * qty;
  const fees = (entry + exit) * qty * (feeBps / 10_000) + exit * qty * (taxBps / 10_000);
  return Math.round(gross - fees);
}
