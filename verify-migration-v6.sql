SELECT
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name='stock_financials' AND column_name IN ('rcept_dt','report_code','quarter')) AS new_cols,
  (SELECT COUNT(*) FROM pg_constraint
   WHERE conrelid='public.stock_financials'::regclass AND conname='stock_financials_code_year_report_uniq') AS uniq_ok,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_name='factor_ic_history') AS ic_table,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_name='portfolio_positions') AS pf_table,
  (SELECT COUNT(*) FROM stock_financials WHERE report_code='11011') AS annual_rows;
