// Price-history fetching + correlation statistics for field analysis.
import { api, cents, num } from '../api.js'

// Hourly mid-price history for one market. Returns [{t, mid}] (mid in cents).
export async function fetchHistory(seriesTicker, marketTicker, days = 10) {
  const end = Math.floor(Date.now() / 1000)
  const start = end - days * 86400
  const d = await api(
    `/series/${seriesTicker}/markets/${marketTicker}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=60`
  )
  return (d.candlesticks || [])
    .map((c) => {
      const bid = cents(c.yes_bid?.close_dollars ?? c.yes_bid?.close)
      const ask = cents(c.yes_ask?.close_dollars ?? c.yes_ask?.close)
      const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null
      return mid === null ? null : { t: c.end_period_ts, mid }
    })
    .filter(Boolean)
}

// Full candle series for the price chart modal: bid/ask/mid + volume per bucket.
export async function fetchCandles(seriesTicker, marketTicker, days, intervalMin) {
  const end = Math.floor(Date.now() / 1000)
  const start = end - Math.round(days * 86400)
  const d = await api(
    `/series/${seriesTicker}/markets/${marketTicker}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=${intervalMin}`
  )
  return (d.candlesticks || [])
    .map((c) => {
      const bid = cents(c.yes_bid?.close_dollars ?? c.yes_bid?.close)
      const ask = cents(c.yes_ask?.close_dollars ?? c.yes_ask?.close)
      if (bid === null && ask === null) return null
      const m = (f) => {
        const b = cents(c.yes_bid?.[f + '_dollars'] ?? c.yes_bid?.[f])
        const a = cents(c.yes_ask?.[f + '_dollars'] ?? c.yes_ask?.[f])
        return b !== null && a !== null ? (b + a) / 2 : b ?? a
      }
      return {
        t: c.end_period_ts,
        bid,
        ask,
        mid: bid !== null && ask !== null ? (bid + ask) / 2 : bid ?? ask,
        open: m('open'),
        high: m('high'),
        low: m('low'),
        volume: num(c.volume_fp ?? c.volume),
        oi: num(c.open_interest_fp ?? c.open_interest),
      }
    })
    .filter(Boolean)
}

// Fetch histories for the top-N outcomes by volume (then by price) in a field
// event. Reports progress; returns { players, capped, total }.
export async function fetchFieldHistories(event, topN = 20, days = 10, onProgress) {
  const markets = [...(event.markets || [])]
    .map((m) => ({
      ticker: m.ticker,
      name: m.yes_sub_title || m.sub_title || m.title || m.ticker,
      volume: num(m.volume_fp ?? m.volume),
      mid: cents(m.last_price_dollars ?? m.last_price) ?? 0,
    }))
    .sort((a, b) => b.volume - a.volume || b.mid - a.mid)

  const picked = markets.slice(0, topN)
  let done = 0
  const players = await Promise.all(
    picked.map(async (p) => {
      try {
        const series = await fetchHistory(event.series_ticker, p.ticker, days)
        return { ...p, series }
      } catch {
        return { ...p, series: [] }
      } finally {
        done++
        onProgress?.(done, picked.length)
      }
    })
  )
  return {
    players: players.filter((p) => p.series.length >= 8),
    capped: markets.length > topN,
    total: markets.length,
  }
}

// ---------- per-strike price volatility (for the strike vol chart) ----------
// Kalshi candles come in 1 / 60 / 1440 minute intervals; other bar sizes are
// resampled from the nearest finer base. Bar size and history length are
// chosen independently; validity is constrained by base-fetch size and a
// minimum sample count.
export const STRIKE_VOL_BARS = [
  { key: '5M', base: 1, step: 300 },
  { key: '30M', base: 1, step: 1800 },
  { key: '1H', base: 60, step: 3600 },
  { key: '4H', base: 60, step: 14400 },
  { key: '1D', base: 1440, step: 86400 },
  { key: '1W', base: 1440, step: 604800 },
]
export const STRIKE_VOL_HISTORIES = [
  { key: '1D', days: 1 },
  { key: '3D', days: 3 },
  { key: '1W', days: 7 },
  { key: '2W', days: 14 },
  { key: '1M', days: 30 },
  { key: '3M', days: 90 },
  { key: '6M', days: 180 },
]
// max base candles per request (Kalshi caps candlestick queries)
const MAX_BASE_CANDLES = 4500
export function volComboValid(bar, hist) {
  const baseCandles = (hist.days * 1440) / bar.base
  const bars = (hist.days * 86400) / bar.step
  return baseCandles <= MAX_BASE_CANDLES && bars >= 5
}

async function fetchResampledMids(seriesTicker, marketTicker, def, days) {
  const end = Math.floor(Date.now() / 1000)
  const start = end - days * 86400
  const d = await api(
    `/series/${seriesTicker}/markets/${marketTicker}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=${def.base}`
  )
  const buckets = new Map()
  for (const c of d.candlesticks || []) {
    const bid = cents(c.yes_bid?.close_dollars ?? c.yes_bid?.close)
    const ask = cents(c.yes_ask?.close_dollars ?? c.yes_ask?.close)
    if (bid === null || ask === null) continue
    // last close within each resample bucket wins
    buckets.set(Math.floor(c.end_period_ts / def.step), (bid + ask) / 2)
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, mid]) => mid)
}

const quantile = (sorted, q) => {
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo)
}

// Per-strike stats: σ of % returns for yes and no sides + Δ-price distribution.
export function strikeVolStats(mids) {
  if (mids.length < 4) return null
  const clamp = (v) => Math.min(99.5, Math.max(0.5, v))
  const yesRets = [], noRets = [], deltas = []
  for (let i = 1; i < mids.length; i++) {
    const a = clamp(mids[i - 1]), b = clamp(mids[i])
    yesRets.push((b - a) / a)
    noRets.push(((100 - b) - (100 - a)) / (100 - a))
    deltas.push(mids[i] - mids[i - 1])
  }
  const sd = (xs) => {
    const m = xs.reduce((s, v) => s + v, 0) / xs.length
    return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1))
  }
  const ds = [...deltas].sort((a, b) => a - b)
  return {
    yesVol: sd(yesRets) * 100,
    noVol: sd(noRets) * 100,
    box: {
      lo: quantile(ds, 0.05),
      q1: quantile(ds, 0.25),
      med: quantile(ds, 0.5),
      q3: quantile(ds, 0.75),
      hi: quantile(ds, 0.95),
      n: ds.length,
    },
  }
}

// Fetch + compute for a capped set of strike markets.
export async function fetchStrikeVols(seriesTicker, strikes, def, days, onProgress) {
  let done = 0
  const out = await Promise.all(
    strikes.map(async (s) => {
      try {
        const mids = await fetchResampledMids(seriesTicker, s.ticker, def, days)
        return { ...s, stats: strikeVolStats(mids) }
      } catch {
        return { ...s, stats: null }
      } finally {
        onProgress?.(++done, strikes.length)
      }
    })
  )
  return out.filter((s) => s.stats)
}

export function pearson(xs, ys) {
  const n = xs.length
  if (n < 3) return null
  let sx = 0, sy = 0
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i] }
  const mx = sx / n, my = sy / n
  let cov = 0, vx = 0, vy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my
    cov += dx * dy; vx += dx * dx; vy += dy * dy
  }
  if (vx <= 1e-12 || vy <= 1e-12) return null
  return cov / Math.sqrt(vx * vy)
}

// Align players on the common hourly grid (from the latest first-observation
// onward) and difference into hourly price changes.
export function buildReturnMatrix(players) {
  const maps = players.map((p) => new Map(p.series.map((s) => [s.t, s.mid])))
  const firstTs = Math.max(...players.map((p) => p.series[0].t))
  const grid = [...new Set(players.flatMap((p) => p.series.map((s) => s.t)))]
    .filter((t) => t >= firstTs)
    .sort((a, b) => a - b)
  // forward-fill each player over the grid
  const prices = players.map((_, i) => {
    let lastVal = null
    return grid.map((t) => {
      if (maps[i].has(t)) lastVal = maps[i].get(t)
      return lastVal
    })
  })
  const usable = grid.map((_, k) => prices.every((row) => row[k] !== null))
  const returns = players.map((_, i) => {
    const r = []
    for (let k = 1; k < grid.length; k++) {
      if (usable[k] && usable[k - 1]) r.push(prices[i][k] - prices[i][k - 1])
      else r.push(null)
    }
    return r
  })
  return { returns, prices, grid }
}

// Pairwise correlation matrix over hourly price changes.
export function correlationMatrix(returns) {
  const n = returns.length
  const M = Array.from({ length: n }, () => Array(n).fill(null))
  for (let i = 0; i < n; i++) {
    M[i][i] = 1
    for (let j = i + 1; j < n; j++) {
      const xs = [], ys = []
      for (let k = 0; k < returns[i].length; k++) {
        if (returns[i][k] !== null && returns[j][k] !== null) {
          xs.push(returns[i][k]); ys.push(returns[j][k])
        }
      }
      const c = pearson(xs, ys)
      M[i][j] = c; M[j][i] = c
    }
  }
  return M
}

// Each player's correlation (and beta) vs the aggregate of the REST of the
// field: field_i(t) = Σ_{j≠i} price_j(t).
export function fieldCorrelations(players, returnMatrix) {
  const { returns } = returnMatrix
  const n = returns.length
  const out = []
  for (let i = 0; i < n; i++) {
    const xs = [], ys = []
    for (let k = 0; k < returns[i].length; k++) {
      if (returns[i][k] === null) continue
      let fieldSum = 0, ok = true
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        if (returns[j][k] === null) { ok = false; break }
        fieldSum += returns[j][k]
      }
      if (ok) { xs.push(returns[i][k]); ys.push(fieldSum) }
    }
    const corr = pearson(xs, ys)
    // beta of player vs rest-of-field aggregate
    let beta = null
    if (corr !== null) {
      const my = ys.reduce((s, v) => s + v, 0) / ys.length
      const mx = xs.reduce((s, v) => s + v, 0) / xs.length
      let cov = 0, vy = 0
      for (let k = 0; k < xs.length; k++) {
        cov += (xs[k] - mx) * (ys[k] - my)
        vy += (ys[k] - my) ** 2
      }
      beta = vy > 1e-12 ? cov / vy : null
    }
    out.push({ player: players[i], corr, beta, samples: xs.length })
  }
  return out.sort((a, b) => (a.corr ?? 2) - (b.corr ?? 2))
}
