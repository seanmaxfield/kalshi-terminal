#!/usr/bin/env python3
"""
Round 3: ML model bake-off + final algo with profit lockbox.

Models compared on the HOURLY band-entry decision (same features, same splits):
  LOGIT   logistic regression (round-2 incumbent)
  GBT     gradient-boosted stumps (80 rounds)
  KNN     k-nearest neighbors (k=25)
  MLP     small neural net (16 hidden)
  DTMINI  miniature Decision Transformer (arXiv:2106.01345): return-to-go
          conditioning + attention context over past (state, action, reward)
          steps, trained by behavior cloning on mixture-policy rollouts,
          actions sampled at inference conditioned on high target return.
          (A full causal transformer is inappropriate at n~570; this keeps the
          paper's two core mechanisms at a data-appropriate scale.)

DAILY stays rule-based (round 2 showed ML collapses its 40-event sample).

Final algo sim (OOS only): hourly trades filtered by the winning model +
daily rule trades; 5%-of-available-equity sizing (cap 4 ct), 8% daily stop,
and a LOCKBOX: 3% of each winning trade's profit moves to untouchable capital.
"""
import json, math, os
import numpy as np
from collections import defaultdict
from datetime import datetime, timezone

rng = np.random.default_rng(7)
HERE = os.path.dirname(os.path.abspath(__file__))
MAX_SPREAD = 15

with open(os.path.join(HERE, 'cache', 'events.json')) as f:
    EVENTS = json.load(f)

GROUPS = {
    'HOURLY': dict(series={'KXWTIH', 'KXGOLDH', 'KXSILVERH'}, offs=('50', '30', '15'), w=2, max_cost=185),
    'DAILY': dict(series={'KXWTI', 'KXNATGASD', 'KXBRENTD', 'KXCOPPERD'}, offs=('360', '180', '60'), w=1, max_cost=185),
}


def fee(cost):
    p = min(0.99, max(0.01, cost))
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
    for i in range(len(lad) - 1):
        a, b = lad[i], lad[i + 1]
        if (a['mid'] - 50) * (b['mid'] - 50) <= 0 and a['mid'] != b['mid']:
            return a['k'] + (a['mid'] - 50) / (a['mid'] - b['mid']) * (b['k'] - a['k'])
    return None


def build_row(ev, g):
    far, _, near = g['offs']
    lf, ln = ladder(ev, far), ladder(ev, near)
    if len(ln) < 4: return None
    Ff, Fn = forward(lf), forward(ln)
    if Fn is None: return None
    steps = [ln[i + 1]['k'] - ln[i]['k'] for i in range(len(ln) - 1)]
    step = sorted(steps)[len(steps) // 2]
    if step <= 0: return None
    drift = (Fn - Ff) / step if Ff is not None else 0.0
    i = min(range(len(ln)), key=lambda j: abs(ln[j]['mid'] - 50))
    w = g['w']
    if i - w < 0 or i + w >= len(ln): return None
    A, B = ln[i - w], ln[i + w]
    cost = A['ask'] / 100 + (100 - B['bid']) / 100
    fees = fee(A['ask'] / 100) + fee((100 - B['bid']) / 100)
    payoff = (1.0 if A['result'] == 'yes' else 0.0) + (1.0 if B['result'] == 'no' else 0.0)
    hour = datetime.fromtimestamp(ev['close'], tz=timezone.utc).hour
    width = (ln[i + w]['k'] - ln[i - w]['k']) / Fn * 100
    return dict(close=ev['close'], series=ev['series'],
                x=[drift, abs(drift), cost, width, math.sin(2 * math.pi * hour / 24), math.cos(2 * math.pi * hour / 24)],
                cost=cost, fees=fees, payoff=payoff,
                inside=1.0 if payoff == 2.0 else 0.0,
                pnl=payoff - cost - fees)


def stats(pnls):
    if len(pnls) == 0: return None
    p = np.asarray(pnls)
    ev = p.mean(); sd = p.std(ddof=1) if len(p) > 1 else 0
    return dict(n=len(p), ev=ev, win=float((p > 0).mean()), total=p.sum(), sd=sd,
                t=float(ev / sd * math.sqrt(len(p))) if sd > 0 else 0)


# ---------------- models (all: fit(X,y) -> predict_proba(X)) ----------------

def standardizer(X):
    mu, sd = X.mean(0), X.std(0) + 1e-9
    return lambda A: (A - mu) / sd


class Logit:
    def fit(self, X, y):
        self.z = standardizer(X); Z = self.z(X)
        w = np.zeros(Z.shape[1]); b = 0.0
        for _ in range(800):
            p = 1 / (1 + np.exp(-np.clip(Z @ w + b, -30, 30)))
            e = p - y
            w = w * (1 - 0.5 * 1e-3) - 0.5 * (Z.T @ e) / len(y)
            b -= 0.5 * e.mean()
        self.w, self.b = w, b
    def predict_proba(self, X):
        Z = self.z(X)
        return 1 / (1 + np.exp(-np.clip(Z @ self.w + self.b, -30, 30)))


class GBTStumps:
    def __init__(self, rounds=80, lr=0.1): self.rounds, self.lr = rounds, lr
    def fit(self, X, y):
        self.f0 = math.log(max(1e-6, y.mean()) / max(1e-6, 1 - y.mean()))
        F = np.full(len(y), self.f0); self.trees = []
        for _ in range(self.rounds):
            p = 1 / (1 + np.exp(-F)); g = y - p
            best = None
            for j in range(X.shape[1]):
                for q in (20, 35, 50, 65, 80):
                    thr = np.percentile(X[:, j], q)
                    L = X[:, j] <= thr
                    if L.sum() < 8 or (~L).sum() < 8: continue
                    vl, vr = g[L].mean(), g[~L].mean()
                    gain = L.sum() * vl * vl + (~L).sum() * vr * vr
                    if best is None or gain > best[0]: best = (gain, j, thr, vl, vr)
            if best is None: break
            _, j, thr, vl, vr = best
            F += self.lr * np.where(X[:, j] <= thr, vl, vr)
            self.trees.append((j, thr, vl, vr))
    def predict_proba(self, X):
        F = np.full(len(X), self.f0)
        for j, thr, vl, vr in self.trees:
            F += self.lr * np.where(X[:, j] <= thr, vl, vr)
        return 1 / (1 + np.exp(-F))


class KNN:
    def __init__(self, k=25): self.k = k
    def fit(self, X, y):
        self.z = standardizer(X); self.Z = self.z(X); self.y = y
    def predict_proba(self, X):
        Z = self.z(X); out = np.empty(len(Z))
        for i, zi in enumerate(Z):
            d = ((self.Z - zi) ** 2).sum(1)
            out[i] = self.y[np.argsort(d)[:self.k]].mean()
        return out


class MLP:
    def __init__(self, h=16, epochs=400, lr=0.05): self.h, self.epochs, self.lr = h, epochs, lr
    def fit(self, X, y):
        self.z = standardizer(X); Z = self.z(X)
        d = Z.shape[1]
        W1 = rng.normal(0, 0.5, (d, self.h)); b1 = np.zeros(self.h)
        W2 = rng.normal(0, 0.5, self.h); b2 = 0.0
        for _ in range(self.epochs):
            H = np.tanh(Z @ W1 + b1)
            p = 1 / (1 + np.exp(-np.clip(H @ W2 + b2, -30, 30)))
            e = (p - y) / len(y)
            gW2 = H.T @ e; gb2 = e.sum()
            gH = np.outer(e, W2) * (1 - H ** 2)
            W1 -= self.lr * (Z.T @ gH + 1e-3 * W1); b1 -= self.lr * gH.sum(0)
            W2 -= self.lr * (gW2 + 1e-3 * W2); b2 -= self.lr * gb2
        self.W1, self.b1, self.W2, self.b2 = W1, b1, W2, b2
    def predict_proba(self, X):
        H = np.tanh(self.z(X) @ self.W1 + self.b1)
        return 1 / (1 + np.exp(-np.clip(H @ self.W2 + self.b2, -30, 30)))


class DTMini:
    """Miniature Decision Transformer: behavior cloning of a mixture policy,
    conditioned on return-to-go, with kernel-attention context over the last K
    (state, action, reward) steps. Inference conditions on a high target RTG."""
    def __init__(self, K=16, rollouts=20, epochs=300, lr=0.05, h=16):
        self.K, self.rollouts, self.epochs, self.lr, self.h = K, rollouts, epochs, lr, h

    def _context(self, Zseq, aseq, rseq, t):
        lo = max(0, t - self.K)
        if t == lo: return np.zeros(Zseq.shape[1] + 2)
        C = Zseq[lo:t]; sim = -((C - Zseq[t]) ** 2).sum(1) / (2 * self.hband)
        wgt = np.exp(sim - sim.max()); wgt /= wgt.sum()
        feat = np.concatenate([C, np.asarray(aseq[lo:t])[:, None], np.asarray(rseq[lo:t])[:, None]], 1)
        return wgt @ feat

    def fit(self, X, y, pnl, series):
        self.z = standardizer(X); Z = self.z(X)
        d2 = ((Z[None, :, :] - Z[:, None, :]) ** 2).sum(-1)
        self.hband = max(1e-6, np.median(d2))
        rows_in, rows_g, rows_c, rows_a = [], [], [], []
        order = np.arange(len(y))
        for _ in range(self.rollouts):
            a = rng.integers(0, 2, len(y)).astype(float)
            r = a * pnl
            # per-series chronological trajectories with return-to-go
            for s in set(series):
                idx = order[np.asarray(series) == s]
                rtg = np.cumsum(r[idx][::-1])[::-1]
                for j, t in enumerate(idx):
                    rows_in.append(Z[t]); rows_g.append(rtg[j])
                    rows_c.append(self._context(Z[idx], a[idx], r[idx], j))
                    rows_a.append(a[t])
        A = np.column_stack([np.asarray(rows_in), np.asarray(rows_g)[:, None], np.asarray(rows_c)])
        # standardize the RTG/context columns too
        self.z2 = standardizer(A); A = self.z2(A)
        t_ = np.asarray(rows_a)
        d = A.shape[1]
        W1 = rng.normal(0, 0.4, (d, self.h)); b1 = np.zeros(self.h)
        W2 = rng.normal(0, 0.4, self.h); b2 = 0.0
        # weight BC toward high-RTG samples (learn what good trajectories do)
        gcol = np.asarray(rows_g)
        wsample = np.exp((gcol - gcol.mean()) / (gcol.std() + 1e-9))
        wsample /= wsample.mean()
        for _ in range(self.epochs):
            H = np.tanh(A @ W1 + b1)
            p = 1 / (1 + np.exp(-np.clip(H @ W2 + b2, -30, 30)))
            e = (p - t_) * wsample / len(t_)
            gW2 = H.T @ e; gb2 = e.sum()
            gH = np.outer(e, W2) * (1 - H ** 2)
            W1 -= self.lr * (A.T @ gH + 1e-3 * W1); b1 -= self.lr * gH.sum(0)
            W2 -= self.lr * (gW2 + 1e-3 * W2); b2 -= self.lr * gb2
        self.net = (W1, b1, W2, b2)
        self.g_hi = np.percentile(gcol, 90)  # inference: condition on high RTG
        self.trainZ = Z; self.train_pnl = pnl; self.train_series = series

    def predict_proba(self, X):
        Z = self.z(X)
        W1, b1, W2, b2 = self.net
        out = np.empty(len(Z))
        # context at inference: attention over ALL training steps under an
        # optimistic (enter-when-profitable) reference policy
        ref_a = (self.train_pnl > 0).astype(float)
        ref_r = ref_a * self.train_pnl
        feat = np.concatenate([self.trainZ, ref_a[:, None], ref_r[:, None]], 1)
        for i, zi in enumerate(Z):
            sim = -((self.trainZ - zi) ** 2).sum(1) / (2 * self.hband)
            wgt = np.exp(sim - sim.max()); wgt /= wgt.sum()
            ctx = wgt @ feat
            a_in = self.z2(np.concatenate([zi, [self.g_hi], ctx])[None, :])
            H = np.tanh(a_in @ W1 + b1)
            out[i] = (1 / (1 + np.exp(-np.clip(H @ W2 + b2, -30, 30))))[0]
        return out


# ---------------- bake-off ----------------
g = GROUPS['HOURLY']
rows = [r for r in (build_row(ev, g) for ev in EVENTS if ev['series'] in g['series']) if r]
rows.sort(key=lambda r: r['close'])
rows = [r for r in rows if r['cost'] * 100 <= g['max_cost']]
cut = int(len(rows) * 0.6)
IS, OOS = rows[:cut], rows[cut:]
Xi = np.asarray([r['x'] for r in IS]); yi = np.asarray([r['inside'] for r in IS])
pi = np.asarray([r['pnl'] for r in IS]); si = [r['series'] for r in IS]
Xo = np.asarray([r['x'] for r in OOS])

print(f'HOURLY bake-off: {len(rows)} band candidates | IS {len(IS)} OOS {len(OOS)}')
print(f'{"model":8s} {"tau":>5} | {"IS n":>4} {"EV":>7} {"win":>4} | {"OOS n":>5} {"EV":>7} {"win":>4} {"total":>7} {"t":>5}')
print('-' * 92)

MODELS = {'LOGIT': Logit(), 'GBT': GBTStumps(), 'KNN': KNN(), 'MLP': MLP(), 'DTMINI': DTMini()}
results = {}
for name, model in MODELS.items():
    if name == 'DTMINI':
        model.fit(Xi, yi, pi, si)
    else:
        model.fit(Xi, yi)
    Pi, Po = model.predict_proba(Xi), model.predict_proba(Xo)

    def dec(rows_, P, tau):
        return [r['pnl'] for r, p in zip(rows_, P)
                if p * 2 + (1 - p) * 1 - r['cost'] - r['fees'] > tau]
    # DT-mini outputs an action prob, not P(inside): use p>0.5 rule
    def dec_dt(rows_, P, tau=None):
        return [r['pnl'] for r, p in zip(rows_, P) if p > 0.5]

    picker = dec_dt if name == 'DTMINI' else dec
    best = None
    for tau in ([None] if name == 'DTMINI' else [0.0, 0.03, 0.06]):
        st = stats(picker(IS, Pi, tau))
        if st and st['n'] >= 40 and (best is None or st['ev'] > best[1]['ev']):
            best = (tau, st)
    if best is None:
        print(f'{name:8s}  (fewer than 40 IS trades at every threshold)'); continue
    tau, is_st = best
    oos_pnls = picker(OOS, Po, tau)
    oos_st = stats(oos_pnls)
    o = oos_st or dict(n=0, ev=float('nan'), win=float('nan'), total=float('nan'), t=float('nan'))
    print(f'{name:8s} {str(tau):>5} | {is_st["n"]:>4} {is_st["ev"]:>+7.3f} {is_st["win"]:>4.0%} | '
          f'{o["n"]:>5} {o["ev"]:>+7.3f} {o["win"]:>4.0%} {o["total"]:>+7.2f} {o["t"]:>5.2f}')
    if oos_st and is_st['ev'] > 0:
        results[name] = (tau, model, oos_st)

winner = max(results, key=lambda k: results[k][2]['t'])
print(f'\n>>> bake-off winner: {winner} (OOS t={results[winner][2]["t"]:.2f})')

# ---------------- final algo: winner-filtered hourly + rule daily + lockbox ----------------
gd = GROUPS['DAILY']
drows = [r for r in (build_row(ev, gd) for ev in EVENTS if ev['series'] in gd['series']) if r]
drows.sort(key=lambda r: r['close'])
dcut = int(len(drows) * 0.6)
dOOS = [r for r in drows[dcut:] if r['cost'] * 100 <= gd['max_cost']]

tau, model, _ = results[winner]
Po = model.predict_proba(Xo)
if winner == 'DTMINI':
    h_trades = [(r['close'], r['pnl'], r['cost'] + r['fees']) for r, p in zip(OOS, Po) if p > 0.5]
else:
    h_trades = [(r['close'], r['pnl'], r['cost'] + r['fees']) for r, p in zip(OOS, Po)
                if p * 2 + (1 - p) * 1 - r['cost'] - r['fees'] > tau]
d_trades = [(r['close'], r['pnl'], r['cost'] + r['fees']) for r in dOOS]
all_trades = sorted(h_trades + d_trades)

def final_sim(trades, bankroll=121.0, risk=0.05, cap=4, daily_stop=0.08, skim=0.03):
    equity, lockbox = bankroll, 0.0
    curve, day_pnl = [], defaultdict(float)
    wins = 0
    for ts, pnl, cost in trades:
        day = datetime.fromtimestamp(ts, tz=timezone.utc).date()
        if day_pnl[day] <= -daily_stop * bankroll: continue
        avail = equity - lockbox
        cts = max(1, min(cap, int(avail * risk / cost)))
        gain = pnl * cts
        equity += gain
        day_pnl[day] += gain
        if gain > 0:
            wins += 1
            put = skim * gain          # lockbox skim: 3% of the win's profit
            lockbox += put
        curve.append((ts, equity, lockbox))
    return equity, lockbox, curve, day_pnl, wins

equity, lockbox, curve, day_pnl, wins = final_sim(all_trades)
eq_nolock = final_sim(all_trades, skim=0.0)[0]

# performance summary
pnls = np.asarray([t[1] for t in all_trades])
eqs = np.asarray([c[1] for c in curve])
trade_dd = float((eqs - np.maximum.accumulate(eqs)).min())  # trade/hourly-resolution DD
days = sorted(day_pnl.items())
day_vals = np.asarray([v for _, v in days])
eod = np.cumsum(day_vals) + 121.0
daily_dd = float((eod - np.maximum.accumulate(eod)).min())
weeks = defaultdict(float)
for d, v in days: weeks[d.isocalendar()[:2]] += v
wk = np.asarray(list(weeks.values()))
span_days = (all_trades[-1][0] - all_trades[0][0]) / 86400

print(f'''
FINAL ALGO — OOS period ({span_days:.0f} days), $121 start, {winner}-filtered hourly + rule daily
  trades: {len(all_trades)} ({len(h_trades)} hourly + {len(d_trades)} daily)
  WIN RATE:            {float((pnls > 0).mean()):.1%}
  HOURLY (trade) MAX DD: {trade_dd:+.2f} $
  DAILY MAX DD:          {daily_dd:+.2f} $
  DAILY EARNING AVG:     {day_vals.mean():+.2f} $/day  ({len(days)} active days, {int((day_vals > 0).sum())} positive)
  WEEKLY EARNING STDEV:  {wk.std(ddof=1) if len(wk) > 1 else 0:.2f} $  (weekly avg {wk.mean():+.2f} over {len(wk)} weeks)
  FINAL EQUITY:          ${equity:.2f}  (lockbox ${lockbox:.2f} inside, untouchable)
  LOCKBOX DRAG:          ${eq_nolock - equity:.2f} vs no-lockbox (skim 3% of winning profits only)
''')
