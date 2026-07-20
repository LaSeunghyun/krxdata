"""LightGBM binary classifier + per-fold metrics.

For each purged walk-forward fold we train on the union of train rebalances' labelled
rows and evaluate on the single test rebalance's labelled rows. Metrics:
  * AUC          : ranking quality of P(top-quintile)
  * IC           : spearman(pred_score, fwd_return) on the test cross-section
  * precision@N  : fraction of the model's top-N picks that were actually top-quintile
"""
from __future__ import annotations
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.metrics import roc_auc_score
import lightgbm as lgb

import config
from features import FEATURE_COLS


def _train_test_frames(labelled: pd.DataFrame, fold: dict):
    tr = labelled[(labelled["rebalance_date"].isin(fold["train_dates"])) &
                  (labelled["has_label"])].copy()
    te = labelled[(labelled["rebalance_date"] == fold["test_date"]) &
                  (labelled["has_label"])].copy()
    return tr, te


def run_fold(labelled: pd.DataFrame, fold: dict, top_n: int = config.TOP_N) -> dict | None:
    tr, te = _train_test_frames(labelled, fold)
    if len(tr) < 30 or len(te) < top_n or tr["y"].nunique() < 2:
        return None
    Xtr, ytr = tr[FEATURE_COLS], tr["y"].astype(int)
    Xte = te[FEATURE_COLS]

    clf = lgb.LGBMClassifier(**config.LGB_PARAMS)
    clf.fit(Xtr, ytr)
    pred = clf.predict_proba(Xte)[:, 1]
    te = te.assign(pred=pred)

    # AUC (needs both classes present in test)
    auc = np.nan
    if te["y"].nunique() == 2:
        auc = roc_auc_score(te["y"].astype(int), te["pred"])
    # IC = spearman(pred, fwd_return)
    ic = np.nan
    if te["fwd_return"].notna().sum() >= 3:
        ic = spearmanr(te["pred"], te["fwd_return"]).correlation
    # precision@top_n
    topk = te.nlargest(top_n, "pred")
    prec_at_n = topk["y"].mean() if len(topk) else np.nan
    # mean forward return of the model's top_n picks (gross, no cost)
    pick_fwd = topk["fwd_return"].mean()

    return {
        "test_date": fold["test_date"],
        "n_train": len(tr),
        "n_test": len(te),
        "auc": auc,
        "ic": ic,
        "prec_at_n": prec_at_n,
        "pick_fwd_return": pick_fwd,
        "picks": topk[["stock_code", "pred", "fwd_return"]].to_dict("records"),
    }


def run_all_folds(labelled: pd.DataFrame, folds: list[dict],
                  top_n: int = config.TOP_N) -> pd.DataFrame:
    rows = [r for r in (run_fold(labelled, f, top_n) for f in folds) if r is not None]
    if not rows:
        return pd.DataFrame(columns=["test_date", "n_train", "n_test", "auc", "ic",
                                     "prec_at_n", "pick_fwd_return"])
    return pd.DataFrame([{k: v for k, v in r.items() if k != "picks"} for r in rows])


def fit_full(labelled: pd.DataFrame, train_dates: list[str]):
    """Fit a model on all labelled rows from given rebalance dates (for latest-date scoring)."""
    tr = labelled[(labelled["rebalance_date"].isin(train_dates)) & (labelled["has_label"])]
    Xtr, ytr = tr[FEATURE_COLS], tr["y"].astype(int)
    clf = lgb.LGBMClassifier(**config.LGB_PARAMS)
    clf.fit(Xtr, ytr)
    return clf
