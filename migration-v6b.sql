-- v6b: UNIQUE → PRIMARY KEY 승격 (C1 수정)
-- v6 마이그레이션이 기존 PK까지 드롭해 PostgREST merge-duplicates upsert
-- (score-kospi-full.js / score-kosdaq.js / populate-financials.js)가 깨지는 문제 복구.
-- PostgREST는 on_conflict 미지정 시 PK 기준으로 upsert를 해석한다.
ALTER TABLE public.stock_financials ALTER COLUMN analysis_year SET NOT NULL;
ALTER TABLE public.stock_financials ALTER COLUMN report_code   SET NOT NULL;
ALTER TABLE public.stock_financials DROP CONSTRAINT IF EXISTS stock_financials_code_year_report_uniq;
ALTER TABLE public.stock_financials
  ADD CONSTRAINT stock_financials_pkey PRIMARY KEY (stock_code, analysis_year, report_code);
