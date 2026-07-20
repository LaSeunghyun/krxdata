"""Central config: universe thresholds, costs, backtest params.

All values verified against the prompt spec. Horizons are parameterized so H can
later become 252 (1-year) once a pykrx backfill extends the price history.
"""
from __future__ import annotations

# ---- Universe (uses PIT financials.market_cap in KRW 원; drop nulls) ----
LARGE_CAP_MIN = 1_000_000_000_000  # 1조원
SMALL_CAP_MAX = 500_000_000_000    # 0.5조원

# ---- Transaction costs (fractions of notional) ----
BUY_FEE = 0.00015
SELL_FEE = 0.00015
TRANSACTION_TAX = 0.0018           # sell side only (증권거래세)
SLIPPAGE = {"large": 0.001, "small": 0.005}  # per side

# ---- Portfolio ----
TOP_N = 15                         # picks per rebalance, equal-weight

# ---- Rebalance cadence & horizons (trading days) ----
REBALANCE_STEP = 21                # ~monthly across the 268-day history
HORIZONS = [60, 3, 1]             # swing / short / 단타 근사

# ---- Walk-forward ----
MIN_PRICE_HISTORY = 120            # trading days required at T for long-window features
MIN_TRAIN_REBALANCES = 2           # need at least this many train rebalances before first test fold

# ---- Comparison grid: (label, filter_fn) ----
UNIVERSES = ["large", "small"]

# ---- LightGBM ----
LGB_PARAMS = dict(
    objective="binary",
    n_estimators=200,
    learning_rate=0.05,
    num_leaves=15,
    min_child_samples=20,
    subsample=0.8,
    colsample_bytree=0.8,
    reg_lambda=1.0,
    random_state=42,
    n_jobs=-1,
    verbose=-1,
)

# ---- Budget-buy demo ----
DEFAULT_BUDGET_KRW = 10_000_000
MAX_NAME_WEIGHT = 1.0 / 8.0        # per-name cap ~1/8 of budget

CACHE_DIR = "_cache"


def side_slippage(is_large: bool) -> float:
    return SLIPPAGE["large"] if is_large else SLIPPAGE["small"]


# Round-trip cost as a fraction of notional (buy side + sell side) for a given cap class.
def round_trip_cost(is_large: bool) -> float:
    slip = side_slippage(is_large)
    buy_side = BUY_FEE + slip
    sell_side = SELL_FEE + TRANSACTION_TAX + slip
    return buy_side + sell_side
