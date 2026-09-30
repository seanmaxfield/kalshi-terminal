"""Shared: Kalshi API client (python-native signing) + ladder/feature code."""
import base64, json, math, os, threading, time, urllib.request, urllib.error
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, 'state')
os.makedirs(STATE, exist_ok=True)


def load_config():
    with open(os.path.join(HERE, 'config.json')) as f:
        return json.load(f)


def jread(name, default):
    p = os.path.join(STATE, name)
    if not os.path.exists(p): return default
    with open(p) as f: return json.load(f)


def jwrite(name, obj):
    p = os.path.join(STATE, name)
    tmp = p + '.tmp'
    with open(tmp, 'w') as f: json.dump(obj, f, indent=1)
    os.replace(tmp, p)


def log(msg):
    line = f'{datetime.now(timezone.utc).isoformat(timespec="seconds")} {msg}'
    print(line, flush=True)
    with open(os.path.join(STATE, 'bot.log'), 'a') as f:
        f.write(line + '\n')


class Kalshi:
    _throttle_lock = threading.Lock()
    _last_req = [0.0]
    MIN_INTERVAL = float(os.environ.get('KALSHI_MIN_INTERVAL', '0.12'))

    def __init__(self, cfg):
        self.base = ('https://demo-api.kalshi.co' if cfg['env'] == 'demo'
                     else 'https://api.elections.kalshi.com')
        self.key_id = cfg.get('api_key_id', '')
        self._key = None
        kp = cfg.get('private_key_path', '')
        if self.key_id and kp and os.path.exists(kp):
            from cryptography.hazmat.primitives import serialization
            with open(kp, 'rb') as f:
                self._key = serialization.load_pem_private_key(f.read(), password=None)

    @property
    def can_trade(self):
        return self._key is not None

    def _headers(self, method, path):
        if not self._key: return {}
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding
        ts = str(int(time.time() * 1000))
        msg = (ts + method + path.split('?')[0]).encode()
        sig = self._key.sign(
            msg,
            padding.PSS(mgf=padding.MGF1(hashes.SHA256()),
                        salt_length=hashes.SHA256().digest_size),
            hashes.SHA256())
        return {'KALSHI-ACCESS-KEY': self.key_id,
                'KALSHI-ACCESS-SIGNATURE': base64.b64encode(sig).decode(),
                'KALSHI-ACCESS-TIMESTAMP': ts}

    def _session(self):
        # keep-alive session (TLS reuse) when `requests` is available
        if not hasattr(self, '_sess'):
            try:
                import requests
                self._sess = requests.Session()
            except ImportError:
                self._sess = None
        return self._sess

    def _wait_turn(self):
        with Kalshi._throttle_lock:
            delta = time.time() - Kalshi._last_req[0]
            if delta < Kalshi.MIN_INTERVAL:
                time.sleep(Kalshi.MIN_INTERVAL - delta)
            Kalshi._last_req[0] = time.time()

    def req(self, method, path, body=None, retries=5):
        url = self.base + '/trade-api/v2' + path
        headers = {'Accept': 'application/json'}
        headers.update(self._headers(method, '/trade-api/v2' + path))
        sess = self._session()
        for i in range(retries):
            self._wait_turn()
            try:
                if sess is not None:
                    r = sess.request(method, url, json=body, headers=headers, timeout=30)
                    if r.status_code == 429 and i < retries - 1:
                        time.sleep(3.0 * (i + 1)); continue
                    if r.status_code >= 400:
                        raise RuntimeError(f'{method} {path} -> {r.status_code}: {r.text[:300]}')
                    return r.json()
                data = json.dumps(body).encode() if body is not None else None
                rq = urllib.request.Request(url, data=data, method=method)
                for k, v in headers.items(): rq.add_header(k, v)
                if data is not None: rq.add_header('Content-Type', 'application/json')
                with urllib.request.urlopen(rq, timeout=30) as resp:
                    return json.load(resp)
            except urllib.error.HTTPError as e:
                if e.code == 429 and i < retries - 1:
                    time.sleep(3.0 * (i + 1)); continue
                raise RuntimeError(f'{method} {path} -> {e.code}: {e.read()[:300]}')
            except RuntimeError:
                raise
            except Exception:
                if i == retries - 1: raise
                time.sleep(1)

    def get(self, path): return self.req('GET', path)
    def post(self, path, body): return self.req('POST', path, body)
    def delete(self, path): return self.req('DELETE', path)


# ---------------- ladder / features (mirrors research/backtest3.py) ----------------

def cents(v):
    if v in (None, ''): return None
    return round(float(v) * 100, 2)


def fee(cost):
    p = min(0.99, max(0.01, cost))
    return math.ceil(0.07 * p * (1 - p) * 100) / 100


def live_ladder(api, event_ticker, max_spread=15):
    d = api.get(f'/markets?event_ticker={event_ticker}&limit=100')
    out = []
    for m in d.get('markets', []):
        if m.get('floor_strike') is None: continue
        b = cents(m.get('yes_bid_dollars') or m.get('yes_bid'))
        a = cents(m.get('yes_ask_dollars') or m.get('yes_ask'))
        if b is None or a is None or a <= 0 or a >= 100 or a - b > max_spread: continue
        out.append(dict(k=m['floor_strike'], bid=b, ask=a, mid=(a + b) / 2,
                        ticker=m['ticker'], close=m.get('close_time')))
    return sorted(out, key=lambda x: x['k'])


def forward(lad):
    for i in range(len(lad) - 1):
        a, b = lad[i], lad[i + 1]
        if (a['mid'] - 50) * (b['mid'] - 50) <= 0 and a['mid'] != b['mid']:
            return a['k'] + (a['mid'] - 50) / (a['mid'] - b['mid']) * (b['k'] - a['k'])
    return None


def band_features(lad, f_far, close_ts, w):
    """features + band legs, given a far-forward sample; None if not buildable"""
    if len(lad) < 4: return None
    fn = forward(lad)
    if fn is None: return None
    steps = [lad[i + 1]['k'] - lad[i]['k'] for i in range(len(lad) - 1)]
    step = sorted(steps)[len(steps) // 2]
    if step <= 0: return None
    drift = (fn - f_far) / step if f_far is not None else 0.0
    i = min(range(len(lad)), key=lambda j: abs(lad[j]['mid'] - 50))
    if i - w < 0 or i + w >= len(lad): return None
    A, B = lad[i - w], lad[i + w]
    cost = A['ask'] / 100 + (100 - B['bid']) / 100
    fees = fee(A['ask'] / 100) + fee((100 - B['bid']) / 100)
    hour = datetime.fromtimestamp(close_ts, tz=timezone.utc).hour
    width = (B['k'] - A['k']) / fn * 100
    x = [drift, abs(drift), cost, width,
         math.sin(2 * math.pi * hour / 24), math.cos(2 * math.pi * hour / 24)]
    return dict(x=x, yes_leg=A, no_leg=B, cost=cost, fees=fees)


def knn_proba(model, x, k=None):
    """model: {'mu','sd','Z','y'} lists; returns P(inside band)"""
    k = k or model.get('k', 25)
    mu, sd = model['mu'], model['sd']
    z = [(xi - m) / s for xi, m, s in zip(x, mu, sd)]
    dists = []
    for zi, yi in zip(model['Z'], model['y']):
        dists.append((sum((a - b) ** 2 for a, b in zip(z, zi)), yi))
    dists.sort(key=lambda t: t[0])
    top = dists[:k]
    return sum(y for _, y in top) / len(top)
