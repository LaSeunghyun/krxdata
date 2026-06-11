-- v6: PIT 컬럼 + 분기 행 공존 + IC 이력 + 포트폴리오 원장
-- 실행: node run-migration.mjs migration-v6.sql
ALTER TABLE public.stock_financials ADD COLUMN IF NOT EXISTS report_code TEXT NOT NULL DEFAULT '11011';
ALTER TABLE public.stock_financials ADD COLUMN IF NOT EXISTS rcept_dt    TEXT;
ALTER TABLE public.stock_financials ADD COLUMN IF NOT EXISTS quarter     SMALLINT;

-- 기존 PK/유니크 제약을 (stock_code, analysis_year, report_code)로 교체
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.stock_financials'::regclass AND contype IN ('p','u')
  LOOP
    EXECUTE format('ALTER TABLE public.stock_financials DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.stock_financials
  ADD CONSTRAINT stock_financials_code_year_report_uniq
  UNIQUE (stock_code, analysis_year, report_code);

CREATE TABLE IF NOT EXISTS public.factor_ic_history (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  horizon      SMALLINT NOT NULL,
  factor       TEXT NOT NULL,        -- 'composite' 또는 팩터 키
  ic           NUMERIC,
  ic_pos_rate  NUMERIC,
  n_obs        INT,
  period_begin TEXT,
  period_end   TEXT,
  UNIQUE (run_date, horizon, factor)
);

CREATE TABLE IF NOT EXISTS public.portfolio_positions (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stock_code  TEXT NOT NULL,
  corp_name   TEXT,
  entry_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  entry_price NUMERIC NOT NULL,
  weight_pct  NUMERIC NOT NULL DEFAULT 5,
  status      TEXT NOT NULL DEFAULT 'open',  -- open | half_exited | closed
  exit_date   DATE,
  exit_price  NUMERIC,
  exit_reason TEXT,                          -- stop_loss | half_profit | manual | rescreen
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portfolio_active ON public.portfolio_positions (status) WHERE status != 'closed';
