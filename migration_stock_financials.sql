-- Supabase Dashboard > SQL Editor 에서 실행하세요
-- https://supabase.com/dashboard/project/onxkbuecwbcueuhwnowx/sql

create table if not exists public.stock_financials (
  stock_code      text primary key,
  corp_name       text,
  mrkt_ctg        text,          -- 'KOSPI' | 'KOSDAQ'
  per             numeric,       -- 주가수익비율 (시총/순이익)
  pbr             numeric,       -- 주가순자산비율 (시총/자기자본)
  roe             numeric,       -- 자기자본이익률 % (순이익/자기자본*100)
  debt_ratio      numeric,       -- 부채비율 %
  cur_ratio       numeric,       -- 유동비율 %
  op_margin       numeric,       -- 영업이익률 %
  revenue_yoy     numeric,       -- 매출 YoY 증감률 %
  op_income_yoy   numeric,       -- 영업이익 YoY 증감률 %
  net_income      bigint,        -- 당기순이익 (원)
  total_equity    bigint,        -- 자기자본 (원)
  total_debt      bigint,        -- 부채총계 (원)
  total_asset     bigint,        -- 자산총계 (원)
  revenue         bigint,        -- 매출액 (원)
  op_income       bigint,        -- 영업이익 (원)
  market_cap      bigint,        -- 시가총액 (원)
  cf_ops          bigint,        -- 영업활동현금흐름 (원)
  analysis_year   smallint,      -- 분석 기준 사업연도
  updated_at      timestamptz default now()
);

alter table public.stock_financials enable row level security;

create policy "anyone can read stock_financials"
  on public.stock_financials
  for select to anon using (true);
