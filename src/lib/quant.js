// Quant helpers: strike parsing, implied vol from binary prices, Kelly sizing.
import { cents, num } from '../api.js'

// ---------- normal distribution ----------
export function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 via erf
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2)
  const erf =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2)
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}

// Acklam's inverse normal CDF approximation.
export function normInv(p) {
  if (p <= 0 || p >= 1) return NaN
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pl = 0.02425
  let q, r
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p <= 1 - pl) {
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  }
  q = Math.sqrt(-2 * Math.log(1 - p))
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
}

// ---------- strike structure ----------
function midCents(m) {
  const bid = cents(m.yes_bid_dollars ?? m.yes_bid)
  const ask = cents(m.yes_ask_dollars ?? m.yes_ask)
  if (bid !== null && ask !== null && ask > 0) return (bid + ask) / 2
  return cents(m.last_price_dollars ?? m.last_price)
}

// Build the strike-keyed list for one yes-price basis (mid / yes ask / no ask).
function buildRaw(event, priceFn) {
  return (event.markets || [])
    .map((m) => {
      const st = m.strike_type
      const floor = m.floor_strike ?? null
      const cap = m.cap_strike ?? null
      const mid = priceFn(m)
      if (mid === null) return null
      const p = mid / 100
      if (st === 'greater' || st === 'greater_or_equal')
        return floor !== null ? { kind: 'thr', k: floor, pAbove: p, mid, m } : null
      if (st === 'less' || st === 'less_or_equal')
        return cap !== null ? { kind: 'thr', k: cap, pAbove: 1 - p, mid, m } : null
      if (st === 'between' && floor !== null && cap !== null)
        return { kind: 'bucket', k: (floor + cap) / 2, lo: floor, hi: cap, mass: p, mid, m }
      // some scalar markets carry only floor_strike with no strike_type
      if (floor !== null && cap === null) return { kind: 'thr', k: floor, pAbove: p, mid, m }
      return null
    })
    .filter(Boolean)
    .sort((a, b) => a.k - b.k)
}

// CDF points P(S > K) from a raw strike list.
function buildCdf(raw, event) {
  const buckets = raw.filter((r) => r.kind === 'bucket')
  const thresholds = raw.filter((r) => r.kind === 'thr')
  let cdf = []
  if (buckets.length >= 2 && event.mutually_exclusive) {
    // cumulative mass from the top; include a 'greater' tail if present
    const tailAbove = thresholds.filter((t) => t.m.strike_type?.startsWith('greater'))
    const items = [...buckets].sort((a, b) => a.lo - b.lo)
    const tailMass = tailAbove.reduce((s, t) => s + t.pAbove, 0)
    let running = tailMass
    for (let i = items.length - 1; i >= 0; i--) {
      cdf.push({ k: items[i].lo, pAbove: running + items[i].mass })
      running += items[i].mass
    }
    cdf.sort((a, b) => a.k - b.k)
    // top edge point from the tail
    if (tailAbove.length) cdf.push({ k: items[items.length - 1].hi, pAbove: tailMass })
    // low-side 'less' threshold gives another edge point
    for (const t of thresholds.filter((t) => t.m.strike_type?.startsWith('less')))
      cdf.push({ k: t.k, pAbove: t.pAbove })
    cdf.sort((a, b) => a.k - b.k)
  } else if (thresholds.length >= 3) {
    cdf = thresholds.map((t) => ({ k: t.k, pAbove: t.pAbove }))
  }
  return cdf
}

// Invert one CDF into a vol curve, given a shared forward/T/model.
function ivCurve(cdf, forward, T, lognormalOk) {
  const iv = []
  if (forward === null || T === null) return iv
  for (const c of cdf) {
    if (c.pAbove < 0.02 || c.pAbove > 0.98) continue
    const z = normInv(c.pAbove)
    let s = null
    if (lognormalOk) {
      const m = Math.log(forward / c.k)
      const disc = z * z + 2 * m
      if (disc >= 0) {
        // p = N((m − s²/2)/s) is hump-shaped in s for OTM strikes, so the
        // quadratic s² + 2zs − 2m = 0 can have two positive roots; the
        // smaller one is the market-consistent vol.
        const roots = [-z + Math.sqrt(disc), -z - Math.sqrt(disc)].filter((r) => r > 1e-9)
        if (roots.length) s = Math.min(...roots)
      }
    } else {
      if (Math.abs(z) > 1e-9) {
        const cand = (forward - c.k) / z
        if (cand > 1e-12) s = cand
      }
    }
    if (s !== null) iv.push({ k: c.k, sigma: s / Math.sqrt(T) })
  }
  return iv
}

// Parse an event's markets into a strike structure.
// Returns null when the event doesn't have >=3 usable strike markets.
export function parseStrikes(event) {
  const raw = buildRaw(event, midCents)
  if (raw.length < 3) return null

  const buckets = raw.filter((r) => r.kind === 'bucket')

  // Points for the price chart: yes/no mid vs strike (bucket => midpoint).
  const priceCurve = raw.map((r) => ({ k: r.k, yes: r.mid, no: 100 - r.mid, market: r.m }))

  const cdf = buildCdf(raw, event)

  // Forward estimate: strike where the MID P(S>K) crosses 0.5 (linear interp).
  let forward = null
  for (let i = 0; i < cdf.length - 1; i++) {
    const a = cdf[i], b = cdf[i + 1]
    if ((a.pAbove - 0.5) * (b.pAbove - 0.5) <= 0 && a.pAbove !== b.pAbove) {
      forward = a.k + ((a.pAbove - 0.5) / (a.pAbove - b.pAbove)) * (b.k - a.k)
      break
    }
  }

  const expiry = event.markets[0]?.expected_expiration_time || event.markets[0]?.close_time
  const T = expiry ? Math.max((new Date(expiry) - Date.now()) / (365.25 * 24 * 3600e3), 1 / 365 / 24) : null
  const lognormalOk = forward !== null && forward > 0 && cdf.every((c) => c.k > 0)

  // Side-specific vol curves priced off what you would actually PAY:
  // YES side from the yes ask; NO side from the no ask, which in
  // yes-probability terms is the yes bid (no_ask = 100 − yes_bid).
  const yesAsk = (m) => cents(m.yes_ask_dollars ?? m.yes_ask)
  const noAskAsYes = (m) => cents(m.yes_bid_dollars ?? m.yes_bid)
  const cdfYes = buildCdf(buildRaw(event, yesAsk), event)
  const cdfNo = buildCdf(buildRaw(event, noAskAsYes), event)

  // Kelly-edge shading: reference probability from the fitted vol model
  // (median of the mid IV curve), compared against the ask you would pay.
  const ivMid = ivCurve(cdf, forward, T, lognormalOk)
  const sigmaRef = (() => {
    if (ivMid.length === 0) return null
    const sorted = ivMid.map((p) => p.sigma).sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  })()
  const qModel = (k) => {
    if (sigmaRef === null || forward === null || T === null) return null
    const s = sigmaRef * Math.sqrt(T)
    if (s <= 0) return null
    if (lognormalOk) {
      if (k <= 0) return null
      return normCdf((Math.log(forward / k) - (s * s) / 2) / s)
    }
    return normCdf((forward - k) / s)
  }
  for (const p of priceCurve) {
    const m = p.market
    const ya = cents(m.yes_ask_dollars ?? m.yes_ask)
    const na = cents(m.no_ask_dollars ?? m.no_ask) ?? (cents(m.yes_bid_dollars ?? m.yes_bid) !== null ? 100 - cents(m.yes_bid_dollars ?? m.yes_bid) : null)
    // for buckets the model prob is the mass in [lo, hi]; for thresholds P(S>K)
    const r = raw.find((x) => x.k === p.k)
    let q = null
    if (r?.kind === 'bucket') {
      const qHi = qModel(r.hi), qLo = qModel(r.lo)
      q = qHi !== null && qLo !== null ? qLo - qHi : null
    } else {
      q = qModel(p.k)
      // 'less' style markets: yes pays when S is BELOW the strike
      if (r?.m?.strike_type?.startsWith('less') && q !== null) q = 1 - q
    }
    // Kelly f* = (q − c)/(1 − c): positive iff model prob exceeds the ask
    p.yesEdge = q !== null && ya !== null && ya > 0 && ya < 100 ? q - ya / 100 : null
    p.noEdge = q !== null && na !== null && na > 0 && na < 100 ? 1 - q - na / 100 : null
  }

  return {
    sigmaRef,
    priceCurve,
    cdf,
    iv: ivCurve(cdf, forward, T, lognormalOk),
    ivYes: ivCurve(cdfYes, forward, T, lognormalOk),
    ivNo: ivCurve(cdfNo, forward, T, lognormalOk),
    forward,
    T,
    model: lognormalOk ? 'lognormal' : 'normal',
    bucketed: buckets.length >= 2,
    strikeCount: raw.length,
    totalMass: buckets.reduce((s, b) => s + b.mass, 0),
  }
}

// Does this event qualify for strike analysis? (cheap pre-check for the UI)
export function hasStrikeStructure(event) {
  const withStrike = (event.markets || []).filter(
    (m) => m.floor_strike !== null && m.floor_strike !== undefined ||
           m.cap_strike !== null && m.cap_strike !== undefined
  )
  return withStrike.length >= 3
}

// ---------- mutually-exclusive field events (golf tournaments etc.) ----------
export function isFieldEvent(event) {
  return Boolean(
    event.mutually_exclusive &&
      (event.markets || []).length >= 5 &&
      !hasStrikeStructure(event)
  )
}

function fieldMid(m) {
  const bid = cents(m.yes_bid_dollars ?? m.yes_bid)
  const ask = cents(m.yes_ask_dollars ?? m.yes_ask)
  if (bid !== null && ask !== null) return (bid + ask) / 2
  return cents(m.last_price_dollars ?? m.last_price)
}

// Reference joint distribution for a winner-take-all field:
// implied (raw mid) probabilities, de-vigged fair probabilities, and EV of
// buying each outcome at its ask against the fair price.
export function buildFieldDistribution(event) {
  const rows = (event.markets || [])
    .map((m) => {
      const mid = fieldMid(m)
      if (mid === null) return null
      return {
        ticker: m.ticker,
        name: m.yes_sub_title || m.sub_title || m.title || m.ticker,
        mid,
        ask: cents(m.yes_ask_dollars ?? m.yes_ask),
        bid: cents(m.yes_bid_dollars ?? m.yes_bid),
        volume: num(m.volume_fp ?? m.volume),
        implied: mid / 100,
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.implied - a.implied)

  const sumImplied = rows.reduce((s, r) => s + r.implied, 0)
  if (sumImplied <= 0) return null
  for (const r of rows) {
    r.fair = r.implied / sumImplied
    r.fairCents = r.fair * 100
    r.evAtAsk = r.ask !== null ? r.fairCents - r.ask : null
  }

  // entropy in bits — how concentrated the field is
  const entropy = -rows.reduce((s, r) => (r.fair > 0 ? s + r.fair * Math.log2(r.fair) : s), 0)

  return { rows, sumImplied, vig: sumImplied - 1, entropy }
}

// Stress scenarios on the fair distribution. Each returns {label, probs: Map ticker->p}.
export function stressScenarios(dist) {
  const { rows } = dist
  const fav = rows[0]

  const renorm = (pairs) => {
    const total = pairs.reduce((s, [, p]) => s + p, 0)
    return new Map(pairs.map(([t, p]) => [t, total > 0 ? p / total : 0]))
  }

  const favOut = renorm(rows.filter((r) => r !== fav).map((r) => [r.ticker, r.fair]))
  favOut.set(fav.ticker, null) // signals "withdrawn"

  const favUp = (() => {
    const boosted = Math.min(fav.fair * 1.2, 0.99)
    const restScale = (1 - boosted) / (1 - fav.fair || 1)
    return new Map(rows.map((r) => [r.ticker, r === fav ? boosted : r.fair * restScale]))
  })()

  const tails = renorm(rows.map((r) => [r.ticker, r.fair < 0.05 ? r.fair * 1.5 : r.fair]))

  return [
    { key: 'favOut', label: `${fav.name.split(' ').slice(-1)[0].toUpperCase()} OUT`, probs: favOut },
    { key: 'favUp', label: 'FAV +20%', probs: favUp },
    { key: 'tails', label: 'TAILS ×1.5', probs: tails },
  ]
}

// ---------- Kelly ----------
// Binary contract costing `c` (0..1 of $1 payout) with win probability `q`:
// optimal bankroll fraction f* = (q - c) / (1 - c).
export function kellyFraction(q, c) {
  if (!(q > 0 && q < 1) || !(c > 0 && c < 1)) return null
  return (q - c) / (1 - c)
}
