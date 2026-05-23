-- stock_analysis 테이블 마이그레이션
-- 실행: Supabase SQL Editor 또는 psql

CREATE TABLE IF NOT EXISTS stock_analysis (
  stock_code         TEXT        PRIMARY KEY,
  corp_name          TEXT        NOT NULL,
  current_price      INT         NOT NULL DEFAULT 0,
  short_target_price INT         NOT NULL DEFAULT 0,
  mid_target_price   INT         NOT NULL DEFAULT 0,
  short_target_pct   FLOAT       NOT NULL DEFAULT 0,
  mid_target_pct     FLOAT       NOT NULL DEFAULT 0,
  recommendation     TEXT        NOT NULL DEFAULT '',
  market_cap_tril    FLOAT       NOT NULL DEFAULT 0,
  total_score        INT         NOT NULL DEFAULT 0,
  short_score        INT         NOT NULL DEFAULT 0,
  long_score         INT         NOT NULL DEFAULT 0,
  detail             JSONB       NOT NULL DEFAULT '{}',
  generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stock_analysis_updated_at ON stock_analysis;
CREATE TRIGGER trg_stock_analysis_updated_at
  BEFORE UPDATE ON stock_analysis
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 자주 쓰는 조회용 인덱스
CREATE INDEX IF NOT EXISTS idx_stock_analysis_total_score ON stock_analysis (total_score DESC);
CREATE INDEX IF NOT EXISTS idx_stock_analysis_long_score  ON stock_analysis (long_score  DESC);
CREATE INDEX IF NOT EXISTS idx_stock_analysis_updated_at  ON stock_analysis (updated_at  DESC);
CREATE INDEX IF NOT EXISTS idx_stock_analysis_mid_target  ON stock_analysis (mid_target_pct DESC);

-- RLS (필요 시 활성화)
-- ALTER TABLE stock_analysis ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "public read" ON stock_analysis FOR SELECT USING (true);
