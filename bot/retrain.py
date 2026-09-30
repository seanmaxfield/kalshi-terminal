#!/usr/bin/env python3
"""
Nightly retrain: collect fresh settled ladders straight from Kalshi (public
endpoints), rebuild the KNN training set, champion/challenger-gate it, and
write state/model.json. Run manually or via the systemd timer.
"""
import json, math, os
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from common import Kalshi, load_config, jread, jwrite, log, cents, fee

HERE = os.path.dirname(os.path.abspath(__file__))

HOURLY = {'KXWTIH': None, 'KXGOLDH': None, 'KXSILVERH': None}
OFFSETS = (50, 30, 15)  # minutes before close: far, mid, near
MAX_SPREAD = 15
MAX_EVENTS_PER_SERIES = int(os.environ.get('RETRAIN_MAX_EVENTS', 400))


def collect(api):
    rows = []
    for series in HOURLY:
        markets, cursor = [], ''
        while len(markets) < MAX_EVENTS_PER_SERIES * 40:
            d = api.get(f'/markets?series_ticker={series}&status=settled&limit=1000'
                        + (f'&cursor={cursor}' if cursor else ''))
            markets += d.get('markets', [])
            cursor = d.get('cursor') or ''
            if not cursor: break
        by_ev = defaultdict(list)
        for m in markets:
            if m.get('floor_strike') is not None and m.get('result') in ('yes', 'no'):
                by_ev[m['event_ticker']].append(m)
        events = sorted(([et, ms] for et, ms in by_ev.items() if len(ms) >= 5),
                        key=lambda kv: max(m['close_time'] for m in kv[1]), reverse=True)
        events = events[:MAX_EVENTS_PER_SERIES]
        log(f'retrain: {series} {len(events)} settled events')

        def fetch(item):
            et, ms = item
            ms = sorted(ms, key=lambda m: m['floor_strike'])
            close_ts = int(datetime.fromisoformat(ms[0]['close_time'].replace('Z', '+00:00')).timestamp())
            start = close_ts - (max(OFFSETS) + 5) * 60
            strikes = []
            for m in ms:
                try:
                    c = api.get(f"/series/{series}/markets/{m['ticker']}/candlesticks"
                                f"?start_ts={start}&end_ts={close_ts}&period_interval=1")
                except Exception:
                    continue
                quotes = {}
                for ck in c.get('candlesticks', []):
                    b = cents((ck.get('yes_bid') or {}).get('close_dollars'))
                    a = cents((ck.get('yes_ask') or {}).get('close_dollars'))
                    if b is not None and a is not None:
                        quotes[ck['end_period_ts']] = (b, a)
                snap = {}
                for off in OFFSETS:
                    tgt = close_ts - off * 60
                    best = None
                    for ts, q in quotes.items():
                        if ts <= tgt and (best is None or ts > best[0]): best = (ts, q)
                    if best and tgt - best[0] <= 180: snap[off] = best[1]
                strikes.append(dict(k=m['floor_strike'], result=m['result'], snap=snap))
            return dict(series=series, close=close_ts, strikes=strikes)

        with ThreadPoolExecutor(max_workers=4) as ex:
            for ev in ex.map(fetch, events):
                r = to_row(ev)
                if r: rows.append(r)
    rows.sort(key=lambda r: r['close'])
    return rows


def to_row(ev, w=2):
    def ladder(off):
        out = []
        for s in ev['strikes']:
            q = s['snap'].get(off)
            if not q: continue
            b, a = q
            if a - b > MAX_SPREAD or a <= 0 or a >= 100: continue
            out.append(dict(k=s['k'], bid=b, ask=a, mid=(a + b) / 2, result=s['result']))
        return sorted(out, key=lambda x: x['k'])

    def fwd(lad):
        for i in range(len(lad) - 1):
            a, b = lad[i], lad[i + 1]
            if (a['mid'] - 50) * (b['mid'] - 50) <= 0 and a['mid'] != b['mid']:
                return a['k'] + (a['mid'] - 50) / (a['mid'] - b['mid']) * (b['k'] - a['k'])
        return None

    lf, ln = ladder(OFFSETS[0]), ladder(OFFSETS[2])
    if len(ln) < 4: return None
    Ff, Fn = fwd(lf), fwd(ln)
    if Fn is None: return None
    steps = [ln[i + 1]['k'] - ln[i]['k'] for i in range(len(ln) - 1)]
    step = sorted(steps)[len(steps) // 2]
    if step <= 0: return None
    drift = (Fn - Ff) / step if Ff is not None else 0.0
    i = min(range(len(ln)), key=lambda j: abs(ln[j]['mid'] - 50))
    if i - w < 0 or i + w >= len(ln): return None
    A, B = ln[i - w], ln[i + w]
    cost = A['ask'] / 100 + (100 - B['bid']) / 100
    fees = fee(A['ask'] / 100) + fee((100 - B['bid']) / 100)
    payoff = (1.0 if A['result'] == 'yes' else 0.0) + (1.0 if B['result'] == 'no' else 0.0)
    hour = datetime.fromtimestamp(ev['close'], tz=timezone.utc).hour
    return dict(close=ev['close'],
                x=[drift, abs(drift), cost, (B['k'] - A['k']) / Fn * 100,
                   math.sin(2 * math.pi * hour / 24), math.cos(2 * math.pi * hour / 24)],
                inside=1.0 if payoff == 2.0 else 0.0,
                pnl=payoff - cost - fees, cost=cost, fees=fees)


def train(rows, k=25):
    X = [r['x'] for r in rows]
    n, d = len(X), len(X[0])
    mu = [sum(r[j] for r in X) / n for j in range(d)]
    sd = [max(1e-9, (sum((r[j] - mu[j]) ** 2 for r in X) / n) ** 0.5) for j in range(d)]
    Z = [[(r[j] - mu[j]) / sd[j] for j in range(d)] for r in X]
    return dict(mu=mu, sd=sd, Z=Z, y=[r['inside'] for r in rows], k=k)


def oos_ev(model, rows, tau):
    """EV/trade of the KNN filter on held-out rows"""
    from common import knn_proba
    pnls = []
    for r in rows:
        p = knn_proba(model, r['x'])
        if p * 2 + (1 - p) - r['cost'] - r['fees'] > tau:
            pnls.append(r['pnl'])
    if len(pnls) < 15: return None, len(pnls)
    return sum(pnls) / len(pnls), len(pnls)


def main():
    cfg = load_config()
    # ALWAYS train on PROD market data (real prices), even when trading demo
    api = Kalshi({**cfg, 'env': 'prod', 'api_key_id': '', 'private_key_path': ''})
    rows = collect(api)
    log(f'retrain: {len(rows)} usable rows')
    if len(rows) < int(os.environ.get('RETRAIN_MIN_ROWS', 200)):
        log('retrain: too few rows, keeping champion'); return
    cut = int(len(rows) * 0.7)
    tau = cfg['hourly']['tau']
    challenger = train(rows[:cut], cfg['hourly']['k'])
    ev_c, n_c = oos_ev(challenger, rows[cut:], tau)

    champ_meta = jread('model_meta.json', None)
    promote = True
    if champ_meta is None and ev_c is None:
        # bootstrap: no champion exists yet — promote with a warning
        log(f'retrain: BOOTSTRAP promote (holdout too thin: {n_c} trades) — validate via paper trading')
        full = train(rows, cfg['hourly']['k'])
        jwrite('model.json', full)
        jwrite('model_meta.json', dict(
            trained=datetime.now(timezone.utc).isoformat(timespec='seconds'),
            rows=len(rows), holdout_ev=None, holdout_n=n_c, tau=tau, bootstrap=True))
        return
    if champ_meta and ev_c is not None:
        # champion re-scored on the SAME fresh holdout for a fair fight
        champ = jread('model.json', None)
        if champ:
            ev_i, n_i = oos_ev(champ, rows[cut:], tau)
            if ev_i is not None and ev_c < 0.8 * ev_i:
                promote = False
                log(f'retrain: challenger EV {ev_c:+.3f} < 80% of champion {ev_i:+.3f} — keeping champion')
    if ev_c is None:
        promote = False
        log(f'retrain: challenger produced too few holdout trades ({n_c}) — keeping champion')
    if promote:
        full = train(rows, cfg['hourly']['k'])  # deploy on ALL data
        jwrite('model.json', full)
        jwrite('model_meta.json', dict(
            trained=datetime.now(timezone.utc).isoformat(timespec='seconds'),
            rows=len(rows), holdout_ev=ev_c, holdout_n=n_c, tau=tau))
        log(f'retrain: PROMOTED new model (holdout EV {ev_c:+.3f} on {n_c} trades, {len(rows)} rows)')


if __name__ == '__main__':
    main()
