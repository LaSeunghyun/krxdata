"""Purged walk-forward split (expanding window with H-day embargo).

Rebalance dates are ordered. For each candidate test rebalance date, the train set
is every rebalance strictly before it whose LABEL window has fully closed before the
test date's FEATURE date. Concretely a train rebalance date d_train is usable for a
test date d_test only if:
    (position of d_test) > (position of d_train) + H
i.e. the H-day forward-return window used to label the train rebalance does not
overlap the test rebalance's feature date. This purges the horizon-overlap leakage.

We build expanding folds: fold k uses all valid train rebalances < test_k as train,
and a single test rebalance test_k. We only emit folds where at least
MIN_TRAIN_REBALANCES clean train rebalances exist. The number of clean folds is
reported honestly.
"""
from __future__ import annotations
import numpy as np

import config


def make_folds(rebalance_dates: list[str], tdates: np.ndarray, H: int,
               min_train: int = config.MIN_TRAIN_REBALANCES) -> list[dict]:
    """Return list of folds: {test_date, train_dates:[...], H}.

    Expanding window: as test date advances, the train set grows to include every
    earlier rebalance that is embargoed by >H trading days from the test date.
    """
    pos = {str(d): i for i, d in enumerate(tdates)}
    rd = [str(d) for d in rebalance_dates]
    folds = []
    for i, test_date in enumerate(rd):
        tp = pos[test_date]
        train = [d for d in rd[:i] if tp - pos[d] > H]
        if len(train) >= min_train:
            folds.append({"test_date": test_date, "train_dates": train, "H": H})
    return folds
