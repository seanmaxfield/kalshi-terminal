#!/usr/bin/env python3
"""
Round 2: ML-enhanced band spreads with downside-organized portfolio simulation.

Uses cache/events.json from backtest.py. For each event, features are built
from the ladder's own dynamics across the three entry snapshots (far -> near):
  drift      : forward (ATM) movement between far and near snapshots, in strike steps
  |drift|    : magnitude (trend vs chop regime)
  band_cost  : combined ask cost of the symmetric band pair (cents)
  width_pct  : band width as % of forward (how wide the strikes are vs price)

Model: logistic regression (pure python GD) trained in-sample to predict
P(settlement lands INSIDE the band) -> both legs pay $2.
Decision: enter when modelEV = P*2 + (1-P)*1 - cost - fees > tau.
Variants:
  A baseline   : always enter (cost cap only)  [round-1 winner]
  B ml-filter  : enter only when modelEV > tau
  C ml+tilt    : ml-filter, and shift the band 1 strike in the drift direction
                 when |drift| > 0.6 steps (Markov-style: trends persist)

Downside organization (portfolio sim on OOS, chronological):
  bankroll $121 · size = min(4, 5% bankroll / cost) contracts per leg
  max loss per pair structurally = cost - $1 (one leg always pays)
  daily loss cap 8% of bankroll -> skip remaining signals that day
  report: equity curve stats, max drawdown, worst day
"""
import json, math, os, random
from collections import defaultdict
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_SPREAD = 15

with open(os.path.join(HERE, 'cache', 'events.json')) as f:
    EVENTS = json.load(f)

GROUPS = {
    'HOURLY': dict(series={'KXWTIH', 'KXGOLDH', 'KXSILVERH'}, offs=('50', '30', '15'), w=2, max_cost=185),
    'DAILY': dict(series={'KXWTI', 'KXNATGASD', 'KXBRENTD', 'KXCOPPERD'}, offs=('360', '180', '60'), w=1, max_cost=185),
}


def fee(cost_dollars):
    p = min(0.99, max(0.01, cost_dollars))
    return math.ceil(0.07 * p * (1 - p) * 100) / 100


def ladder(ev, off):
    out = []
    for s in ev['strikes']:
        q = s['snap'].get(off)
        if not q: continue
        b, a = q
        if a - b > MAX_SPREAD or a <= 0 or a >= 100: continue
        out.append(dict(k=s['k'], bid=b, ask=a, mid=(a + b) / 2, result=s['result']))
    return sorted(out, key=lambda x: x['k'])


def forward(lad):
    """interpolated strike where yes-mid crosses 50"""
    for i in range(len(lad) - 1):
        a, b = lad[i], lad[i + 1]
        if (a['mid'] - 50) * (b['mid'] - 50) <= 0 and a['mid'] != b['mid']:
            return a['k'] + (a['mid'] - 50) / (a['mid'] - b['mid']) * (b['k'] - a['k'])
    return None


def build_row(ev, g):
    far, mid_off, near = g['offs']
    lad_far, lad_near = ladder(ev, far), ladder(ev, near)
    if len(lad_near) < 4: return None
    F_far, F_near = forward(lad_far), forward(lad_near)
    if F_near is None: return None
    steps = [lad_near[i + 1]['k'] - lad_near[i]['k'] for i in range(len(lad_near) - 1)]
    step = sorted(steps)[len(steps) // 2]
    if step <= 0: return None
    drift = (F_near - F_far) / step if F_far is not None else 0.0

    i = min(range(len(lad_near)), key=lambda j: abs(lad_near[j]['mid'] - 50))
    w = g['w']
    if i - w < 0 or i + w >= len(lad_near): return None

    def pair(lo_idx, hi_idx):
        A, B = lad_near[lo_idx], lad_near[hi_idx]
        cost = A['ask'] / 100 + (100 - B['bid']) / 100
        fees = fee(A['ask'] / 100) + fee((100 - B['bid']) / 100)
        payoff = (1.0 if A['result'] == 'yes' else 0.0) + (1.0 if B['result'] == 'no' else 0.0)
        inside = A['result'] == 'yes' and B['result'] == 'no'
        return dict(cost=cost, fees=fees, payoff=payoff, inside=inside)

    sym = pair(i - w, i + w)
    # drift-tilted band: shift one strike toward the drift
    if drift > 0.6 and i + w + 1 < len(lad_near):
        tilt = pair(i - w + 1, i + w + 1)
    elif drift < -0.6 and i - w - 1 >= 0:
        tilt = pair(i - w - 1, i + w - 1)
    else:
        tilt = sym
    width_pct = (lad_near[i + w]['k'] - lad_near[i - w]['k']) / F_near * 100
    return dict(close=ev['close'], series=ev['series'],
                x=[drift, abs(drift), sym['cost'], width_pct],
                sym=sym, tilt=tilt)


# ---------------- logistic regression ----------------

def train_logit(X, y, iters=800, lr=0.5, l2=1e-3):
    n, d = len(X), len(X[0])
    mu = [sum(r[j] for r in X) / n for j in range(d)]
    sd = [max(1e-9, (sum((r[j] - mu[j]) ** 2 for r in X) / n) ** 0.5) for j in range(d)]
    Z = [[(r[j] - mu[j]) / sd[j] for j in range(d)] for r in X]
    w = [0.0] * d
    b = 0.0
    for _ in range(iters):
        gw = [0.0] * d
        gb = 0.0
        for zi, yi in zip(Z, y):
            p = 1 / (1 + math.exp(-min(30, max(-30, sum(wj * zj for wj, zj in zip(w, zi)) + b))))
            e = p - yi
            for j in range(d): gw[j] += e * zi[j]
            gb += e
        for j in range(d): w[j] = w[j] * (1 - lr * l2) - lr * gw[j] / n
        b -= lr * gb / n
    def predict(x):
        z = [(x[j] - mu[j]) / sd[j] for j in range(d)]
        return 1 / (1 + math.exp(-min(30, max(-30, sum(wj * zj for wj, zj in zip(w, z)) + b))))
    return predict, w


def stats(pnls):
    if not pnls: return None
    n = len(pnls)
    ev = sum(pnls) / n
    sd = (sum((p - ev) ** 2 for p in pnls) / max(1, n - 1)) ** 0.5
    t = ev / sd * math.sqrt(n) if sd > 0 else 0
    return dict(n=n, ev=ev, win=sum(1 for p in pnls if p > 0) / n, total=sum(pnls), sd=sd, t=t)


def portfolio_sim(trades, bankroll=121.0, risk=0.05, daily_cap=0.08):
    """trades: [(close_ts, pnl_per_ct, cost_per_ct)] chronological"""
    eq = bankroll
    peak = bankroll
    mdd = 0.0
    day_pnl = defaultdict(float)
    skipped = 0
    for ts, pnl, cost in sorted(trades):
        day = datetime.fromtimestamp(ts, tz=timezone.utc).date()
        if day_pnl[day] < -daily_cap * bankroll:
            skipped += 1; continue
        cts = max(1, min(4, int(eq * risk / cost)))
        eq += pnl * cts
        day_pnl[day] += pnl * cts
        peak = max(peak, eq)
        mdd = min(mdd, eq - peak)
    days = sorted(day_pnl.items())
    worst = min(day_pnl.values()) if day_pnl else 0
    pos_days = sum(1 for _, v in days if v > 0)
    return dict(final=eq, ret=eq - bankroll, mdd=mdd, worst_day=worst,
                days=len(days), pos_days=pos_days, skipped=skipped)


print(f"{'group':6s} {'variant':10s} {'tau':>5} | {'IS n':>4} {'EV':>7} {'win':>4} | {'OOS n':>5} {'EV':>7} {'win':>4} {'total':>7} {'t':>5}")
print('-' * 100)
best = {}
for gname, g in GROUPS.items():
    rows = [r for r in (build_row(ev, g) for ev in EVENTS if ev['series'] in g['series']) if r]
    rows.sort(key=lambda r: r['close'])
    cut = int(len(rows) * 0.6)
    IS, OOS = rows[:cut], rows[cut:]
    X = [r['x'] for r in IS]
    y = [1.0 if r['sym']['inside'] else 0.0 for r in IS]
    predict, wts = train_logit(X, y)

    def trades(rows, variant, tau):
        out = []
        for r in rows:
            leg = r['sym'] if variant != 'C' else r['tilt']
            if leg['cost'] * 100 > g['max_cost']: continue
            if variant in ('B', 'C'):
                P = predict(r['x'])
                ev_model = P * 2 + (1 - P) * 1 - leg['cost'] - leg['fees']
                if ev_model < tau: continue
            out.append((r['close'], leg['payoff'] - leg['cost'] - leg['fees'], leg['cost'] + leg['fees']))
        return out

    for variant, taus in [('A', [None]), ('B', [0.0, 0.03, 0.06]), ('C', [0.0, 0.03, 0.06])]:
        for tau in taus:
            is_st = stats([t[1] for t in trades(IS, variant, tau)])
            oo = trades(OOS, variant, tau)
            oos_st = stats([t[1] for t in oo])
            if not is_st or not oos_st or is_st['n'] < 15: continue
            print(f"{gname:6s} {variant:10s} {str(tau):>5} | {is_st['n']:>4} {is_st['ev']:>+7.3f} {is_st['win']:>4.0%} | "
                  f"{oos_st['n']:>5} {oos_st['ev']:>+7.3f} {oos_st['win']:>4.0%} {oos_st['total']:>+7.2f} {oos_st['t']:>5.2f}")
            key = (gname, variant, tau)
            if is_st['ev'] > 0 and oos_st['n'] >= 12:
                best[key] = (oos_st, oo)
    print(f"   [{gname}] logit weights (drift,|drift|,cost,width%): {[round(w,2) for w in wts]} · rows={len(rows)}")

# downside-organized portfolio sim on the best OOS variant per group
print('\nPORTFOLIO SIM (OOS only, $121 bankroll, 5% risk/trade cap 4ct, 8% daily loss cap):')
for gname in GROUPS:
    cands = {k: v for k, v in best.items() if k[0] == gname}
    if not cands: print(f'  {gname}: nothing qualified'); continue
    k = max(cands, key=lambda k: cands[k][0]['t'])
    oos_st, oo = cands[k]
    sim = portfolio_sim(oo)
    print(f"  {gname} best={k[1]} tau={k[2]}: OOS EV {oos_st['ev']:+.3f}/ct t={oos_st['t']:.2f} | "
          f"final ${sim['final']:.2f} ({sim['ret']:+.2f}) maxDD {sim['mdd']:.2f} worst day {sim['worst_day']:+.2f} "
          f"({sim['pos_days']}/{sim['days']} days positive, {sim['skipped']} skipped by daily cap)")
print('\nassumptions: ask-side entry, taker fees, hold to settle; structural max loss per pair = cost - $1.')
