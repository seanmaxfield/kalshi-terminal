#!/usr/bin/env python3
"""
Kalshi band-spread bot (Phase 1: DEMO exchange).

Loop, once a minute:
  1. sample far-forwards for upcoming ladders (feature memory)
  2. near the entry window, build features -> KNN gate (hourly) / rule (daily)
  3. place both band legs (maker-first, escalate to cross before deadline)
  4. poll settlements, realize P&L, feed lockbox, enforce risk rails

Risk rails: sizing % of UNLOCKED equity, contract cap, max open pairs,
daily loss stop, drawdown kill-switch (halts until state/killed.json removed).
Config is re-read every cycle — edit config.json and it applies live.
"""
import json, os, time, uuid
from datetime import datetime, timezone
from common import (Kalshi, load_config, jread, jwrite, log,
                    live_ladder, forward, band_features, knn_proba, fee)

HERE = os.path.dirname(os.path.abspath(__file__))


def now_ts(): return int(time.time())


def parse_ts(iso): return int(datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp())


def open_events(api, series, lo_min, hi_min):
    """open ladder events closing between lo and hi minutes from now"""
    d = api.get(f'/markets?series_ticker={series}&status=open&limit=200')
    by_ev = {}
    for m in d.get('markets', []):
        if m.get('floor_strike') is None or not m.get('close_time'): continue
        mins = (parse_ts(m['close_time']) - now_ts()) / 60
        if lo_min <= mins <= hi_min:
            by_ev.setdefault(m['event_ticker'], parse_ts(m['close_time']))
    return by_ev  # {event_ticker: close_ts}


def read_trades():
    p = os.path.join(HERE, 'state', 'trades.jsonl')
    if not os.path.exists(p): return []
    with open(p) as f:
        return [json.loads(l) for l in f if l.strip()]


def append_trade(t):
    with open(os.path.join(HERE, 'state', 'trades.jsonl'), 'a') as f:
        f.write(json.dumps(t) + '\n')


def rewrite_trades(trades):
    p = os.path.join(HERE, 'state', 'trades.jsonl')
    with open(p + '.tmp', 'w') as f:
        for t in trades: f.write(json.dumps(t) + '\n')
    os.replace(p + '.tmp', p)


def place_leg(api, ticker, side_yes_terms, yes_cents, cts, maker_improve):
    """side_yes_terms: 'bid' (buy yes) or 'ask' (buy no at 100-price).
    Returns order dict. maker_improve>0 rests inside the touch first."""
    px = max(1, min(99, yes_cents - maker_improve if side_yes_terms == 'bid'
                    else yes_cents + maker_improve))
    body = dict(ticker=ticker, client_order_id=str(uuid.uuid4()),
                side=side_yes_terms, count=f'{cts:.2f}',
                price=f'{px / 100:.4f}', time_in_force='good_till_canceled',
                self_trade_prevention_type='taker_at_cross')
    r = api.post('/portfolio/events/orders', body)
    return dict(order_id=r.get('order_id'), price=px,
                filled=float(r.get('fill_count') or 0),
                remaining=float(r.get('remaining_count') or 0))


def escalate_leg(api, leg, api_cts):
    """cancel resting remainder and cross at market (aggressive IOC)"""
    try:
        api.delete(f"/portfolio/events/orders/{leg['order_id']}")
    except Exception as e:
        log(f'escalate: cancel failed ({e}) — may already be filled')
        return leg
    px = 99 if leg['side'] == 'bid' else 1
    body = dict(ticker=leg['ticker'], client_order_id=str(uuid.uuid4()),
                side=leg['side'], count=f'{api_cts:.2f}', price=f'{px / 100:.4f}',
                time_in_force='immediate_or_cancel',
                self_trade_prevention_type='taker_at_cross')
    r = api.post('/portfolio/events/orders', body)
    leg['order_id'] = r.get('order_id')
    leg['filled'] = leg.get('filled', 0) + float(r.get('fill_count') or 0)
    leg['escalated'] = True
    return leg


def main():
    log('bot starting')
    tracker = jread('tracker.json', {})
    while True:
        try:
            cycle(tracker)
        except Exception as e:
            log(f'CYCLE ERROR: {e}')
        time.sleep(60)


def cycle(tracker):
    cfg = load_config()
    eq = jread('equity.json', dict(realized=0.0, peak=0.0, lockbox=0.0))

    if not cfg.get('enabled'):
        return
    if cfg['env'] != 'demo' and not cfg.get('i_understand_prod_risks'):
        log('env=prod but i_understand_prod_risks is not true — refusing'); return
    if jread('killed.json', None):
        return  # kill-switch fired; human must delete state/killed.json
    api = Kalshi(cfg)
    if not api.can_trade:
        log('no API key configured — set api_key_id/private_key_path'); return

    bankroll = cfg['bankroll']
    equity = bankroll + eq['realized']
    available = equity - eq['lockbox']
    # kill-switch: drawdown from peak
    eq['peak'] = max(eq['peak'], equity)
    jwrite('equity.json', eq)
    if eq['peak'] > 0 and equity < eq['peak'] * (1 - cfg['risk']['kill_drawdown']):
        jwrite('killed.json', dict(at=datetime.now(timezone.utc).isoformat(),
                                   equity=equity, peak=eq['peak']))
        log(f'KILL SWITCH: equity {equity:.2f} fell {cfg["risk"]["kill_drawdown"]:.0%} from peak {eq["peak"]:.2f}. halted.')
        jwrite('equity.json', eq); return

    trades = read_trades()
    today = datetime.now(timezone.utc).date().isoformat()
    day_realized = sum(t.get('pnl', 0) for t in trades
                      if t.get('status') == 'settled' and t.get('settled_day') == today)
    open_pairs = [t for t in trades if t.get('status') == 'open']
    daily_stopped = day_realized <= -cfg['risk']['daily_stop'] * bankroll

    # ---- 1. sample far forwards ----
    for gname, g in cfg['groups'].items():
        for series in g['series']:
            try:
                evs = open_events(api, series, g['far_min'] - 6, g['far_min'] + 6)
                for et, close_ts in evs.items():
                    if et not in tracker:
                        lad = live_ladder(api, et)
                        f = forward(lad)
                        if f is not None:
                            tracker[et] = dict(f_far=f, close=close_ts, group=gname)
            except Exception as e:
                log(f'sample {series}: {e}')
    # prune stale tracker entries
    for et in [k for k, v in tracker.items() if v['close'] < now_ts() - 3600]:
        del tracker[et]
    jwrite('tracker.json', tracker)

    # ---- 2/3. entries ----
    if not daily_stopped and len(open_pairs) < cfg['risk']['max_open_pairs']:
        for et, tr in list(tracker.items()):
            g = cfg['groups'][tr['group']]
            mins = (tr['close'] - now_ts()) / 60
            if not (g['near_min'] - 3 <= mins <= g['near_min'] + 3): continue
            if any(t['event'] == et for t in trades): continue
            try:
                lad = live_ladder(api, et)
                bf = band_features(lad, tr['f_far'], tr['close'], g['w'])
            except Exception as e:
                log(f'features {et}: {e}'); continue
            if not bf or bf['cost'] * 100 > g['max_cost']:
                continue
            if g.get('use_model'):
                model = jread('model.json', None)
                if not model:
                    log('no model.json — run retrain.py first'); continue
                p = knn_proba(model, bf['x'])
                ev_model = p * 2 + (1 - p) - bf['cost'] - bf['fees']
                if ev_model <= g['tau']:
                    log(f'skip {et}: model P={p:.2f} EV={ev_model:+.3f} <= tau'); continue
            cts = max(1, min(cfg['risk']['max_contracts'],
                             int(available * cfg['risk']['risk_frac'] / (bf['cost'] + bf['fees']))))
            improve = cfg['execution']['maker_improve']
            try:
                legA = place_leg(api, bf['yes_leg']['ticker'], 'bid', bf['yes_leg']['ask'], cts, improve)
                legA.update(ticker=bf['yes_leg']['ticker'], side='bid')
                legB = place_leg(api, bf['no_leg']['ticker'], 'ask', bf['no_leg']['bid'], cts, improve)
                legB.update(ticker=bf['no_leg']['ticker'], side='ask')
            except Exception as e:
                log(f'ORDER FAILED {et}: {e}'); continue
            t = dict(id=str(uuid.uuid4())[:8], event=et, group=tr['group'], cts=cts,
                     close=tr['close'], entered=now_ts(), status='open',
                     est_cost=bf['cost'], est_fees=bf['fees'], x=bf['x'],
                     legs=[legA, legB],
                     escalate_at=tr['close'] - cfg['execution']['cross_before_close_min'] * 60)
            append_trade(t); trades.append(t)
            log(f'ENTER {et}: {cts}ct YES {bf["yes_leg"]["ticker"]}@{legA["price"]} + '
                f'NO {bf["no_leg"]["ticker"]}@{100 - legB["price"]} cost~{bf["cost"]:.2f}')

    # ---- 3b. escalate resting legs near deadline ----
    changed = False
    for t in trades:
        if t.get('status') != 'open': continue
        if now_ts() >= t.get('escalate_at', 0):
            for leg in t['legs']:
                if not leg.get('escalated') and leg.get('remaining', 0) > 0:
                    escalate_leg(Kalshi(load_config()), leg, t['cts'])
                    changed = True

    # ---- 4. settle ----
    for t in trades:
        if t.get('status') != 'open' or now_ts() < t['close'] + 900: continue
        try:
            pnl = 0.0
            for leg in t['legs']:
                m = Kalshi(load_config()).get(f"/markets/{leg['ticker']}")['market']
                res = m.get('result')
                if res not in ('yes', 'no'): raise RuntimeError('not settled yet')
                yes_px = leg['price'] if leg['side'] == 'bid' else 100 - leg['price']
                cost = yes_px / 100 if leg['side'] == 'bid' else (100 - yes_px) / 100
                win = (res == 'yes') if leg['side'] == 'bid' else (res == 'no')
                pnl += ((1.0 if win else 0.0) - cost - fee(cost)) * t['cts']
            t['status'] = 'settled'
            t['pnl'] = round(pnl, 2)
            t['settled_day'] = datetime.now(timezone.utc).date().isoformat()
            eq2 = jread('equity.json', dict(realized=0.0, peak=0.0, lockbox=0.0))
            eq2['realized'] += pnl
            if pnl > 0:
                eq2['lockbox'] += round(load_config()['risk']['lockbox_skim'] * pnl, 4)
            jwrite('equity.json', eq2)
            log(f'SETTLED {t["event"]}: {pnl:+.2f} (lockbox {eq2["lockbox"]:.2f}, realized {eq2["realized"]:+.2f})')
            changed = True
        except Exception:
            pass  # not settled yet, retry next cycle
    if changed:
        rewrite_trades(trades)
    jwrite('equity.json', jread('equity.json', eq))


if __name__ == '__main__':
    main()
