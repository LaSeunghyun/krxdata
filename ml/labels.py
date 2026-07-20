"""Forward-return labels + cross-sectional top-quintile classification.

For a rebalance date T and horizon H (trading days):
  fwd_return = close(T+H) / close(T) - 1
Then within each T's universe, y=1 if fwd_return is in the top 20% (top quintile)
of that date's cross-section, else 0. Rows with no close(T+H) (horizon runs off the
end of the price history) get fwd_return = NaN and are excluded from that fold's labels.
"""
from __future__ import annotations
import numpy as np
import pandas as pd


def forward_return(mat: pd.DataFrame, tdates: np.ndarray, T: str, H: int) -> pd.Series:
    """close(T+H)/close(T)-1 per stock; NaN where T+H is beyond history."""
    date_pos = {str(d): i for i, d in enumerate(tdates)}
    t_pos = date_pos[str(T)]
    fwd_pos = t_pos + H
    if fwd_pos >= len(tdates):
        return pd.Series(np.nan, index=mat.columns)
    c0 = mat.iloc[t_pos]
    c1 = mat.iloc[fwd_pos]
    return c1 / c0 - 1.0


def attach_labels(panel: pd.DataFrame, mat: pd.DataFrame, tdates: np.ndarray,
                  H: int) -> pd.DataFrame:
    """Add fwd_return and top-quintile y to the panel for a given horizon H.

    y is computed cross-sectionally within each rebalance_date. Rows where
    fwd_return is NaN (horizon off the end) are kept but flagged has_label=False.
    """
    out = panel.copy()
    fwd_map = {}
    for T in out["rebalance_date"].unique():
        fr = forward_return(mat, tdates, T, H)
        fwd_map[T] = fr
    out["fwd_return"] = out.apply(
        lambda r: fwd_map[r["rebalance_date"]].get(r["stock_code"], np.nan), axis=1)
    out["has_label"] = out["fwd_return"].notna()

    # cross-sectional top-quintile per date (only among labelled rows)
    def _quintile(g):
        lab = g[g["fwd_return"].notna()]
        y = pd.Series(0, index=g.index, dtype="float")
        if len(lab) >= 5:
            thr = lab["fwd_return"].quantile(0.80)
            y.loc[lab.index] = (lab["fwd_return"] >= thr).astype(float)
        elif len(lab) > 0:
            # too few to form a quintile: label top-ranked as 1
            top = lab["fwd_return"].rank(pct=True) >= 0.80
            y.loc[lab.index] = top.astype(float)
        y[~g["fwd_return"].notna()] = np.nan
        return y

    out["y"] = out.groupby("rebalance_date", group_keys=False).apply(
        _quintile, include_groups=False)
    return out
