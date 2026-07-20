"""Orchestrate the leakage-safe stock-ranking ML pipeline and print the full report.

Sections:
  1. Data pull summary
  2. 60d large-cap walk-forward (per-fold IC/AUC/precision@15 + aggregate, n_folds)
  3. Comparison grid: {large>=1조, small<0.5조} x {H=60,3,1} -> gross/NET/turnover/cost-drag/hit/n_folds
  4. Budget-buy demo: 10,000,000 KRW on latest 60d large-cap top-15
  5. Honest notes (statistical power, survivorship, 1-year horizon needs pykrx backfill)
"""
from __future__ import annotations
import sys
try:  # 한글/em-dash 출력이 cp949 콘솔에서 죽지 않도록
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass
import warnings
import numpy as np
import pandas as pd

import config
import data as datamod
from features import build_panel, FEATURE_COLS
from labels import attach_labels
from wf import make_folds
from model import run_all_folds, fit_full
from backtest import backtest_universe
from budget import allocate

warnings.filterwarnings("ignore")
pd.set_option("display.width", 200)
pd.set_option("display.max_columns", 40)

SEP = "=" * 88


def _fmt_pct(x):
    return "   n/a" if x is None or (isinstance(x, float) and np.isnan(x)) else f"{x*100:6.2f}%"


def _fmt_f(x, d=3):
    return "  n/a" if x is None or (isinstance(x, float) and np.isnan(x)) else f"{x:.{d}f}"


def universe_mask(panel: pd.DataFrame, universe: str) -> pd.Series:
    if universe == "large":
        return panel["market_cap"] >= config.LARGE_CAP_MIN
    return panel["market_cap"] < config.SMALL_CAP_MAX


def main():
    print(SEP)
    print("LEAKAGE-SAFE STOCK RANKING ML PIPELINE  —  cost-aware comparison backtest")
    print(SEP)

    # ---------- 1. DATA ----------
    prices, fin, stocks = datamod.load_all()
    print("\n[1] DATA PULL SUMMARY")
    print(f"  stock_prices : {len(prices):,} rows | {prices['stock_code'].nunique()} stocks | "
          f"{prices['date'].nunique()} trading days | {prices['date'].min()}..{prices['date'].max()}")
    print(f"  financials   : {len(fin):,} annual PIT rows (report_code=11011, rcept_dt not null) | "
          f"market_cap notnull={fin['market_cap'].notna().sum()} | "
          f"rcept_dt {fin['rcept_dt'].min()}..{fin['rcept_dt'].max()}")
    print(f"  stocks       : {len(stocks):,} rows")

    # Build panel once (features are horizon-independent; labels depend on H)
    panel, mat, tdates = build_panel(prices, fin, stocks)
    rdates = sorted(panel["rebalance_date"].unique())
    print(f"  panel        : {len(panel):,} (T, stock) rows across {len(rdates)} rebalance dates "
          f"(monthly, step={config.REBALANCE_STEP}td, min_hist={config.MIN_PRICE_HISTORY}td)")
    print(f"  rebalance dates: {rdates}")
    lg = universe_mask(panel, 'large').sum()
    sm = universe_mask(panel, 'small').sum()
    print(f"  universe rows: large(>=1조)={lg:,} | small(<0.5조)={sm:,}")

    # Pre-attach labels per horizon (cross-sectional over the FULL panel each date)
    labelled_by_h = {H: attach_labels(panel, mat, tdates, H) for H in config.HORIZONS}

    # ---------- 2. 60D LARGE-CAP WALK-FORWARD ----------
    print("\n" + SEP)
    print("[2] 60-DAY LARGE-CAP WALK-FORWARD (purged, expanding window, H-day embargo)")
    print(SEP)
    H = 60
    lab60 = labelled_by_h[H]
    lab60_large = lab60[universe_mask(lab60, "large")].copy()
    rd_large = sorted(lab60_large["rebalance_date"].unique())
    folds60 = make_folds(rd_large, tdates, H)
    # a fold is only SCOREABLE if its test rebalance has a computable H-day forward label
    # (i.e. T+H is within the price history). Report this honestly vs embargo-clean count.
    scoreable60 = [f for f in folds60
                   if lab60_large[(lab60_large["rebalance_date"] == f["test_date"]) &
                                  lab60_large["has_label"]].shape[0] >= config.TOP_N]
    print(f"  eligible large-cap rebalance dates: {len(rd_large)} | embargo-clean folds (>{H}td): {len(folds60)} "
          f"| SCOREABLE folds (test has T+{H}d forward label in-history): {len(scoreable60)}")
    if len(scoreable60) < len(folds60):
        dropped = [f["test_date"] for f in folds60 if f not in scoreable60]
        print(f"  note: {len(folds60) - len(scoreable60)} embargo-clean fold(s) dropped — "
              f"test dates {dropped} have T+{H}d running off the end of the {tdates[-1]} history "
              f"(no forward return computable). Only {len(scoreable60)} 60d fold is truly evaluable.")
    metrics60 = run_all_folds(lab60_large, folds60)
    if metrics60.empty:
        print("  NO CLEAN FOLDS WITH BOTH CLASSES / ENOUGH ROWS — see notes on statistical power.")
    else:
        show = metrics60.copy()
        show["auc"] = show["auc"].map(lambda v: _fmt_f(v))
        show["ic"] = show["ic"].map(lambda v: _fmt_f(v))
        show["prec_at_n"] = show["prec_at_n"].map(_fmt_pct)
        show["pick_fwd_return"] = show["pick_fwd_return"].map(_fmt_pct)
        print("  Per-fold:")
        print(show.to_string(index=False))
        print(f"\n  AGGREGATE over {len(metrics60)} folds:  "
              f"mean IC={_fmt_f(metrics60['ic'].mean())} | "
              f"mean AUC={_fmt_f(metrics60['auc'].mean())} | "
              f"mean precision@{config.TOP_N}={_fmt_pct(metrics60['prec_at_n'].mean())} | "
              f"mean pick fwd-ret={_fmt_pct(metrics60['pick_fwd_return'].mean())}")

    # ---------- 3. COMPARISON GRID ----------
    print("\n" + SEP)
    print("[3] COST-AWARE COMPARISON GRID  {large>=1조, small<0.5조} x {H=60,3,1}")
    print(SEP)
    grid_rows = []
    for universe in config.UNIVERSES:
        is_large = universe == "large"
        for H in config.HORIZONS:
            lab = labelled_by_h[H]
            sub = lab[universe_mask(lab, universe)].copy()
            rd = sorted(sub["rebalance_date"].unique())
            folds = make_folds(rd, tdates, H)
            bt = backtest_universe(sub, folds, is_large, H)
            grid_rows.append({
                "universe": f"{universe}({'>=1조' if is_large else '<0.5조'})",
                "H": H,
                "n_folds": bt["n_folds"],
                "gross_cum": bt["gross_cum"],
                "net_cum": bt["net_cum"],
                "avg_gross": bt["avg_gross"],
                "avg_net": bt["avg_net"],
                "cost_drag": bt["avg_cost_drag"],
                "hit_rate": bt["avg_hit"],
                "turnover": bt["avg_turnover"],
                "ann_net": bt["ann_net"],
            })
    grid = pd.DataFrame(grid_rows)
    disp = grid.copy()
    for c in ["gross_cum", "net_cum", "avg_gross", "avg_net", "cost_drag", "hit_rate", "ann_net"]:
        disp[c] = disp[c].map(_fmt_pct)
    disp["turnover"] = disp["turnover"].map(lambda v: _fmt_pct(v))
    print(disp.to_string(index=False))
    print("\n  Reading: cost_drag = gross - net per rebalance (round-trip fees+tax+slippage). "
          "\n  Short horizons (H=3,1) rebalance far more often per year, so annualized cost erosion is largest there;"
          "\n  small-caps carry 5x the slippage (0.005 vs 0.001 per side).")

    # ---------- 4. BUDGET-BUY DEMO ----------
    print("\n" + SEP)
    print("[4] BUDGET-BUY DEMO  —  10,000,000 KRW on LATEST 60d large-cap top-15")
    print(SEP)
    H = 60
    lab60 = labelled_by_h[H]
    lab60_large = lab60[universe_mask(lab60, "large")].copy()
    rd_large = sorted(lab60_large["rebalance_date"].unique())
    # latest rebalance date that has enough embargoed training history
    folds60 = make_folds(rd_large, tdates, H)
    if not folds60:
        # fall back to the latest rebalance date and train on everything before it
        latest_T = rd_large[-1]
        train_dates = rd_large[:-1]
    else:
        latest_T = folds60[-1]["test_date"]
        train_dates = folds60[-1]["train_dates"]
    print(f"  scoring date (latest large-cap rebalance): {latest_T} | trained on {len(train_dates)} prior rebalances")
    clf = fit_full(lab60_large, train_dates) if train_dates else fit_full(lab60_large, rd_large)
    score_rows = lab60_large[lab60_large["rebalance_date"] == latest_T].copy()
    score_rows["pred"] = clf.predict_proba(score_rows[FEATURE_COLS])[:, 1]
    top = score_rows.nlargest(config.TOP_N, "pred").copy()
    top = top.merge(stocks[["stock_code", "corp_name"]], on="stock_code", how="left")
    top = top.rename(columns={"close_at_T": "close"})
    alloc = allocate(top[["stock_code", "corp_name", "close", "pred"]],
                     budget=config.DEFAULT_BUDGET_KRW)
    tbl = alloc.copy()
    tbl["종목"] = tbl["corp_name"].fillna(tbl["stock_code"]) + " (" + tbl["stock_code"] + ")"
    tbl["주수"] = tbl["shares"].astype(int)
    tbl["종가(원)"] = tbl["close"].map(lambda v: f"{v:,.0f}")
    tbl["금액(원)"] = tbl["amount"].map(lambda v: f"{v:,.0f}")
    tbl["비중"] = tbl["weight"].map(lambda v: f"{v*100:5.1f}%")
    print(tbl[["종목", "주수", "종가(원)", "금액(원)", "비중"]].to_string(index=False))
    print(f"\n  예산: {config.DEFAULT_BUDGET_KRW:,.0f}원 | 투자: {alloc.attrs['invested']:,.0f}원 | "
          f"잔여현금: {alloc.attrs['cash_left']:,.0f}원 | 예산소진율: {alloc.attrs['utilization']*100:.2f}% | "
          f"per-name cap: {config.MAX_NAME_WEIGHT*100:.1f}%")

    # ---------- 5. HONEST NOTES ----------
    print("\n" + SEP)
    print("[5] HONEST NOTES  —  validity, power, caveats")
    print(SEP)
    n60 = len(metrics60) if not metrics60.empty else 0
    print(f"""  * STATISTICAL POWER: with ~13 months of daily data (268 trading days) and monthly
    rebalancing, the 60d walk-forward yields only {n60} clean fold(s) after the H-day embargo.
    Any IC/AUC/return figure above is from a TINY sample — treat as a plumbing/leakage
    sanity check, NOT as evidence of a tradable edge. Confidence intervals are enormous.
  * LEAKAGE CONTROL: features at T use only closes with date<=T and the latest annual
    filing with rcept_dt<=T (point-in-time). Folds embargo the full H-day label horizon,
    so a test rebalance is always >H trading days after the last train rebalance. This is
    the correctness guarantee; small n is the honest cost of a short history.
  * COST REALISM: short horizons (H=3,1) compound round-trip costs many more times per
    year; small-caps add 5x slippage. If short/small NET returns look worse than large/60d
    NET, that is the costs doing exactly what they should — not a bug.
  * SURVIVORSHIP: the stocks table is a current-listing snapshot; delisted names that fell
    out of the price panel are underrepresented, which biases returns UPWARD. Real-world
    net results would be worse than shown.
  * HORIZON PARAMETERIZATION: H is a config knob (config.HORIZONS). A true 1-year label
    (H=252) is impossible with 268 trading days of history — it needs a pykrx backfill of
    several more years of daily closes; then set HORIZONS=[252,...] and re-run unchanged.
  * INTERPRETATION: if aggregate IC is near zero or negative and NET returns are weak, the
    honest conclusion is 'no demonstrable edge on this data' — which is the expected and
    valid outcome for 13 months of history.""")
    print("\n" + SEP)
    print("DONE.")
    print(SEP)


if __name__ == "__main__":
    main()
