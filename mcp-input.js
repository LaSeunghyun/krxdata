const SUPPORTED_MARKETS = new Set(["KOSPI", "KOSDAQ"]);

export function escapeSqlLiteral(value) {
  return String(value).replace(/'/g, "''");
}

export function parseOptionalSqlText(value, label = "value") {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > 100) throw new Error(`${label}는 100자 이하로 입력해야 합니다`);
  return escapeSqlLiteral(text);
}

export function parseMarket(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const market = String(value).trim().toUpperCase();
  if (!SUPPORTED_MARKETS.has(market)) throw new Error("market은 KOSPI 또는 KOSDAQ만 허용됩니다");
  return market;
}

export function parseFinancialYear(value, defaultYear = 2024) {
  const parsed = Number(value ?? defaultYear);
  if (!Number.isInteger(parsed) || parsed < 2000 || parsed > 2100) {
    throw new Error("year는 2000~2100 사이의 정수여야 합니다");
  }
  return parsed;
}

export function parseRankingLimit(value, defaultLimit = 20, maxLimit = 100) {
  const parsed = Number(value ?? defaultLimit);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) {
    if (Number.isInteger(parsed) && parsed > maxLimit) return maxLimit;
    throw new Error(`top은 1~${maxLimit} 사이의 정수여야 합니다`);
  }
  return parsed;
}
