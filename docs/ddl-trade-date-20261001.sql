-- 패키지 A: 거래일 + OHLCV (2026-10-01). 추가 전용 DDL. 실행: Supabase Management API (project onxkbuecwbcueuhwnowx)
-- 롤백(필요 시): ALTER TABLE stock_prices DROP COLUMN trade_date, DROP COLUMN open, DROP COLUMN high, DROP COLUMN low,
--                DROP COLUMN volume, DROP COLUMN turnover;  DROP TABLE trading_calendar;  DROP INDEX idx_stock_prices_code_trade_date;

CREATE TABLE IF NOT EXISTS trading_calendar (trade_date date PRIMARY KEY, is_open boolean NOT NULL, source text, created_at timestamptz DEFAULT now());
ALTER TABLE trading_calendar ENABLE ROW LEVEL SECURITY;

ALTER TABLE stock_prices
  ADD COLUMN IF NOT EXISTS trade_date date,
  ADD COLUMN IF NOT EXISTS open numeric,
  ADD COLUMN IF NOT EXISTS high numeric,
  ADD COLUMN IF NOT EXISTS low numeric,
  ADD COLUMN IF NOT EXISTS volume bigint,
  ADD COLUMN IF NOT EXISTS turnover numeric;

-- trade_date 백필 후 실행
CREATE INDEX IF NOT EXISTS idx_stock_prices_code_trade_date ON stock_prices (stock_code, trade_date);
