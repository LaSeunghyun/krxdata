"""Point-in-time feature panel.

For each rebalance date T we build one row per eligible stock using ONLY data
available at/before T:
  * price-derived: momentum 20/60/120d, volatility (20/60d), MA-trend (close/MA),
    distance-from-trailing-high (250d window).
  * fundamentals: the financial row with the LARGEST rcept_dt <= T (PIT join),
    fields per/pbr/roe/debt_ratio/cur_ratio/op_margin/revenue_yoy/op_income_yoy,
    plus log(market_cap).
  * market/sector: mrkt_ctg one-hot-ish code.

Stocks with no PIT financial or insufficient price history at T are dropped.
"""
from __future__ import annotations
import numpy as np
import pandas as pd

import config


def build_price_matrix(prices: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray]:
    """Wide close matrix indexed by sorted trading date, columns = stock_code."""
    mat = prices.pivot(index="date", columns="stock_code", values="close").sort_index()
    trading_dates = mat.index.to_numpy()
    return mat, trading_dates


def rebalance_dates(trading_dates: np.ndarray, step: int, min_hist: int) -> list[str]:
    """Every `step`-th trading day, starting once >= min_hist history exists."""
    idxs = list(range(min_hist, len(trading_dates), step))
    return [str(trading_dates[i]) for i in idxs]


def _pit_financials(fin: pd.DataFrame, asof: str) -> pd.DataFrame:
    """Latest annual filing available at/before `asof` (largest rcept_dt <= asof), per stock."""
    avail = fin[fin["rcept_dt"] <= asof]
    if avail.empty:
        return avail
    avail = avail.sort_values("rcept_dt")
    return avail.groupby("stock_code", as_index=False).last()


def _price_features_at(mat: pd.DataFrame, t_pos: int) -> pd.DataFrame:
    """Compute price features using closes up to and including index position t_pos."""
    window = mat.iloc[: t_pos + 1]
    c = window.iloc[-1]  # close at T

    def mom(n):
        if t_pos - n < 0:
            return pd.Series(np.nan, index=mat.columns)
        base = window.iloc[-(n + 1)]
        return c / base - 1.0

    ret = window.pct_change()

    def vol(n):
        if t_pos - n < 0:
            return pd.Series(np.nan, index=mat.columns)
        return ret.iloc[-n:].std()

    def ma_trend(n):
        if t_pos - n < 0:
            return pd.Series(np.nan, index=mat.columns)
        ma = window.iloc[-n:].mean()
        return c / ma - 1.0

    hi_window = min(250, t_pos + 1)
    trailing_high = window.iloc[-hi_window:].max()
    dist_from_high = c / trailing_high - 1.0

    feat = pd.DataFrame({
        "mom_20": mom(20),
        "mom_60": mom(60),
        "mom_120": mom(120),
        "vol_20": vol(20),
        "vol_60": vol(60),
        "ma_trend_20": ma_trend(20),
        "ma_trend_60": ma_trend(60),
        "dist_from_high": dist_from_high,
        "close_at_T": c,
    })
    feat.index.name = "stock_code"
    return feat.reset_index()


def _sector_code(fin_pit: pd.DataFrame, stocks: pd.DataFrame) -> pd.DataFrame:
    """Market category as an integer code (KOSPI/KOSDAQ) for the model."""
    mk = stocks[["stock_code", "mrkt_ctg"]].copy()
    mk = mk.dropna(subset=["mrkt_ctg"])
    mapping = {v: i for i, v in enumerate(sorted(mk["mrkt_ctg"].unique()))}
    mk["mrkt_code"] = mk["mrkt_ctg"].map(mapping).astype("float")
    return mk[["stock_code", "mrkt_code"]]


FUND_COLS = ["per", "pbr", "roe", "debt_ratio", "cur_ratio", "op_margin",
             "revenue_yoy", "op_income_yoy"]

FEATURE_COLS = ["mom_20", "mom_60", "mom_120", "vol_20", "vol_60",
                "ma_trend_20", "ma_trend_60", "dist_from_high",
                "log_mcap", "mrkt_code"] + FUND_COLS


def build_panel(prices: pd.DataFrame, fin: pd.DataFrame, stocks: pd.DataFrame,
                step: int = config.REBALANCE_STEP,
                min_hist: int = config.MIN_PRICE_HISTORY) -> tuple[pd.DataFrame, pd.DataFrame, np.ndarray]:
    """Return (panel, close_matrix, trading_dates).

    panel: one row per (T, stock_code) with FEATURE_COLS + market_cap + close_at_T,
    for stocks that have both a PIT financial and sufficient price history at T.
    """
    mat, tdates = build_price_matrix(prices)
    rdates = rebalance_dates(tdates, step, min_hist)
    date_pos = {str(d): i for i, d in enumerate(tdates)}
    sector = _sector_code(fin, stocks)

    frames = []
    for T in rdates:
        t_pos = date_pos[T]
        pf = _price_features_at(mat, t_pos)
        # require the long-window momentum to exist (enough history)
        pf = pf.dropna(subset=["mom_120", "vol_60"])
        if pf.empty:
            continue
        fpit = _pit_financials(fin, T)
        if fpit.empty:
            continue
        fpit = fpit[["stock_code", "market_cap"] + FUND_COLS].copy()
        merged = pf.merge(fpit, on="stock_code", how="inner")
        merged = merged.merge(sector, on="stock_code", how="left")
        merged = merged.dropna(subset=["market_cap"])
        if merged.empty:
            continue
        merged["log_mcap"] = np.log(merged["market_cap"].clip(lower=1))
        merged["rebalance_date"] = T
        frames.append(merged)

    if not frames:
        raise RuntimeError("No panel rows built — check data coverage.")
    panel = pd.concat(frames, ignore_index=True)
    return panel, mat, tdates
