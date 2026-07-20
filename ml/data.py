"""Paginated Supabase REST pulls with local parquet cache.

The PostgREST instance caps every response at 1000 rows regardless of the Range
window size, so we page in 1000-row steps using the Range header and stop when a
short page is returned. Raw pulls are cached to _cache/*.parquet for fast re-runs.
"""
from __future__ import annotations
from pathlib import Path
import time
import requests
import pandas as pd

from env import SUPABASE_URL, REST_HEADERS
import config

_CACHE = Path(__file__).resolve().parent / config.CACHE_DIR
_CACHE.mkdir(exist_ok=True)
_PAGE = 1000  # PostgREST hard max-rows per response


def _paginate(table: str, select: str, params: dict | None = None,
              order: str = "", timeout: int = 120) -> list[dict]:
    """Pull all rows for a query, paging by Range header in 1000-row steps."""
    out: list[dict] = []
    start = 0
    base = {"select": select}
    if order:
        base["order"] = order
    if params:
        base.update(params)
    while True:
        headers = {**REST_HEADERS, "Range-Unit": "items", "Range": f"{start}-{start + _PAGE - 1}"}
        for attempt in range(4):
            try:
                r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", params=base,
                                 headers=headers, timeout=timeout)
                if r.status_code in (200, 206):
                    break
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
            except Exception as e:
                if attempt == 3:
                    raise
                time.sleep(1.5 * (attempt + 1))
        batch = r.json()
        if not isinstance(batch, list):
            raise RuntimeError(f"Unexpected response for {table}: {str(batch)[:200]}")
        out.extend(batch)
        if len(batch) < _PAGE:
            break
        start += _PAGE
    return out


def _cache_path(name: str) -> Path:
    return _CACHE / f"{name}.parquet"


def load_prices(force: bool = False) -> pd.DataFrame:
    """stock_prices: stock_code, date (YYYYMMDD), close. Ordered for stable paging."""
    p = _cache_path("stock_prices")
    if p.exists() and not force:
        return pd.read_parquet(p)
    rows = _paginate("stock_prices", "stock_code,date,close",
                     order="date.asc,stock_code.asc")
    df = pd.DataFrame(rows)
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    df["date"] = df["date"].astype(str)
    df = df.dropna(subset=["close"]).drop_duplicates(["stock_code", "date"])
    df.to_parquet(p, index=False)
    return df


def load_financials(force: bool = False) -> pd.DataFrame:
    """Annual (report_code=11011) rows with rcept_dt NOT NULL = point-in-time available."""
    p = _cache_path("stock_financials")
    if p.exists() and not force:
        return pd.read_parquet(p)
    cols = ("stock_code,analysis_year,report_code,rcept_dt,per,pbr,roe,debt_ratio,"
            "cur_ratio,op_margin,revenue_yoy,op_income_yoy,net_income,total_equity,"
            "total_debt,total_asset,revenue,op_income,market_cap,cf_ops,mrkt_ctg")
    rows = _paginate("stock_financials", cols,
                     params={"report_code": "eq.11011", "rcept_dt": "not.is.null"},
                     order="rcept_dt.asc,stock_code.asc")
    df = pd.DataFrame(rows)
    df["rcept_dt"] = df["rcept_dt"].astype(str)
    num_cols = ["per", "pbr", "roe", "debt_ratio", "cur_ratio", "op_margin",
                "revenue_yoy", "op_income_yoy", "net_income", "total_equity",
                "total_debt", "total_asset", "revenue", "op_income", "market_cap", "cf_ops"]
    for c in num_cols:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df.to_parquet(p, index=False)
    return df


def load_stocks(force: bool = False) -> pd.DataFrame:
    """stocks: stock_code, corp_name, mrkt_ctg, is_listed, delisted_at."""
    p = _cache_path("stocks")
    if p.exists() and not force:
        return pd.read_parquet(p)
    rows = _paginate("stocks", "stock_code,corp_name,mrkt_ctg,is_listed,delisted_at",
                     order="stock_code.asc")
    df = pd.DataFrame(rows)
    df.to_parquet(p, index=False)
    return df


def load_all(force: bool = False):
    return load_prices(force), load_financials(force), load_stocks(force)


if __name__ == "__main__":
    prices = load_prices()
    fin = load_financials()
    stk = load_stocks()
    print("prices:", prices.shape, prices["date"].min(), "..", prices["date"].max(),
          "| stocks:", prices["stock_code"].nunique(), "| dates:", prices["date"].nunique())
    print("financials (annual PIT):", fin.shape,
          "| mcap notnull:", fin["market_cap"].notna().sum(),
          "| large:", (fin["market_cap"] >= config.LARGE_CAP_MIN).sum(),
          "| small:", (fin["market_cap"] < config.SMALL_CAP_MAX).sum())
    print("stocks:", stk.shape)
