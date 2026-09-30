// Underlying commodity data: Yahoo chart proxy + Google News scraper proxy.
import { api } from '../api.js'

export const COMMODITIES = [
  { key: 'wti', label: 'WTI CRUDE', symbol: 'CL=F', tv: 'NYMEX:CL1!', exchange: 'NYMEX', query: 'WTI crude oil price' },
  { key: 'brent', label: 'BRENT', symbol: 'BZ=F', tv: 'ICEEUR:BRN1!', exchange: 'ICE', query: 'Brent crude oil price' },
  { key: 'gold', label: 'GOLD', symbol: 'GC=F', tv: 'COMEX:GC1!', exchange: 'COMEX', query: 'gold price' },
  { key: 'silver', label: 'SILVER', symbol: 'SI=F', tv: 'COMEX:SI1!', exchange: 'COMEX', query: 'silver price' },
  { key: 'natgas', label: 'NAT GAS', symbol: 'NG=F', tv: 'NYMEX:NG1!', exchange: 'NYMEX', query: 'natural gas price' },
  { key: 'copper', label: 'COPPER', symbol: 'HG=F', tv: 'COMEX:HG1!', exchange: 'COMEX', query: 'copper price' },
  { key: 'platinum', label: 'PLATINUM', symbol: 'PL=F', tv: 'NYMEX:PL1!', exchange: 'NYMEX', query: 'platinum price' },
]

export function fetchExchangeQuote(tvSymbol) {
  return api(`/_underlying/quote?symbol=${encodeURIComponent(tvSymbol)}`)
}

// Official adjudication sources declared by Kalshi for the events matching a
// commodity: union of event.settlement_sources across its live markets.
export function adjudicationSourcesFor(events, commodity) {
  const seen = new Map()
  for (const ev of events || []) {
    if (symbolForEvent(ev) !== commodity.symbol) continue
    for (const s of ev.settlement_sources || []) {
      if (s?.name && !seen.has(s.name)) seen.set(s.name, s.url || null)
    }
  }
  return [...seen.entries()].map(([name, url]) => ({ name, url }))
}

export const RANGES = [
  { key: '1D', range: '1d', interval: '5m' },
  { key: '1W', range: '5d', interval: '30m' },
  { key: '1M', range: '1mo', interval: '1d' },
  { key: '6M', range: '6mo', interval: '1d' },
  { key: '1Y', range: '1y', interval: '1wk' },
]

export function fetchUnderlyingChart(symbol, rangeKey) {
  const r = RANGES.find((x) => x.key === rangeKey) || RANGES[2]
  return api(`/_underlying/chart?symbol=${encodeURIComponent(symbol)}&range=${r.range}&interval=${r.interval}`)
}

export function fetchCommodityNews(query) {
  return api(`/_underlying/news?q=${encodeURIComponent(query)}`)
}

// ---------- global trading sessions ----------
// Classified by Eastern Time: Asia 17:00–03:00, London 03:00–08:00,
// US·LDN overlap 08:00–11:30, US 11:30–17:00.
export const SESSIONS = [
  { key: 'asia', label: 'ASIA', fill: 'rgba(122, 92, 255, 0.13)', swatch: '#7a5cff' },
  { key: 'london', label: 'LONDON', fill: 'rgba(0, 180, 190, 0.13)', swatch: '#00b4be' },
  { key: 'overlap', label: 'US·LDN', fill: 'rgba(128, 168, 95, 0.14)', swatch: '#80a85f' },
  { key: 'us', label: 'US', fill: 'rgba(255, 157, 0, 0.10)', swatch: '#ff9d00' },
]

const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
})

function sessionOf(tSec) {
  const parts = etFmt.formatToParts(new Date(tSec * 1000))
  const h = +parts.find((p) => p.type === 'hour').value
  const m = +parts.find((p) => p.type === 'minute').value
  const mins = (h % 24) * 60 + m
  if (mins >= 3 * 60 && mins < 8 * 60) return 'london'
  if (mins >= 8 * 60 && mins < 11 * 60 + 30) return 'overlap'
  if (mins >= 11 * 60 + 30 && mins < 17 * 60) return 'us'
  return 'asia' // 17:00–24:00 and 00:00–03:00
}

// Merge consecutive intraday bars into session-colored bands for chart shading.
// Breaks bands across data gaps (weekends, exchange breaks).
export function sessionBandsFromBars(bars) {
  if (!bars || bars.length < 2) return []
  const dts = []
  for (let i = 1; i < bars.length; i++) dts.push(bars[i].t - bars[i - 1].t)
  dts.sort((a, b) => a - b)
  const dt = dts[Math.floor(dts.length / 2)] || 3600
  const bands = []
  let cur = null
  for (const b of bars) {
    const s = sessionOf(b.t)
    const gap = cur && b.t - cur.lastT > 3 * dt
    if (cur && cur.key === s && !gap) {
      cur.x2 = b.t + dt / 2
      cur.lastT = b.t
    } else {
      if (cur) bands.push(cur)
      cur = { key: s, x1: b.t - dt / 2, x2: b.t + dt / 2, lastT: b.t }
    }
  }
  if (cur) bands.push(cur)
  const fills = Object.fromEntries(SESSIONS.map((s) => [s.key, s.fill]))
  return bands.map((b) => ({ x1: b.x1, x2: b.x2, fill: fills[b.key] }))
}

// Map a Kalshi scalar event to a Yahoo underlying symbol (null if unknown).
export function symbolForEvent(event) {
  const hay = `${event.series_ticker || ''} ${event.title || ''}`.toLowerCase()
  const rules = [
    [/brent/, 'BZ=F'], // must precede WTI — "Brent crude oil price" contains "crude oil"
    [/wti|crude oil price|kxwti/, 'CL=F'],
    [/gold/, 'GC=F'],
    [/silver/, 'SI=F'],
    [/natural gas|natgas/, 'NG=F'],
    [/copper/, 'HG=F'],
    [/platinum/, 'PL=F'],
    [/btc|bitcoin/, 'BTC-USD'],
    [/eth(?![a-z])|ethereum/, 'ETH-USD'],
    [/solana|sol price/, 'SOL-USD'],
    [/xrp/, 'XRP-USD'],
    [/doge/, 'DOGE-USD'],
    [/nasdaq/, '^NDX'],
    [/s&p|sp500|inx/, '^GSPC'],
    [/dow jones|djia/, '^DJI'],
    [/russell/, '^RUT'],
  ]
  for (const [re, sym] of rules) if (re.test(hay)) return sym
  return null
}

// Daily OHLC bars for range calculations (~3 months back).
export function fetchDailyBars(symbol) {
  return api(`/_underlying/chart?symbol=${encodeURIComponent(symbol)}&range=3mo&interval=1d`).then((d) => d.bars)
}

// Average daily range (high − low) over the last n bars; n=1 → today's range.
export function avgDailyRange(bars, n) {
  const usable = bars.filter((b) => b.high !== null && b.low !== null)
  if (usable.length === 0) return null
  const slice = usable.slice(-n)
  return slice.reduce((s, b) => s + (b.high - b.low), 0) / slice.length
}

// Intraday bars for hourly / 30-min / 5-min range averages.
// Windows sized for a decent sample without hammering the API.
const INTRA_RANGES = { '60m': '1mo', '30m': '5d', '5m': '5d' }
export function fetchIntradayBars(symbol, interval) {
  const range = INTRA_RANGES[interval] || '5d'
  return api(`/_underlying/chart?symbol=${encodeURIComponent(symbol)}&range=${range}&interval=${interval}`).then(
    (d) => d.bars
  )
}

// Mean high−low across all fetched bars of one interval.
export function avgBarRange(bars) {
  const usable = (bars || []).filter((b) => b.high !== null && b.low !== null)
  if (usable.length === 0) return null
  return usable.reduce((s, b) => s + (b.high - b.low), 0) / usable.length
}

// Realized volatility + volume stats from close bars.
export function underlyingStats(bars) {
  if (!bars || bars.length < 3) return null
  const closes = bars.map((b) => b.close)
  const rets = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]))
  }
  if (rets.length < 2) return null
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)
  const sd = Math.sqrt(variance)
  // annualize by the median bar spacing
  const dts = []
  for (let i = 1; i < bars.length; i++) dts.push(bars[i].t - bars[i - 1].t)
  dts.sort((a, b) => a - b)
  const dtMed = dts[Math.floor(dts.length / 2)] || 86400
  const periodsPerYear = (365.25 * 86400) / dtMed
  const vols = bars.map((b) => b.volume || 0)
  const volAvg = vols.reduce((a, b) => a + b, 0) / vols.length
  const last = closes[closes.length - 1]
  const first = closes[0]
  return {
    last,
    changePct: ((last - first) / first) * 100,
    hi: Math.max(...closes),
    lo: Math.min(...closes),
    sdPerBar: sd * 100, // % per bar
    volAnn: sd * Math.sqrt(periodsPerYear) * 100, // annualized %
    volAvg,
    volLast: vols[vols.length - 1],
    nBars: bars.length,
  }
}
