"""Cost-aware comparison backtest.

At each test rebalance date T (from the purged walk-forward folds), the model trained
on the embargoed expanding window picks top_n stocks. We buy them equal-weight, hold H
trading days, then sell. Costs applied per side:
  buy side  = BUY_FEE + slippage
  sell side = SELL_FEE + TRANSACTION_TAX + slippage
slippage is large/small per the cap class of the universe.

Per rebalance:
  gross_ret = mean(fwd_return of picks)
  net_ret   = product over picks of (1+r_i)*(1-buy_side)*(1-sell_side) equal-weight,
              i.e. mean over picks of [(1+r_i)*(1-buy_side)*(1-sell_side) - 1]
Turnover = 100% each rebalance (fully rebuilt). Cost drag = gross - net.
We compound net returns across folds for a cumulative NET curve, and annualize by the
average holding period. Hit rate = fraction of picks with fwd_return > 0 (gross).
"""
from __future__ import annotations
import numpy as np
import pandas as pd

import config
from model import run_fold


def backtest_universe(labelled: pd.DataFrame, folds: list[dict], is_large: bool,
                      H: int, top_n: int = config.TOP_N) -> dict:
    slip = config.side_slippage(is_large)
    buy_side = config.BUY_FEE + slip
    sell_side = config.SELL_FEE + config.TRANSACTION_TAX + slip
    cost_mult = (1 - buy_side) * (1 - sell_side)

    per_fold = []
    net_curve = 1.0
    gross_curve = 1.0
    for f in folds:
        res = run_fold(labelled, f, top_n)
        if res is None:
            continue
        picks = pd.DataFrame(res["picks"])
        picks = picks.dropna(subset=["fwd_return"])
        if picks.empty:
            continue
        r = picks["fwd_return"].to_numpy()
        gross = float(np.mean(r))
        net = float(np.mean((1 + r) * cost_mult - 1))
        hit = float(np.mean(r > 0))
        net_curve *= (1 + net)
        gross_curve *= (1 + gross)
        per_fold.append({
            "test_date": res["test_date"],
            "n_picks": len(picks),
            "gross_ret": gross,
            "net_ret": net,
            "cost_drag": gross - net,
            "hit_rate": hit,
            "turnover": 1.0,
        })

    n_folds = len(per_fold)
    if n_folds == 0:
        return {"n_folds": 0, "per_fold": pd.DataFrame(),
                "gross_cum": 0.0, "net_cum": 0.0, "avg_gross": np.nan,
                "avg_net": np.nan, "avg_cost_drag": np.nan, "avg_hit": np.nan,
                "avg_turnover": np.nan, "ann_net": np.nan, "is_large": is_large, "H": H}

    pf = pd.DataFrame(per_fold)
    # annualize: ~252 trading days / holding period H, applied to per-period NET gmean
    net_gmean = net_curve ** (1.0 / n_folds) - 1.0
    periods_per_year = 252.0 / H
    ann_net = (1 + net_gmean) ** periods_per_year - 1.0
    return {
        "n_folds": n_folds,
        "per_fold": pf,
        "gross_cum": gross_curve - 1.0,
        "net_cum": net_curve - 1.0,
        "avg_gross": pf["gross_ret"].mean(),
        "avg_net": pf["net_ret"].mean(),
        "avg_cost_drag": pf["cost_drag"].mean(),
        "avg_hit": pf["hit_rate"].mean(),
        "avg_turnover": pf["turnover"].mean(),
        "ann_net": ann_net,
        "is_large": is_large,
        "H": H,
    }
