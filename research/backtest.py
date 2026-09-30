#!/usr/bin/env python3
"""
Kalshi commodity-ladder strategy backtester.

Phase 1 (collect): pull settled strike-ladder events for commodity series,
reconstruct each ladder's bid/ask snapshot at entry offsets before close from
real candlesticks, and store with the actual settlement outcome.

Phase 2 (eval): run mechanical strategies over the snapshots with taker fees,
grid-search parameters on the in-sample split, validate out-of-sample, plus a
weekly walk-forward table.

Execution model (conservative): enter at the ASK, pay Kalshi taker fee
ceil(0.07 * C * p * (1-p)) per leg, hold to settlement. Skip strikes with no
quote or spread wider than MAX_SPREAD.

Usage: python3 backtest.py collect   (writes cache/events.json)
       python3 backtest.py eval      (reads cache, prints report)
"""
import json, math, os, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
from datetime import datetime, timezone

BASE = 'http://localhost:8787/api'
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache')
os.makedirs(CACHE, exist_ok=True)

# scope: series -> (max events, candle period minutes, entry offsets in minutes)
SCOPE = {
    'KXWTIH':   dict(events=320, period=1,  offsets=[50, 30, 15]),
    'KXGOLDH':  dict(events=320,  period=1,  offsets=[50, 30, 15]),
    'KXSILVERH':dict(events=320,  period=1,  offsets=[50, 30, 15]),
    'KXWTI':    dict(events=70,  period=60, offsets=[360, 180, 60]),
    'KXNATGASD':dict(events=70,  period=60, offsets=[360, 180, 60]),
    'KXBRENTD': dict(events=70,  period=60, offsets=[360, 180, 60]),
    'KXCOPPERD':dict(events=70,  period=60, offsets=[360, 180, 60]),
}
MAX_SPREAD = 15  # cents; wider = untradeable, skip leg


def get(path, retries=4):
    for i in range(retries):
        try:
            with urllib.request.urlopen(BASE + path, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(1.5 * (i + 1)); continue
            raise
        except Exception:
            if i == retries - 1: raise
            time.sleep(0.5)
    raise RuntimeError('retries exhausted')


def cents(v):
    if v in (None, ''): return None
    return round(float(v) * 100, 2)


def collect():
    cache_path = os.path.join(CACHE, 'events.json')
    existing = []
    if os.path.exists(cache_path):
        with open(cache_path) as f:
            existing = json.load(f)
    have = {e['event'] for e in existing}
    print(f'cache: {len(existing)} events already collected')
    all_events = []
    for series, cfg in SCOPE.items():
        # 1) enumerate settled markets
        markets, cursor = [], ''
        while len(markets) < cfg['events'] * 40:
            d = get(f'/markets?series_ticker={series}&status=settled&limit=1000' + (f'&cursor={cursor}' if cursor else ''))
            markets += d.get('markets', [])
            cursor = d.get('cursor') or ''
            if not cursor: break
        by_event = defaultdict(list)
        for m in markets:
            if m.get('floor_strike') is None or m.get('result') not in ('yes', 'no'):
                continue
            by_event[m['event_ticker']].append(m)
        # newest events first, keep ladders with >= 5 strikes
        events = [(et, ms) for et, ms in by_event.items() if len(ms) >= 5]
        events.sort(key=lambda kv: max(m['close_time'] for m in kv[1]), reverse=True)
        events = [e for e in events[:cfg['events']] if e[0] not in have]
        print(f'{series}: {len(events)} NEW ladder events to fetch', flush=True)

        def fetch_event(item):
            et, ms = item
            ms = sorted(ms, key=lambda m: m['floor_strike'])
            close_ts = int(datetime.fromisoformat(ms[0]['close_time'].replace('Z', '+00:00')).timestamp())
            start = close_ts - (max(cfg['offsets']) + 3 * cfg['period']) * 60
            strikes = []
            for m in ms:
                try:
                    c = get(f"/series/{series}/markets/{m['ticker']}/candlesticks?start_ts={start}&end_ts={close_ts}&period_interval={cfg['period']}")
                except Exception:
                    continue
                quotes = {}
                for ck in c.get('candlesticks', []):
                    b = cents((ck.get('yes_bid') or {}).get('close_dollars'))
                    a = cents((ck.get('yes_ask') or {}).get('close_dollars'))
                    if b is None or a is None: continue
                    quotes[ck['end_period_ts']] = (b, a)
                snap = {}
                for off in cfg['offsets']:
                    target = close_ts - off * 60
                    # latest candle at or before target
                    best = None
                    for ts, q in quotes.items():
                        if ts <= target and (best is None or ts > best[0]):
                            best = (ts, q)
                    if best and target - best[0] <= 3 * cfg['period'] * 60:
                        snap[str(off)] = best[1]
                strikes.append(dict(k=m['floor_strike'], result=m['result'], snap=snap,
                                    vol=float(m.get('volume_fp') or 0)))
            return dict(series=series, event=et, close=close_ts, strikes=strikes)

        with ThreadPoolExecutor(max_workers=8) as ex:
            for ev in ex.map(fetch_event, events):
                if sum(1 for s in ev['strikes'] if s['snap']) >= 4:
                    all_events.append(ev)
        print(f'{series}: kept {sum(1 for e in all_events if e["series"]==series)} with usable snapshots', flush=True)

    merged = existing + all_events
    with open(cache_path, 'w') as f:
        json.dump(merged, f)
    print('TOTAL events cached:', len(merged), f'({len(all_events)} new)')


# ---------------- evaluation ----------------

def fee(price_cents, n=1):
    p = price_cents / 100
    return math.ceil(0.07 * n * p * (1 - p) * 100) / 100  # dollars, per leg


def ladder_at(ev, off):
    """strikes with quotes at offset -> list of dicts sorted by strike"""
    out = []
    for s in ev['strikes']:
        q = s['snap'].get(str(off))
        if not q: continue
        b, a = q
        if a - b > MAX_SPREAD or a <= 0 or a >= 100: continue
        out.append(dict(k=s['k'], bid=b, ask=a, mid=(a + b) / 2, result=s['result']))
    return sorted(out, key=lambda x: x['k'])


def atm_index(lad):
    """index whose mid is closest to 50 (the entry-time forward)"""
    if not lad: return None
    i = min(range(len(lad)), key=lambda j: abs(lad[j]['mid'] - 50))
    if abs(lad[i]['mid'] - 50) > 45: return None  # ladder entirely one-sided
    return i


def leg_pnl(leg, side):
    """buy 1 contract of side at ask; return (pnl_dollars, cost_dollars)"""
    if side == 'yes':
        cost = leg['ask'] / 100
        win = leg['result'] == 'yes'
    else:
        cost = (100 - leg['bid']) / 100  # no ask = 100 - yes bid
        win = leg['result'] == 'no'
    f = fee(cost * 100)
    return ((1.0 if win else 0.0) - cost - f, cost + f)


def strat_band(ev, off, w_lo, w_hi, max_cost):
    lad = ladder_at(ev, off)
    i = atm_index(lad)
    if i is None: return None
    if i - w_lo < 0 or i + w_hi >= len(lad): return None
    A, B = lad[i - w_lo], lad[i + w_hi]
    pnl_a, cost_a = leg_pnl(A, 'yes')
    pnl_b, cost_b = leg_pnl(B, 'no')
    if (cost_a + cost_b) * 100 > max_cost: return None
    return pnl_a + pnl_b, cost_a + cost_b


def strat_selltail(ev, off, d, min_p):
    lad = ladder_at(ev, off)
    i = atm_index(lad)
    if i is None or i + d >= len(lad): return None
    leg = lad[i + d]
    pnl, cost = leg_pnl(leg, 'no')
    if (1 - cost) < min_p / 100: pass
    if cost * 100 < min_p: return None  # NO must be expensive (deep favorite)
    return pnl, cost


def strat_longshot(ev, off, d, max_p):
    lad = ladder_at(ev, off)
    i = atm_index(lad)
    if i is None or i + d >= len(lad): return None
    leg = lad[i + d]
    if leg['ask'] > max_p: return None
    pnl, cost = leg_pnl(leg, 'yes')
    return pnl, cost


def strat_breakout(ev, off, w):
    lad = ladder_at(ev, off)
    i = atm_index(lad)
    if i is None or i - w < 0 or i + w >= len(lad): return None
    A, B = lad[i - w], lad[i + w]  # NO at low strike + YES at high strike
    pnl_a, cost_a = leg_pnl(A, 'no')
    pnl_b, cost_b = leg_pnl(B, 'yes')
    return pnl_a + pnl_b, cost_a + cost_b


def strat_modeledge(ev, off, edge, span):
    lad = ladder_at(ev, off)
    i = atm_index(lad)
    if i is None: return None
    best = None
    for j in range(max(1, i - span), min(len(lad) - 1, i + span + 1)):
        smooth = (lad[j - 1]['mid'] + lad[j]['mid'] + lad[j + 1]['mid']) / 3
        yes_edge = smooth - lad[j]['ask']
        no_edge = (100 - smooth) - (100 - lad[j]['bid'])
        if yes_edge >= edge and (best is None or yes_edge > best[0]):
            best = (yes_edge, lad[j], 'yes')
        if no_edge >= edge and (best is None or no_edge > best[0]):
            best = (no_edge, lad[j], 'no')
    if not best: return None
    pnl, cost = leg_pnl(best[1], best[2])
    return pnl, cost


STRATS = {
    'BAND':     (strat_band,     [dict(off=o, w_lo=w, w_hi=w2, max_cost=mc)
                                  for o in (50, 30, 15, 360, 180, 60) for w in (1, 2) for w2 in (1, 2) for mc in (185, 194)]),
    'SELLTAIL': (strat_selltail, [dict(off=o, d=d, min_p=mp)
                                  for o in (50, 30, 15, 360, 180, 60) for d in (2, 3, 4) for mp in (85, 92)]),
    'LONGSHOT': (strat_longshot, [dict(off=o, d=d, max_p=mp)
                                  for o in (50, 30, 15, 360, 180, 60) for d in (2, 3, 4) for mp in (10, 20)]),
    'BREAKOUT': (strat_breakout, [dict(off=o, w=w) for o in (50, 30, 15, 360, 180, 60) for w in (1, 2)]),
    'MODELEDGE':(strat_modeledge,[dict(off=o, edge=e, span=s)
                                  for o in (50, 30, 15, 360, 180, 60) for e in (3, 5, 8) for s in (2, 3)]),
}


def run(strat_fn, params, events):
    trades = []
    for ev in events:
        r = strat_fn(ev, params['off'], *[v for k, v in params.items() if k != 'off'])
        if r is not None:
            trades.append((ev['close'], r[0], r[1]))
    return trades


def stats(trades):
    if not trades: return None
    pnls = [t[1] for t in trades]
    costs = [t[2] for t in trades]
    n = len(pnls)
    ev_ = sum(pnls) / n
    wins = sum(1 for p in pnls if p > 0)
    sd = (sum((p - ev_) ** 2 for p in pnls) / max(1, n - 1)) ** 0.5
    # max drawdown of cumulative pnl
    cum = peak = mdd = 0.0
    for _, p, _ in sorted(trades):
        cum += p; peak = max(peak, cum); mdd = min(mdd, cum - peak)
    return dict(n=n, ev=ev_, win=wins / n, sd=sd, total=sum(pnls),
                avg_cost=sum(costs) / n, mdd=mdd,
                sharpe=(ev_ / sd * math.sqrt(n)) if sd > 0 else 0)


def evaluate():
    with open(os.path.join(CACHE, 'events.json')) as f:
        events = json.load(f)

    GROUPS = {
        'HOURLY': dict(series={'KXWTIH', 'KXGOLDH', 'KXSILVERH'}, offsets={50, 30, 15}, min_is=40),
        'DAILY': dict(series={'KXWTI', 'KXNATGASD'}, offsets={360, 180, 60}, min_is=12),
    }
    CAPITAL = 121.0  # current cash bankroll (dollars)
    RISK_FRAC = 0.05

    for gname, g in GROUPS.items():
        evs = sorted([e for e in events if e['series'] in g['series']], key=lambda e: e['close'])
        if not evs: continue
        cut = int(len(evs) * 0.6)
        IS, OOS = evs[:cut], evs[cut:]
        span_days = (evs[-1]['close'] - evs[0]['close']) / 86400
        print(f"\n{'='*118}")
        print(f"{gname}: {len(evs)} events over {span_days:.1f} days | IS {len(IS)} | OOS {len(OOS)} | "
              f"mix {dict(sorted(((s, sum(1 for e in evs if e['series']==s)) for s in g['series']), key=lambda x:-x[1]))}")
        print(f"{'strategy':10s} {'params':40s} | {'IS n':>4} {'EV':>7} {'win':>5} | {'OOS n':>5} {'EV':>7} {'win':>5} {'total':>8} {'t':>5}")
        print('-' * 118)

        candidates = []
        for name, (fn, grid) in STRATS.items():
            ranked = []
            for params in grid:
                if params['off'] not in g['offsets']: continue
                st = stats(run(fn, params, IS))
                if st and st['n'] >= g['min_is']:
                    ranked.append((params, st))
            ranked.sort(key=lambda x: -x[1]['ev'])
            for params, is_st in ranked[:3]:
                oos_tr = run(fn, params, OOS)
                o = stats(oos_tr)
                ps = ','.join(f'{k}={v}' for k, v in params.items())
                if o:
                    t = o['ev'] / o['sd'] * math.sqrt(o['n']) if o['sd'] > 0 else 0
                    print(f"{name:10s} {ps:40s} | {is_st['n']:>4} {is_st['ev']:>+7.3f} {is_st['win']:>5.0%} | "
                          f"{o['n']:>5} {o['ev']:>+7.3f} {o['win']:>5.0%} {o['total']:>+8.2f} {t:>5.2f}")
                    candidates.append((name, params, is_st, o, fn))
                else:
                    print(f"{name:10s} {ps:40s} | {is_st['n']:>4} {is_st['ev']:>+7.3f} {is_st['win']:>5.0%} |  (no OOS trades)")

        # pick most robust: positive in BOTH IS and OOS, rank by OOS t-stat
        robust = [c for c in candidates if c[2]['ev'] > 0 and c[3]['ev'] > 0 and c[3]['n'] >= 15]
        if not robust:
            print('>>> no strategy in this group was positive both IS and OOS with enough trades — nothing to deploy')
            continue
        robust.sort(key=lambda c: -(c[3]['ev'] / c[3]['sd'] * math.sqrt(c[3]['n']) if c[3]['sd'] > 0 else 0))
        name, params, is_st, oos_st, fn = robust[0]
        print(f">>> most robust: {name} {params}")

        # 3-fold stability
        third = len(evs) // 3
        folds = [evs[:third], evs[third:2*third], evs[2*third:]]
        fold_line = []
        for i, fold in enumerate(folds):
            st = stats(run(fn, params, fold))
            fold_line.append(f"fold{i+1}: n={st['n']} EV={st['ev']:+.3f}" if st else f"fold{i+1}: none")
        print('    stability  ' + ' | '.join(fold_line))

        # bankroll projection (honest: uses OOS EV with its own uncertainty)
        all_tr = run(fn, params, evs)
        per_day = len(all_tr) / max(1, span_days)
        cost = oos_st['avg_cost']
        contracts = max(1, int((CAPITAL * RISK_FRAC) / cost))
        daily = per_day * oos_st['ev'] * contracts
        se = oos_st['sd'] / math.sqrt(oos_st['n']) * contracts * per_day
        print(f"    projection on ${CAPITAL:.0f} bankroll, {RISK_FRAC:.0%} risk/trade -> {contracts} ct/leg, "
              f"~{per_day:.1f} signals/day: {daily:+.2f} $/day (±{se:.2f} SE) | fees+spread already included")

    print('\nassumptions: enter at ask (taker), fee=ceil(7%*p*(1-p)) per leg, hold to settlement,')
    print(f'skip legs with spread >{MAX_SPREAD}c or missing quotes. EV per 1-contract trade. Past != future.')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'collect':
        collect()
    else:
        evaluate()
