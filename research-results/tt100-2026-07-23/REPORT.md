# TT100 research - 속도 vs 계좌 사망확률

Generated: 2026-07-23T07:14:13.822Z

## Mathematical reality

- Starting capital 6,000,000 KRW to 100,000,000 KRW is 16.67x. If the live balance is treated as about 6.1M, the multiple is about 16.4x.
- At CAGR 11-21%, the mathematical time to 100M from 6M is about 27.0-14.8 years. A 8-year arrival needs about 42.1% CAGR.
- P(6/12/24 months to 100M) should be treated as approximately zero for non-ruin strategies unless the strategy accepts extreme concentration or leverage.
- In the 2023-01-02 to 2026-06-11 backtest window, TT100 observations that do not hit 100M are right-censored, not infinite.
- Headline: 속도 vs 계좌 사망확률.

## Baseline parity check

Fixed baseline string:

```powershell
node backtest-swing.mjs --strategies combo-v2 --live-parity --skipneutralrsi --rsivol 1.25 --slots 3 --tp1r 0.5 --tp2r 1
```

Line mapping checked before research:

| Item | Live path | Backtest path | Result |
|---|---|---|---|
| Regime | stock-live.mjs:52-60 SMA20/60 after HMA rollback | backtest-swing.mjs:288 default proxy, backtest-swing.mjs:355-358 and :418 regimema 20,60 | match |
| RSI volume filter | strategy-contract.mjs:55-57 and stock-live.mjs:90 | backtest-swing.mjs:84 and :850 with --rsivol 1.25 | match |
| NEUTRAL rsi2 skip | strategy-contract.mjs:57 and stock-live.mjs:91 | backtest-swing.mjs:104 and :856 with --skipneutralrsi | match |
| Slots | strategy-contract.mjs:16, stock-live.mjs:317-323 | backtest-swing.mjs:84 with --slots 3, liveCandidateBudget at live-parity.mjs:51-64 | match |
| Partial TP | strategy-contract.mjs:81-84, stock-live.mjs:250-261 | backtest-swing.mjs:786-790 with trailPct 8, --tp1r 0.5, --tp2r 1 | match |

Safety: all runs used `NODE_OPTIONS=--import ./research-results/tt100-2026-07-23/cache-only-fetch-filter.mjs` and `--exclude 140910,204210,230980,451700,464680`. The preload permits Supabase reads and blocks non-Supabase fetches.

## Candidate definitions

- A-baseline: fixed live-parity baseline, SMA20/60 regime, skipNeutral RSI, rsiVol 1.25, slots 3, partial TP +4/+8.
- B-volsurge-sat: research-only volsurge sleeve with rsi2 and hi120 disabled, then 60/70/80 baseline barbell portfolios with a 35% satellite drawdown freeze.
- B-hi120-sat: research-only concentrated hi120 sleeve with rsi2 disabled, then 60/70/80 baseline barbell portfolios with a 35% satellite drawdown freeze.
- C-kelly: 0.25/0.5/0.75/1.0x fractional exposure proxy from baseline daily returns. Historical edge is estimated from baseline trades by sub only; no full Kelly deployment is considered.
- D-no-up-rsi: meta-filter proxy that removes UP-regime rsi2 entries. This is not a trained triple-barrier model and is marked as shadow-only at most because the same sample suggested the filter.
- Disclosure/AI catalyst sleeve: not backtested for TT100 because the disclosure/AI shadow sample is only about three months; it remains data collection only.

Raw outputs are under `research-results/tt100-2026-07-23/raw/`: backtest dumps/logs per candidate/run plus `*-tt100-derived.json` for derived TT100 evidence.

## Results

Conservative probabilities use the worse side of universe-subsample MC and block bootstrap: reach probabilities are the lower value, loss probabilities and worst MDD are the higher value. TT100 p25/median/p75 are Kaplan-Meier style right-censored estimates from the 15-year block-bootstrap paths; "censored" means the percentile was not identified inside the horizon.

| ID | Verdict | Base final | Base CAGR | Base MDD | P6M | P12M | P24M | Block P15Y | TT100 p25 | TT100 median | TT100 p75 | P<=50% | P>=70% loss | Trades | Turnover | Stress final / MDD |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A-baseline | NO_DEPLOY | 18,297,421 KRW | 39.1% | 17.4% | 0.0% | 0.0% | 0.0% | 100.0% | 1772 | 2202 | 2454 | 0.0% | 0.0% | 503 | 165.7x | 13,961,247 KRW / 19.6% |
| B-volsurge-sat | NO_DEPLOY | 2,201,399 KRW | -25.7% | 64.1% | 0.0% | 0.0% | 0.0% | 0.0% | censored | censored | censored | 100.0% | 100.0% | 363 | 111.0x | 1,416,617 KRW / 76.8% |
| B-hi120-sat | NO_DEPLOY | 17,362,129 KRW | 37.0% | 17.2% | 0.0% | 0.0% | 0.0% | 95.0% | 1744 | 2396 | 2750 | 0.0% | 0.0% | 155 | 41.0x | 16,447,055 KRW / 17.7% |
| D-no-up-rsi | SHADOW_ONLY | 22,577,530 KRW | 48.0% | 17.1% | 0.0% | 0.0% | 0.0% | 100.0% | 1679 | 1877 | 2165 | 0.0% | 0.0% | 311 | 103.7x | 17,738,822 KRW / 19.8% |
| B-volsurge-60-40 | NO_DEPLOY | 8,426,154 KRW | 10.6% | 23.4% | 0.0% | 0.0% | 0.0% | 5.0% | censored | censored | censored | 0.0% | 0.0% | 447 | 143.8x | 6,022,960 KRW / 37.8% |
| B-volsurge-70-30 | NO_DEPLOY | 10,306,934 KRW | 17.4% | 20.0% | 0.0% | 0.0% | 0.0% | 35.0% | 2971 | censored | censored | 0.0% | 0.0% | 461 | 149.3x | 7,493,406 KRW / 31.9% |
| B-volsurge-80-20 | NO_DEPLOY | 12,542,576 KRW | 24.4% | 18.1% | 0.0% | 0.0% | 0.0% | 75.0% | 2394 | 3155 | 3689 | 0.0% | 0.0% | 475 | 154.8x | 9,272,137 KRW / 26.7% |
| B-hi120-60-40 | NO_DEPLOY | 18,070,677 KRW | 38.6% | 14.4% | 0.0% | 0.0% | 0.0% | 100.0% | 1773 | 2312 | 2637 | 0.0% | 0.0% | 364 | 115.8x | 15,053,996 KRW / 15.7% |
| B-hi120-70-30 | NO_DEPLOY | 18,148,853 KRW | 38.8% | 15.2% | 0.0% | 0.0% | 0.0% | 100.0% | 1773 | 2357 | 2637 | 0.0% | 0.0% | 399 | 128.3x | 14,795,583 KRW / 16.7% |
| B-hi120-80-20 | NO_DEPLOY | 18,215,169 KRW | 38.9% | 15.9% | 0.0% | 0.0% | 0.0% | 100.0% | 1772 | 2351 | 2638 | 0.0% | 0.0% | 433 | 140.8x | 14,530,692 KRW / 17.7% |
| C-kelly-0p25x | NO_DEPLOY | 8,054,529 KRW | 9.1% | 4.6% | 0.0% | 0.0% | 0.0% | 0.0% | censored | censored | censored | 0.0% | 0.0% | 503 | 41.4x | 7,531,369 KRW / 5.1% |
| C-kelly-0p5x | NO_DEPLOY | 10,700,441 KRW | 18.7% | 9.0% | 0.0% | 0.0% | 0.0% | 35.0% | 3402 | censored | censored | 0.0% | 0.0% | 503 | 82.9x | 9,353,931 KRW / 10.0% |
| C-kelly-0p75x | NO_DEPLOY | 14,069,649 KRW | 28.7% | 13.2% | 0.0% | 0.0% | 0.0% | 95.0% | 2238 | 2665 | 3178 | 0.0% | 0.0% | 503 | 124.3x | 11,496,259 KRW / 14.9% |
| C-kelly-1x | NO_DEPLOY | 18,311,695 KRW | 39.1% | 17.4% | 0.0% | 0.0% | 0.0% | 100.0% | 1772 | 2202 | 2454 | 0.0% | 0.0% | 503 | 165.7x | 13,983,051 KRW / 19.6% |

## Worst paths

- Baseline base path: final 18,297,421 KRW, MDD 17.4%, TT100 censored at 838 trading days.
- Baseline universe MC worst MDD: 24.0%; worst final 11,866,929 KRW.
- Baseline block-bootstrap worst MDD: 38.7%; worst final 193,335,499 KRW.
- Highest conservative 24M reach probability: A-baseline at 0.0%.
- Lowest account-death risk tie-breaker: C-kelly-0p25x, P(70% loss) 0.0%, P(50% capital breach) 0.0%.

## Verdicts

| Candidate | Verdict | Reason |
|---|---|---|
| A-baseline | NO_DEPLOY | This is the current baseline; no live change is proposed. |
| B-volsurge-sat | NO_DEPLOY | No conservative TT100/reach improvement versus baseline.; Current-listed universe and same-day close signal treatment remain optimistic. |
| B-hi120-sat | NO_DEPLOY | No conservative TT100/reach improvement versus baseline.; Current-listed universe and same-day close signal treatment remain optimistic. |
| D-no-up-rsi | SHADOW_ONLY | Reach evidence improved versus baseline, but current-listed survivorship bias blocks live candidacy.; Needs forward shadow and point-in-time universe before promotion. |
| B-volsurge-60-40 | NO_DEPLOY | No conservative TT100/reach improvement versus baseline.; Current-listed universe and same-day close signal treatment remain optimistic. |
| B-volsurge-70-30 | NO_DEPLOY | No conservative TT100/reach improvement versus baseline.; Current-listed universe and same-day close signal treatment remain optimistic. |
| B-volsurge-80-20 | NO_DEPLOY | No conservative TT100/reach improvement versus baseline.; Current-listed universe and same-day close signal treatment remain optimistic. |
| B-hi120-60-40 | NO_DEPLOY | No conservative TT100/reach improvement versus baseline.; Current-listed universe and same-day close signal treatment remain optimistic. |
| B-hi120-70-30 | NO_DEPLOY | No conservative TT100/reach improvement versus baseline.; Current-listed universe and same-day close signal treatment remain optimistic. |
| B-hi120-80-20 | NO_DEPLOY | No conservative TT100/reach improvement versus baseline.; Current-listed universe and same-day close signal treatment remain optimistic. |
| C-kelly-0p25x | NO_DEPLOY | No conservative TT100/reach improvement versus baseline.; Current-listed universe and same-day close signal treatment remain optimistic. |
| C-kelly-0p5x | NO_DEPLOY | No conservative TT100/reach improvement versus baseline.; Current-listed universe and same-day close signal treatment remain optimistic. |
| C-kelly-0p75x | NO_DEPLOY | No conservative TT100/reach improvement versus baseline.; Current-listed universe and same-day close signal treatment remain optimistic. |
| C-kelly-1x | NO_DEPLOY | No conservative TT100/reach improvement versus baseline.; Current-listed universe and same-day close signal treatment remain optimistic. |

## Methodology and limitations

- Universe MC: `--subsample 0.8 x 20 seeds`.
- Block bootstrap: 3720 synthetic trading days, 20-day return blocks, 20 seeds.
- Cost stress: `--stress 1`, which doubles fee bps and uses 2-tick slippage in the existing backtest model.
- Same-day close signal/close buy mechanics remain optimistic relative to real execution; do not label satellite or derived curves as live-parity deployment evidence.
- Data is current-listed and excludes delisted names, so survivorship bias is present. This alone blocks LIVE_CANDIDATE.
- Disclosure/AI catalyst data is too short for TT100 validation in this window; it remains research/shadow-only input, not a backtestable live candidate.
- Barbell x satellite x Kelly x meta combinations create PBO risk. Treat any improvement as a hypothesis for shadow logging, not as a live setting.

## Separate live-account suggestions, not applied

No VM deploy, systemd restart, broker order, SSH/scp, or live file change was made. The only permissible next step from this evidence is shadow logging or a point-in-time/delisted-universe data upgrade; no strategy-contract.mjs, stock-live.mjs, or live-parity.mjs change is proposed here.
