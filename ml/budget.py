"""Budget-buy logic: convert ranked picks + latest close + cash budget into an
integer-share allocation.

Greedy by rank: iterate picks best-first, allocating whole shares up to a per-name
weight cap (~1/8 of budget) while respecting remaining cash. After the first pass we
run a top-up pass (again best-first, cap-respecting) to soak up leftover cash and
maximize utilization. Returns a table with 종목/주수/금액/비중/예산소진율.
"""
from __future__ import annotations
import math
import pandas as pd

import config


def allocate(picks: pd.DataFrame, budget: float = config.DEFAULT_BUDGET_KRW,
             max_name_weight: float = config.MAX_NAME_WEIGHT) -> pd.DataFrame:
    """picks: DataFrame with columns stock_code, corp_name, close (latest), pred (rank order).

    Rows are assumed ranked (best first) by the caller; we also sort by pred desc to be safe.
    """
    p = picks.copy().sort_values("pred", ascending=False).reset_index(drop=True)
    cap_krw = budget * max_name_weight
    shares = {c: 0 for c in p["stock_code"]}
    remaining = budget

    def name_value(code, close):
        return shares[code] * close

    # Pass 1: seed each name up to cap, best-first
    for _, row in p.iterrows():
        code, close = row["stock_code"], row["close"]
        if close <= 0 or math.isnan(close):
            continue
        room_cap = cap_krw - name_value(code, close)
        n_by_cap = int(room_cap // close)
        n_by_cash = int(remaining // close)
        buy = max(0, min(n_by_cap, n_by_cash))
        shares[code] += buy
        remaining -= buy * close

    # Pass 2: top-up leftover cash, best-first, still respecting cap
    improved = True
    while improved:
        improved = False
        for _, row in p.iterrows():
            code, close = row["stock_code"], row["close"]
            if close <= 0 or math.isnan(close):
                continue
            if name_value(code, close) + close <= cap_krw and close <= remaining:
                shares[code] += 1
                remaining -= close
                improved = True

    p["shares"] = p["stock_code"].map(shares)
    p["amount"] = p["shares"] * p["close"]
    invested = p["amount"].sum()
    p["weight"] = p["amount"] / budget
    out = p[p["shares"] > 0].copy()
    out.attrs["budget"] = budget
    out.attrs["invested"] = invested
    out.attrs["cash_left"] = budget - invested
    out.attrs["utilization"] = invested / budget if budget else 0.0
    return out
