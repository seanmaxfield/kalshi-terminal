import React, { useEffect, useMemo, useState } from 'react'
import { api, cents, num, fmtMoney, fmtCompact } from '../api.js'
import { parseStrikes, hasStrikeStructure, kellyFraction } from '../lib/quant.js'
import { buildMarkov } from '../lib/markov.js'
import { fetchCandles } from '../lib/history.js'
import { RulesPanel, Orderbook, TradesPanel } from './MarketPanel.jsx'
import LineChart from './LineChart.jsx'
import BarChart from './BarChart.jsx'

// Security-analysis functions on the selected market (Bloomberg equity/bond
// codes re-expressed for a binary contract).
const TABS = ['DES', 'YAS', 'GY', 'ANR', 'EM', 'RV', 'FA', 'ALLQ', 'DDIS', 'CRPR', 'PHDC', 'ISSD']
const TITLES = {
  DES: 'DESCRIPTION · RULES & ADJUDICATION', YAS: 'YIELD & SPREAD CALCULATOR', GY: 'YIELD GRAPH',
  ANR: 'MODEL RECOMMENDATIONS', EM: 'EXPECTED-VALUE MATRIX', RV: 'RELATIVE VALUE · PEER STRIKES',
  FA: 'FINANCIAL ANALYSIS · SCENARIOS & KELLY', ALLQ: 'ALL QUOTES · BOOK & TAPE', DDIS: 'DISTRIBUTION ACROSS STRIKES',
  CRPR: 'CREDIT PROFILE · SETTLEMENT HISTORY', PHDC: 'HOLDERS & FLOW', ISSD: 'ISSUER · SERIES & EVENT STRUCTURE',
}

const fee = (p) => Math.ceil(7 * (p / 100) * (1 - p / 100)) // cents per contract, taker
const yearsTo = (m) => {
  const t = new Date(m.expected_expiration_time || m.close_time).getTime() - Date.now()
  return Math.max(t / (365.25 * 86400e3), 1 / 8760)
}
const quotes = (m) => {
  const yb = cents(m.yes_bid_dollars ?? m.yes_bid), ya = cents(m.yes_ask_dollars ?? m.yes_ask)
  const nb = cents(m.no_bid_dollars ?? m.no_bid) ?? (ya !== null ? 100 - ya : null)
  const na = cents(m.no_ask_dollars ?? m.no_ask) ?? (yb !== null ? 100 - yb : null)
  const last = cents(m.last_price_dollars ?? m.last_price)
  return { yb, ya, nb, na, last, mid: yb !== null && ya !== null ? (yb + ya) / 2 : last }
}
const fmtK = (v) => (Math.abs(v) >= 1000 ? Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v) : +(+v).toFixed(2))

// ---------- YAS ----------
function YAS({ market }) {
  const q = quotes(market)
  const T = yearsTo(market)
  const days = T * 365.25
  const [qYes, setQYes] = useState(q.mid !== null ? Math.round(q.mid) : 50)
  const row = (side, price) => {
    if (price === null || price <= 0 || price >= 100) return null
    const f = fee(price)
    const cost = price + f
    const gross = (100 - price) / price
    const net = (100 - cost) / cost
    const ann = Math.pow(1 + net, 1 / T) - 1
    const prob = side === 'yes' ? qYes / 100 : 1 - qYes / 100
    const ev = prob * 100 - cost
    return { side, price, f, cost, gross, net, ann, breakeven: cost / 100, ev, kelly: kellyFraction(prob, cost / 100) }
  }
  const rows = [row('yes', q.ya), row('no', q.na)].filter(Boolean)
  return (
    <div className="sec-body">
      <div className="modal-meta">
        <span>YES {q.yb ?? '—'}/{q.ya ?? '—'}¢</span><span>NO {q.nb ?? '—'}/{q.na ?? '—'}¢</span>
        <span>SPREAD <b>{q.ya !== null && q.yb !== null ? q.ya - q.yb : '—'}¢</b></span>
        <span>TIME TO SETTLE <b>{days < 2 ? `${(days * 24).toFixed(1)}h` : `${days.toFixed(1)}d`}</b></span>
      </div>
      <label className="field" style={{ maxWidth: 320 }}>
        <span>YOUR P(YES) % (for EV / Kelly)</span>
        <input type="number" min="1" max="99" value={qYes} onChange={(e) => setQYes(Number(e.target.value))} />
      </label>
      <table className="mini-table">
        <thead><tr><th>BUY</th><th>ASK</th><th>FEE</th><th>ALL-IN</th><th>YIELD TO SETTLE</th><th>ANNUALIZED</th><th>BREAKEVEN P</th><th>EV @ YOUR P</th><th>KELLY</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.side}>
              <td className={r.side}>{r.side.toUpperCase()}</td>
              <td>{r.price}¢</td><td className="dim">{r.f}¢</td><td>{r.cost}¢</td>
              <td>{(r.net * 100).toFixed(1)}% <span className="dim">(gross {(r.gross * 100).toFixed(1)}%)</span></td>
              <td className="amber-text">{r.ann > 50 ? '>5000%' : `${(r.ann * 100).toFixed(0)}%`}</td>
              <td>{(r.breakeven * 100).toFixed(1)}%</td>
              <td className={r.ev > 0 ? 'up' : 'down'}>{r.ev > 0 ? '+' : ''}{r.ev.toFixed(1)}¢</td>
              <td className={r.kelly > 0 ? 'up' : 'dim'}>{r.kelly > 0 ? `${(r.kelly * 100).toFixed(1)}%` : '0'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dim small">yield = (100 − all-in cost)/all-in if the contract wins · annualized compounds that over time-to-settle (short-dated contracts print absurd annualized numbers — that is the point of the column) · breakeven = the win probability at which EV is zero</div>
    </div>
  )
}

// ---------- GY ----------
function GY({ market, event }) {
  const [c, setC] = useState({ loading: true, candles: [] })
  useEffect(() => {
    let live = true
    fetchCandles(event.series_ticker, market.ticker, 30, 60).then((candles) => live && setC({ loading: false, candles })).catch(() => live && setC({ loading: false, candles: [] }))
    return () => { live = false }
  }, [market.ticker])
  const settle = new Date(market.expected_expiration_time || market.close_time).getTime() / 1000
  const pts = c.candles.filter((x) => x.mid > 1 && x.mid < 99).map((x) => {
    const T = Math.max((settle - x.t) / (365.25 * 86400), 1 / 8760)
    const y = Math.pow(100 / x.mid, 1 / T) - 1
    return { x: x.t, y: Math.min(y * 100, 5000) }
  })
  if (c.loading) return <div className="dim" style={{ padding: 14 }}>loading…</div>
  if (pts.length < 2) return <div className="dim" style={{ padding: 14 }}>not enough history</div>
  return (
    <div className="chart-block">
      <div className="chart-title">ANNUALIZED YES YIELD-TO-SETTLE <span className="dim">· at mid · capped 5000% · 1M hourly</span></div>
      <LineChart series={[{ name: 'ANN YIELD', color: 'var(--amber)', points: pts }]} yFmt={(v) => `${Math.round(v)}%`} xFmt={(t) => new Date(t * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })} />
      <div className="dim small">a rising line means the market is getting cheaper relative to its remaining time — YES is being sold</div>
    </div>
  )
}

// ---------- ANR ----------
function ANR({ market, event }) {
  const q = quotes(market)
  const s = useMemo(() => (hasStrikeStructure(event) ? parseStrikes(event) : null), [event])
  const [mk, setMk] = useState(null)
  useEffect(() => {
    let live = true
    fetchCandles(event.series_ticker, market.ticker, 7, 60)
      .then((c) => live && setMk(buildMarkov(c.map((x) => ({ close: x.mid })))))
      .catch(() => {})
    return () => { live = false }
  }, [market.ticker])

  const signals = []
  const pt = s?.priceCurve.find((p) => p.market.ticker === market.ticker)
  if (pt && pt.yesEdge !== null) {
    const modelP = Math.round((pt.yesEdge + (q.ya ?? 0) / 100) * 100)
    signals.push({ name: 'LOGNORMAL MODEL', view: pt.yesEdge > 0.02 ? 'BUY YES' : pt.noEdge > 0.02 ? 'BUY NO' : 'HOLD', detail: `model P(yes) ${modelP}% vs ask ${q.ya}¢ · yes edge ${(pt.yesEdge * 100).toFixed(1)}¢ · no edge ${(pt.noEdge * 100).toFixed(1)}¢` })
  }
  if (s && s.priceCurve.length >= 3) {
    const i = s.priceCurve.findIndex((p) => p.market.ticker === market.ticker)
    if (i > 0 && i < s.priceCurve.length - 1) {
      const smooth = (s.priceCurve[i - 1].yes + s.priceCurve[i + 1].yes) / 2
      const d = smooth - (q.mid ?? smooth)
      signals.push({ name: 'PEER (NEIGHBOR) VALUE', view: d > 3 ? 'BUY YES' : d < -3 ? 'BUY NO' : 'HOLD', detail: `neighbors imply ${smooth.toFixed(0)}¢ vs mid ${q.mid?.toFixed(0)}¢ (${d > 0 ? '+' : ''}${d.toFixed(1)}¢)` })
    }
  }
  if (mk) {
    const dist = mk.matrix[mk.current]
    const n = mk.stateStats.length
    const up = dist.slice(Math.ceil(n / 2)).reduce((a, b) => a + b, 0)
    const dn = dist.slice(0, Math.floor(n / 2)).reduce((a, b) => a + b, 0)
    signals.push({ name: 'MARKOV DRIFT (HOURLY)', view: up - dn > 0.15 ? 'BUY YES' : dn - up > 0.15 ? 'BUY NO' : 'HOLD', detail: `from ${mk.stateStats[mk.current].name}: P(up) ${(up * 100).toFixed(0)}% · P(down) ${(dn * 100).toFixed(0)}% · ${mk.nRets} moves` })
  }
  if (q.ya !== null && q.yb !== null) {
    const spr = q.ya - q.yb
    signals.push({ name: 'LIQUIDITY', view: spr <= 2 ? 'OK' : spr <= 6 ? 'CAUTION' : 'THIN', detail: `spread ${spr}¢ · taker fee ${fee(q.ya)}¢/ct · vol ${fmtCompact(num(market.volume_fp))} · OI ${fmtCompact(num(market.open_interest_fp))}` })
  }
  const buys = signals.filter((x) => x.view === 'BUY YES').length
  const sells = signals.filter((x) => x.view === 'BUY NO').length
  const holds = signals.filter((x) => x.view === 'HOLD').length
  const consensus = buys > sells && buys >= holds ? 'BUY YES' : sells > buys && sells >= holds ? 'BUY NO' : 'HOLD'
  return (
    <div className="sec-body">
      <div className="pf-summary">
        <div className="pf-stat"><span>CONSENSUS</span><b className={consensus === 'BUY YES' ? 'yes' : consensus === 'BUY NO' ? 'no' : ''}>{consensus}</b></div>
        <div className="pf-stat"><span>BUY YES · HOLD · BUY NO</span><b>{buys} · {holds} · {sells}</b></div>
        <div className="pf-stat"><span>MID</span><b>{q.mid?.toFixed(0) ?? '—'}¢</b></div>
      </div>
      <table className="mini-table">
        <thead><tr><th>MODEL</th><th>VIEW</th><th>DETAIL</th></tr></thead>
        <tbody>
          {signals.map((x) => (
            <tr key={x.name}><td>{x.name}</td><td className={x.view === 'BUY YES' ? 'yes' : x.view === 'BUY NO' ? 'no' : x.view === 'THIN' ? 'no' : ''}>{x.view}</td><td className="dim">{x.detail}</td></tr>
          ))}
          {signals.length === 0 && <tr><td colSpan="3" className="dim">no model has a view (needs a strike ladder or price history)</td></tr>}
        </tbody>
      </table>
      <div className="dim small">these are the terminal's own models voting, not human analysts · the lognormal model needs a strike ladder · treat as a checklist, not a signal</div>
    </div>
  )
}

// ---------- EM / RV ----------
function LadderTable({ market, event, mode }) {
  const s = useMemo(() => (hasStrikeStructure(event) ? parseStrikes(event) : null), [event])
  if (!s) return <div className="dim" style={{ padding: 14 }}>this event has no strike ladder — {mode} needs peer strikes</div>
  return (
    <div className="scroll-x">
      <table className="mini-table">
        <thead>
          {mode === 'EM' ? (
            <tr><th>STRIKE</th><th>YES ASK</th><th>NO ASK</th><th>MODEL P(YES)</th><th>EV YES</th><th>EV NO</th><th>KELLY YES</th><th>KELLY NO</th></tr>
          ) : (
            <tr><th>STRIKE</th><th>MID</th><th>PEER-IMPLIED</th><th>RICH / CHEAP</th><th>IV YES</th><th>IV NO</th><th>VOL</th></tr>
          )}
        </thead>
        <tbody>
          {s.priceCurve.map((p, i) => {
            const m = p.market
            const qq = quotes(m)
            const modelP = p.yesEdge !== null && qq.ya !== null ? p.yesEdge + qq.ya / 100 : null
            const kY = modelP !== null && qq.ya ? kellyFraction(modelP, qq.ya / 100) : null
            const kN = modelP !== null && qq.na ? kellyFraction(1 - modelP, qq.na / 100) : null
            const peer = i > 0 && i < s.priceCurve.length - 1 ? (s.priceCurve[i - 1].yes + s.priceCurve[i + 1].yes) / 2 : null
            const ivY = s.ivYes.find((x) => x.k === p.k), ivN = s.ivNo.find((x) => x.k === p.k)
            const me = m.ticker === market.ticker
            return (
              <tr key={m.ticker} className={me ? 'current-row' : ''} style={me ? { outline: '1px solid var(--amber)' } : undefined}>
                <td>{fmtK(p.k)}{me ? ' ◀' : ''}</td>
                {mode === 'EM' ? (
                  <>
                    <td className="yes">{qq.ya ?? '—'}¢</td><td className="no">{qq.na ?? '—'}¢</td>
                    <td>{modelP === null ? '—' : `${(modelP * 100).toFixed(1)}%`}</td>
                    <td className={p.yesEdge > 0 ? 'up' : 'down'}>{p.yesEdge === null ? '—' : `${(p.yesEdge * 100).toFixed(1)}¢`}</td>
                    <td className={p.noEdge > 0 ? 'up' : 'down'}>{p.noEdge === null ? '—' : `${(p.noEdge * 100).toFixed(1)}¢`}</td>
                    <td className={kY > 0 ? 'up' : 'dim'}>{kY > 0 ? `${(kY * 100).toFixed(1)}%` : '0'}</td>
                    <td className={kN > 0 ? 'up' : 'dim'}>{kN > 0 ? `${(kN * 100).toFixed(1)}%` : '0'}</td>
                  </>
                ) : (
                  <>
                    <td>{p.yes.toFixed(1)}¢</td>
                    <td>{peer === null ? '—' : `${peer.toFixed(1)}¢`}</td>
                    <td className={peer === null ? 'dim' : p.yes - peer > 2 ? 'no' : peer - p.yes > 2 ? 'yes' : ''}>
                      {peer === null ? '—' : p.yes - peer > 2 ? `RICH +${(p.yes - peer).toFixed(1)}` : peer - p.yes > 2 ? `CHEAP −${(peer - p.yes).toFixed(1)}` : 'FAIR'}
                    </td>
                    <td className="yes">{ivY ? `${(ivY.sigma * 100).toFixed(0)}%` : '—'}</td>
                    <td className="no">{ivN ? `${(ivN.sigma * 100).toFixed(0)}%` : '—'}</td>
                    <td className="dim">{fmtCompact(num(m.volume_fp))}</td>
                  </>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="dim small" style={{ padding: '4px 10px' }}>
        {mode === 'EM' ? 'EV per $1 contract at the ask vs the fitted lognormal model (forward + median IV) · Kelly = (q − cost)/(1 − cost)' : 'peer-implied = average of the two neighboring strikes\' mids · RICH means this strike prices above its neighbors (sell-side candidate), CHEAP below'}
      </div>
    </div>
  )
}

// ---------- FA ----------
function FA({ market, balance }) {
  const q = quotes(market)
  const [side, setSide] = useState('yes')
  const [n, setN] = useState(10)
  const price = side === 'yes' ? q.ya : q.na
  if (price === null) return <div className="dim" style={{ padding: 14 }}>no ask on this side</div>
  const f = fee(price)
  const cost = (price + f) * n / 100
  const win = n - cost, lose = -cost
  const be = (price + f) / 100
  const ks = [0.4, 0.5, 0.6, 0.7, 0.8].map((p) => ({ p, k: kellyFraction(side === 'yes' ? p : p, (price + f) / 100) }))
  return (
    <div className="sec-body">
      <div className="seg" style={{ maxWidth: 260 }}>
        <button className={`seg-btn yes ${side === 'yes' ? 'on' : ''}`} onClick={() => setSide('yes')}>BUY YES {q.ya}¢</button>
        <button className={`seg-btn no ${side === 'no' ? 'on' : ''}`} onClick={() => setSide('no')}>BUY NO {q.na}¢</button>
      </div>
      <label className="field" style={{ maxWidth: 260 }}><span>CONTRACTS</span><input type="number" min="1" value={n} onChange={(e) => setN(Math.max(1, Number(e.target.value)))} /></label>
      <div className="pf-summary">
        <div className="pf-stat"><span>ALL-IN COST</span><b>{fmtMoney(cost * 100)}</b></div>
        <div className="pf-stat"><span>IF WIN</span><b className="up">+{fmtMoney(win * 100)}</b></div>
        <div className="pf-stat"><span>IF LOSE</span><b className="down">{fmtMoney(lose * 100)}</b></div>
        <div className="pf-stat"><span>BREAKEVEN P</span><b>{(be * 100).toFixed(1)}%</b></div>
        <div className="pf-stat"><span>% OF CASH</span><b>{balance ? `${((cost * 100) / balance * 100).toFixed(1)}%` : '—'}</b></div>
      </div>
      <table className="mini-table">
        <thead><tr><th>IF YOUR P({side.toUpperCase()}) IS</th><th>EV / CONTRACT</th><th>KELLY %</th><th>KELLY $ OF CASH</th></tr></thead>
        <tbody>
          {ks.map(({ p, k }) => (
            <tr key={p}><td>{(p * 100).toFixed(0)}%</td>
              <td className={p * 100 - price - f > 0 ? 'up' : 'down'}>{(p * 100 - price - f).toFixed(1)}¢</td>
              <td className={k > 0 ? 'up' : 'dim'}>{k > 0 ? (k * 100).toFixed(1) + '%' : '0'}</td>
              <td>{k > 0 && balance ? fmtMoney(k * balance) : '—'}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------- DDIS ----------
function DDIS({ event, market }) {
  const ms = (event.markets || []).filter((m) => m.floor_strike !== null && m.floor_strike !== undefined)
  if (ms.length < 3) return <div className="dim" style={{ padding: 14 }}>no strike ladder to distribute across</div>
  const vol = ms.map((m) => ({ x: m.floor_strike, y: num(m.volume_fp), label: m.ticker === market.ticker ? '◀ selected' : undefined }))
  const oi = ms.map((m) => ({ x: m.floor_strike, y: num(m.open_interest_fp) }))
  return (
    <>
      <div className="chart-block"><div className="chart-title">VOLUME BY STRIKE</div><BarChart points={vol} xFmt={fmtK} xLabel="STRIKE" /></div>
      <div className="chart-block"><div className="chart-title">OPEN INTEREST BY STRIKE</div><BarChart points={oi} xFmt={fmtK} xLabel="STRIKE" /></div>
    </>
  )
}

// ---------- CRPR ----------
function CRPR({ event, market }) {
  const [st, setSt] = useState({ loading: true })
  useEffect(() => {
    let live = true
    ;(async () => {
      let cursor = '', all = []
      for (let i = 0; i < 4; i++) {
        const d = await api(`/markets?series_ticker=${event.series_ticker}&status=settled&limit=1000${cursor ? `&cursor=${cursor}` : ''}`)
        all = all.concat(d.markets || []); cursor = d.cursor || ''
        if (!cursor) break
      }
      return { markets: all }
    })()
      .then((d) => {
        if (!live) return
        const ms = (d.markets || []).filter((m) => m.result === 'yes' || m.result === 'no')
        const byEv = new Map()
        for (const m of ms) { if (!byEv.has(m.event_ticker)) byEv.set(m.event_ticker, []); byEv.get(m.event_ticker).push(m) }
        const evs = [...byEv.entries()].map(([et, list]) => {
          const yes = list.filter((m) => m.result === 'yes'), no = list.filter((m) => m.result === 'no')
          const ladder = list.every((m) => m.floor_strike !== null && m.floor_strike !== undefined)
          let bracket = null
          if (ladder && yes.length && no.length) bracket = [Math.max(...yes.map((m) => m.floor_strike)), Math.min(...no.map((m) => m.floor_strike))]
          return { et, n: list.length, yes: yes.length, no: no.length, bracket, close: list[0].close_time }
        }).sort((a, b) => new Date(b.close) - new Date(a.close))
        const yesRate = ms.length ? ms.filter((m) => m.result === 'yes').length / ms.length : null
        // ladder base rate by rank position: how often a strike k steps above the eventual bracket resolved YES
        setSt({ loading: false, evs, yesRate, total: ms.length })
      })
      .catch((e) => live && setSt({ loading: false, err: e.message }))
    return () => { live = false }
  }, [event.series_ticker])
  if (st.loading) return <div className="dim" style={{ padding: 14 }}>loading settlement history…</div>
  if (st.err) return <div className="err-text" style={{ padding: 14 }}>{st.err}</div>
  const brackets = st.evs.filter((e) => e.bracket)
  const widths = brackets.map((e) => e.bracket[1] - e.bracket[0])
  return (
    <div className="sec-body">
      <div className="pf-summary">
        <div className="pf-stat"><span>SETTLED MARKETS</span><b>{st.total}</b></div>
        <div className="pf-stat"><span>SETTLED EVENTS</span><b>{st.evs.length}</b></div>
        <div className="pf-stat"><span>YES RATE (ALL STRIKES)</span><b>{st.yesRate === null ? '—' : `${(st.yesRate * 100).toFixed(1)}%`}</b></div>
        <div className="pf-stat"><span>MEDIAN SETTLE BRACKET WIDTH</span><b>{widths.length ? fmtK(widths.sort((a, b) => a - b)[Math.floor(widths.length / 2)]) : '—'}</b></div>
      </div>
      <table className="mini-table">
        <thead><tr><th>EVENT</th><th>SETTLED</th><th>YES / NO</th><th>SETTLED BETWEEN</th></tr></thead>
        <tbody>
          {st.evs.slice(0, 40).map((e) => (
            <tr key={e.et}><td className="pf-name">{e.et}</td><td className="dim">{new Date(e.close).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' })}</td>
              <td><span className="yes">{e.yes}</span> / <span className="no">{e.no}</span></td>
              <td>{e.bracket ? `${fmtK(e.bracket[0])} – ${fmtK(e.bracket[1])}` : '—'}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="dim small">the series' actual settlement record — base rates you can compare to today's prices · "settled between" = highest YES strike and lowest NO strike</div>
    </div>
  )
}

// ---------- PHDC / ISSD ----------
function PHDC({ market }) {
  return (
    <div className="sec-body">
      <div className="pf-summary">
        <div className="pf-stat"><span>OPEN INTEREST</span><b>{fmtCompact(num(market.open_interest_fp ?? market.open_interest))}</b></div>
        <div className="pf-stat"><span>VOLUME</span><b>{fmtCompact(num(market.volume_fp ?? market.volume))}</b></div>
        <div className="pf-stat"><span>24H VOLUME</span><b>{fmtCompact(num(market.volume_24h_fp ?? market.volume_24h))}</b></div>
        <div className="pf-stat"><span>LIQUIDITY</span><b>{fmtMoney(num(market.liquidity_dollars) * 100)}</b></div>
      </div>
      <TradesPanel ticker={market.ticker} />
      <div className="dim small">Kalshi does not publish holder identities — this is the observable flow: who is lifting offers (YES takers) vs hitting bids (NO takers)</div>
    </div>
  )
}
function ISSD({ event, market, events }) {
  const siblings = events.filter((e) => e.series_ticker === event.series_ticker)
  return (
    <div className="sec-body">
      <div className="pf-summary">
        <div className="pf-stat"><span>SERIES</span><b>{event.series_ticker}</b></div>
        <div className="pf-stat"><span>EVENT</span><b>{event.event_ticker}</b></div>
        <div className="pf-stat"><span>LIVE EVENTS IN SERIES</span><b>{siblings.length}</b></div>
        <div className="pf-stat"><span>MARKETS IN EVENT</span><b>{event.markets?.length}</b></div>
        <div className="pf-stat"><span>MUTUALLY EXCLUSIVE</span><b>{event.mutually_exclusive ? 'YES' : 'NO'}</b></div>
        <div className="pf-stat"><span>CATEGORY</span><b>{event.category}</b></div>
      </div>
      <div className="panel-title">EVENT MARKETS</div>
      <table className="mini-table">
        <thead><tr><th>TICKER</th><th>OUTCOME</th><th>TYPE</th><th>CLOSES</th><th>EXPIRES</th></tr></thead>
        <tbody>
          {(event.markets || []).map((m) => (
            <tr key={m.ticker} style={m.ticker === market.ticker ? { outline: '1px solid var(--amber)' } : undefined}>
              <td className="dim">{m.ticker}</td><td>{m.yes_sub_title}</td><td className="dim">{m.strike_type || m.market_type}</td>
              <td className="dim">{m.close_time ? new Date(m.close_time).toLocaleString() : '—'}</td>
              <td className="dim">{m.expected_expiration_time ? new Date(m.expected_expiration_time).toLocaleString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="panel-title">OTHER LIVE EVENTS IN THIS SERIES</div>
      <div className="dim small" style={{ padding: '0 10px 8px' }}>{siblings.map((e) => e.title).slice(0, 12).join(' · ') || '—'}</div>
    </div>
  )
}

export default function SecurityScreen({ tab: initial, selected, events, balance, onClose }) {
  const [tab, setTab] = useState(initial || 'DES')
  useEffect(() => setTab(initial || 'DES'), [initial])
  const { market, event } = selected
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{tab} · {TITLES[tab]}</span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-meta">
          <span>{event.title}</span><span className="amber-text">{market.yes_sub_title || market.ticker}</span><span className="dim">{market.ticker}</span>
        </div>
        <div className="tabs">
          {TABS.map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}
        </div>
        {tab === 'DES' && <RulesPanel market={market} event={event} />}
        {tab === 'YAS' && <YAS market={market} />}
        {tab === 'GY' && <GY market={market} event={event} />}
        {tab === 'ANR' && <ANR market={market} event={event} />}
        {tab === 'EM' && <LadderTable market={market} event={event} mode="EM" />}
        {tab === 'RV' && <LadderTable market={market} event={event} mode="RV" />}
        {tab === 'FA' && <FA market={market} balance={balance} />}
        {tab === 'ALLQ' && (<><Orderbook ticker={market.ticker} /><TradesPanel ticker={market.ticker} /></>)}
        {tab === 'DDIS' && <DDIS event={event} market={market} />}
        {tab === 'CRPR' && <CRPR event={event} market={market} />}
        {tab === 'PHDC' && <PHDC market={market} />}
        {tab === 'ISSD' && <ISSD event={event} market={market} events={events} />}
      </div>
    </div>
  )
}
