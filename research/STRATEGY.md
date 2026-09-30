# Commodity Ladder Strategy Research — 2026-08-04

**Not financial advice — research tooling output.** Backtests on real settled Kalshi
markets with taker fees and ask-side entries. Rerun anytime: `python3 research/backtest.py collect && python3 research/backtest.py eval`.

## Your trading record (context)

- All-time settled: **−$2,483** · biggest holes: golf winner bets (0W/8L, −$1,894), WTI hourlies (13W/18L, −$286)
- Commodities spreads overall: modest losses, not catastrophic — the structure is fine, the execution is expensive
- **94/99 fills were taker** — you pay the spread AND the 7%·p·(1−p) fee on nearly every entry
- Current capital: ~$121 cash + ~$6 marked positions

## Dataset

664 settled ladder events, entry snapshots rebuilt from real candles:
- HOURLY: 592 events / 18.2 days (WTIH 276, GOLDH 158, SILVERH 158)
- DAILY: 72 events / 70.1 days (WTI 48, NATGASD 24)
- Execution model: buy at ask, taker fee per leg, hold to settlement, skip quotes wider than 15¢

## Findings (in-sample 60% → out-of-sample 40%, 3-fold stability)

| Verdict | Strategy | Evidence |
|---|---|---|
| **DEPLOYABLE (small)** | **DAILY BAND**: ~60 min before daily settle, buy YES 1 strike below ATM + NO 1 strike above, only if combined cost ≤ $1.85 | IS +11.7¢, OOS **+15.2¢/pair** (64% win), folds +10.2/+12.3/+16.7¢ — positive in every fold. t≈1.7 (suggestive, not proof) |
| Marginal — do not deploy | HOURLY BAND (2 strikes wide, 15 min out, ≤$1.85) | OOS +3.4¢ but folds +2.0/+5.7/**+0.2** — edge evaporates in the latest fold |
| Dead after fees | SELLTAIL (buy expensive NO on favorites) | 90%+ win rate, OOS EV ≈ 0. The pennies exactly pay the fees |
| **NEVER DO** | LONGSHOT (buy cheap tails ≤20¢) | Negative everywhere, OOS t = −3.0 to −3.3. Longshot bias is real on these ladders |
| **NEVER DO** | BREAKOUT (buy both wings, bet on a move) | The most significant result in the study: OOS −10 to −24¢/pair, t up to −4.9 |

## The recommended playbook (research conclusion, sized to $121)

1. **Trade only the DAILY BAND setup**: WTI + NatGas daily ladders, ~1h before settle,
   YES(ATM−1) + NO(ATM+1), skip if combined ask > $1.85. ~1 signal/day.
2. **Size 4 contracts/leg** (≈$7 max loss per trade ≈ 6% of bankroll).
   Historical projection: **≈ +$0.52/day ± $0.31 SE** — i.e., roughly +$10–15/month
   on this bankroll if the edge persists. It may not.
3. **Stop the bleeders**: no golf/field longshots, no cheap tails, no breakout wings,
   no hourly churn — those are where the −$2,483 came from.
4. **Become a maker**: your 95% taker share costs the spread + fee every time.
   Resting the BAND legs at mid instead of crossing would add ~2–4¢/leg — that
   roughly *doubles* the measured edge and drops the fee to zero. This is the
   single highest-value change and costs only patience.
5. **Kill-switch rule**: if 10 consecutive trades net negative, or drawdown hits
   15% of bankroll, stop and re-run the backtest — the regime has changed.

## Caveats

- t-stats < 2 everywhere positive: the daily-band edge is *consistent* but not
  statistically proven; 72 daily events is a thin sample.
- Data covers a violent oil regime (~80% realized vol). A calm regime may erase
  the band edge (bands win when moves are smaller than priced).
- No slippage modeled beyond paying the full ask; thin books can be worse.
- Automation: the setup detection is mechanical and can be wired as an in-app
  scanner/alert. Auto-execution should run on the DEMO exchange first.

---

# Round 2 addendum — 2026-08-04 (evening)

## P&L correction

The round-1 "−$2,483 all-time" figure was **wrong** and is retracted. Settlement
records carry the cumulative cost of every contract ever bought in a market —
including contracts sold before settlement (whose exit proceeds live in fills).
The authoritative settlement credit is the `revenue` field (cents). The golf
"losses" were phantom accounting on positions that were exited.
Corrected view since Jul 31 2:00 PM ET: $354.85 bought / $353.77 sold /
$11.20 fees / ~$755 settlement credits on carried-in positions — consistent
with roughly flat-to-slightly-up net of the $50 deposit. The in-app daily
report now uses `revenue` too.

## ML upgrade (backtest2.py, same 664-event cache)

Features per event, from the ladder's own dynamics between entry snapshots:
forward drift (strike-steps), |drift|, band cost, band width % of forward.
Logistic regression trained in-sample to predict P(settle inside band).

| Group | Variant | OOS n | OOS EV/pair | win | t |
|---|---|---|---|---|---|
| HOURLY | A always-enter | 209 | +3.1¢ | 73% | 1.01 |
| HOURLY | **B ML-filter (τ=0)** | **92** | **+9.8¢** | **75%** | **2.13** |
| HOURLY | C drift-tilt | 149 | −2.9¢ | 61% | −0.73 |
| DAILY | **A always-enter** | **27** | **+17.6¢** | **67%** | **1.96** |
| DAILY | B ML-filter | 2 | (sample collapsed) | | |

What the hourly model learned (weights): high **|drift| hurts** bands (−0.23) —
trending hours blow through the band; **higher band cost helps** (+0.39) — the
market's own inside-probability pricing carries signal. Drift-TILTING the band
(Markov trend-following) fails OOS: drift is already priced.

## Downside organization (portfolio sim, OOS only, $121 start)

Rules: 5% risk/trade (≤4 contracts), structural max loss per pair = cost − $1
(≤85¢ at the $1.85 cap), 8% daily loss cap stops the day.

- HOURLY ML-filtered: final $152.85 (+$31.85) · max drawdown −$8.16 · worst day −$3.92
- DAILY baseline: final $138.57 (+$17.57 over 16 days) · max DD −$3.88 · 10/16 days positive

## Deployment plan (research conclusion)

1. DAILY band unchanged: 1h before settle, ATM±1, cost ≤ $1.85 (~1/day).
2. HOURLY band ONLY with the ML filter (drift/|drift|/cost/width logit, τ=0);
   skip trending hours. Retrain weekly from fresh settled data.
3. Sizing/stops as simmed above; kill-switch: 10 straight losers or −15% bankroll.
4. Maker entries where patience allows — adds ~2–4¢/leg vs these taker-priced numbers.

Caveats: hourly OOS spans only ~5 trading days of one violent oil regime;
DAILY t=1.96 / HOURLY-B t=2.13 are encouraging, not conclusive. Paper-trade
forward on demo before real size.

---

# Round 3 addendum — ML bake-off + lockbox algo (backtest3.py)

Same features/splits for every model; hourly band candidates n=531 (IS 318 / OOS 213).

| Model | OOS n | OOS EV/pair | win | t |
|---|---|---|---|---|
| **KNN (k=25, τ=.06)** | **56** | **+16.0¢** | **79%** | **2.84** |
| LOGIT (τ=0) | 102 | +10.3¢ | 76% | 2.44 |
| GBT stumps | 39 | +7.6¢ | 62% | 0.95 |
| MLP-16 | 51 | +6.9¢ | 71% | 1.10 |
| DT-mini (arXiv:2106.01345) | 52 | **−8.8¢** | 54% | −1.19 |

Decision Transformer verdict: with ~500 samples the return-conditioned
sequence model underperforms everything, including always-enter. DT is built
for large offline-RL corpora; at this scale simple local models are the right
tool. Two independent models (KNN, LOGIT) clearing t≈2.4–2.8 on the same
regime-filter signal is the meaningful confirmation.

## Final algo (OOS, 21 days, $121 start): KNN-filtered hourly + rule daily
83 trades (56 hourly + 27 daily), 5% sizing cap 4ct, 8% daily stop,
**lockbox: 3% of each winning trade's profit set aside untouchable**.

- WIN RATE **74.7%**
- HOURLY (trade-resolution) MAX DD **−$8.04** · DAILY MAX DD **−$5.08**
- DAILY EARNING AVG **+$3.14** (12/17 active days positive)
- WEEKLY: avg **+$13.33**, STDEV **$8.26** (4 weeks)
- FINAL EQUITY **$174.33** · LOCKBOX **$2.98**
- LOCKBOX COMPOUNDING DRAG: **$0.00** — the 3%-of-profit skim sits below the
  integer contract-sizing granularity, so it never shrank a position.

Caveats: 3-week OOS in a violent commodity regime; +44%/3wk will not
extrapolate; KNN threshold chosen in-sample; retrain weekly and paper-trade
on demo before real size. Kill-switch rules from round 1 still apply.

---

# Round 4 addendum — deeper history (1,111 events, back to May 26)

Added 447 events: Brent + Copper dailies (82, from May 26), deeper NatGas,
and the full hourly archive (series launched ~Jul 16). Daily group now spans
**70 days across 4 commodities** — including the calmer June regime.

## Hourly bake-off, deep data (854 candidates | IS 512 / OOS 342)

| Model | OOS n | EV/pair | win | t |
|---|---|---|---|---|
| **KNN** | 163 | **+12.9¢** | 75% | **3.84** |
| LOGIT | 129 | +11.7¢ | 73% | 3.00 |
| MLP | 128 | +9.5¢ | 72% | 2.43 |
| GBT | 134 | +8.3¢ | 66% | 2.02 |
| DT-mini | 110 | +3.0¢ | 60% | 0.63 |

Four independent models now clear t≥2 on the same signal — the regime filter
is model-robust, not an artifact of one architecture. DT-mini improved with
more data (−8.8¢ → +3.0¢), consistent with its data-scaling premise, but
remains the weakest — verdict unchanged.

## Daily rule on the longer window
OOS 55 trades: **+13.9¢/pair, 75% win, t=2.48** — the edge held through the
calmer May–June regime, not just the August vol spike. Drift-tilt still fails.

## Final algo, 27-day OOS, $121 start
218 trades (163 hourly KNN-filtered + 55 daily rule) ·
WIN RATE **74.8%** · trade-res MAX DD **−$12.60** · daily MAX DD **−$5.08** ·
DAILY AVG **+$5.30** (16/21 days positive) · WEEKLY avg **+$22.28**, stdev
**$29.52** (5 wks; one outsized week drives the stdev) ·
FINAL **$232.39** · lockbox **$7.05** · lockbox drag **$0.00**.
