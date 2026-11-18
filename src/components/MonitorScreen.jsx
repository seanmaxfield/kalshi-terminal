import React, { useEffect, useMemo, useState } from 'react'
import { api, cents, num, fmtCompact } from '../api.js'
import { parseStrikes, hasStrikeStructure } from '../lib/quant.js'

// Broad market monitors & calendars (WEI, WB/WS/IM, WCV, NRG, CBQ, IBQ, ECST, WECO).
const QUOTE_SETS = {
  WEI: {
    title: 'WORLD EQUITY INDICES',
    symbols: ['^GSPC', '^DJI', '^IXIC', '^NDX', '^RUT', '^VIX', '^GSPTSE', '^BVSP', '^FTSE', '^GDAXI', '^FCHI', '^STOXX50E', '^N225', '^HSI', '000001.SS', '^BSESN', '^KS11', '^AXJO'],
    kalshi: /\bnasdaq|s&p ?500|\bdow\b|russell|\bindex\b|nikkei/i,
  },
  STK: {
    title: 'US MEGA-CAP EQUITIES',
    symbols: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'BRK-B', 'JPM', 'LLY', 'V', 'WMT', 'XOM', 'UNH', 'MA', 'HD', 'COST', 'NFLX', 'AMD', 'PLTR', 'COIN'],
    kalshi: /\bapple\b|microsoft|nvidia|\btesla\b|amazon|\bmeta\b|\bgoogle\b|alphabet|netflix|\bamd\b|palantir|coinbase|earnings|stock split| sec filing/i,
  },
  SECT: {
    title: 'US SECTOR & BROAD-MARKET ETFs',
    symbols: ['SPY', 'QQQ', 'DIA', 'IWM', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLB', 'XLU', 'XLRE', 'XLC', 'SMH', 'GLD', 'SLV', 'TLT', 'HYG'],
    kalshi: /\bindex\b|s&p ?500|nasdaq|\bsector\b|\betf\b/i,
    labels: { SPY: 'S&P 500 ETF', QQQ: 'NASDAQ 100 ETF', DIA: 'DOW 30 ETF', IWM: 'RUSSELL 2000 ETF', XLK: 'TECHNOLOGY', XLF: 'FINANCIALS', XLE: 'ENERGY', XLV: 'HEALTH CARE', XLY: 'CONS DISCRETIONARY', XLP: 'CONS STAPLES', XLI: 'INDUSTRIALS', XLB: 'MATERIALS', XLU: 'UTILITIES', XLRE: 'REAL ESTATE', XLC: 'COMM SERVICES', SMH: 'SEMICONDUCTORS', GLD: 'GOLD ETF', SLV: 'SILVER ETF', TLT: '20Y+ TREASURY ETF', HYG: 'HIGH-YIELD BONDS' },
  },
  WB: {
    title: 'RATES · GOVT BONDS · MONEY MARKET',
    symbols: ['^IRX', '^FVX', '^TNX', '^TYX', 'ZN=F', 'ZB=F', 'ZF=F', 'ZT=F', 'SR3=F'],
    kalshi: /\bfed\b|\brates?\b|treasury|\byields?\b|fomc|rate cut|rate hike|inflation|\bcpi\b/i,
    labels: { '^IRX': '13-WK T-BILL', '^FVX': '5Y YIELD', '^TNX': '10Y YIELD', '^TYX': '30Y YIELD', 'ZN=F': '10Y NOTE FUT', 'ZB=F': '30Y BOND FUT', 'ZF=F': '5Y NOTE FUT', 'ZT=F': '2Y NOTE FUT', 'SR3=F': '3M SOFR FUT' },
  },
  WCV: {
    title: 'WORLD CURRENCY VALUES',
    symbols: ['DX-Y.NYB', 'EURUSD=X', 'GBPUSD=X', 'JPY=X', 'CHF=X', 'CAD=X', 'AUDUSD=X', 'NZDUSD=X', 'CNY=X', 'MXN=X', 'INR=X', 'BRL=X', 'KRW=X', 'BTC-USD', 'ETH-USD'],
    kalshi: /\busd\b|\beur\b|\byen\b|\bjpy\b|\bgbp\b|dollar|\beuro\b|\bpeso\b|\byuan\b|currency|bitcoin|\bbtc\b|\beth\b|ethereum/i,
  },
  NRG: {
    title: 'ENERGY',
    symbols: ['CL=F', 'BZ=F', 'NG=F', 'RB=F', 'HO=F', 'XLE', 'USO', 'UNG'],
    kalshi: /\bwti\b|brent|crude|\boil\b|\bgas\b|natural gas|gasoline|\bopec\b|\benergy\b/i,
    labels: { 'CL=F': 'WTI CRUDE', 'BZ=F': 'BRENT', 'NG=F': 'NAT GAS', 'RB=F': 'RBOB GASOLINE', 'HO=F': 'HEATING OIL', XLE: 'ENERGY ETF', USO: 'US OIL FUND', UNG: 'NAT GAS FUND' },
  },
}

const fmtPx = (v) => (v === null || v === undefined ? '—' : v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : v.toFixed(v >= 100 ? 2 : 3))

function QuoteTable({ set }) {
  const [q, setQ] = useState({ loading: true, quotes: [] })
  useEffect(() => {
    let live = true
    const load = () =>
      api(`/_monitor/quotes?symbols=${encodeURIComponent(set.symbols.join(','))}`)
        .then((d) => live && setQ({ loading: false, quotes: d.quotes }))
        .catch((e) => live && setQ({ loading: false, quotes: [], err: e.message }))
    load()
    const t = setInterval(load, 60_000)
    return () => { live = false; clearInterval(t) }
  }, [set])
  return (
    <>
      {q.loading && <div className="dim" style={{ padding: 10 }}>loading quotes…</div>}
      {q.err && <div className="err-text" style={{ padding: 10 }}>{q.err}</div>}
      {q.quotes.length > 0 && (
        <table className="mini-table">
          <thead><tr><th>NAME</th><th>SYMBOL</th><th>LAST</th><th>CHG %</th><th>52W LO — HI</th></tr></thead>
          <tbody>
            {q.quotes.map((x) => (
              <tr key={x.symbol}>
                <td className="pf-name">{set.labels?.[x.symbol] || x.name || x.symbol}</td>
                <td className="dim">{x.symbol}</td>
                <td>{x.error ? <span className="dim">n/a</span> : fmtPx(x.price)}</td>
                <td className={x.changePct > 0 ? 'up' : x.changePct < 0 ? 'down' : ''}>
                  {x.changePct === null || x.changePct === undefined ? '—' : `${x.changePct > 0 ? '+' : ''}${x.changePct.toFixed(2)}%`}
                </td>
                <td className="dim">{x.lo52 !== null && x.hi52 !== null ? `${fmtPx(x.lo52)} — ${fmtPx(x.hi52)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="dim small" style={{ padding: '4px 10px' }}>free delayed feed · refreshes every 60s</div>
    </>
  )
}

function RelatedMarkets({ events, pattern, onSelect, limit = 25 }) {
  const rows = useMemo(() => {
    const out = []
    for (const ev of events) {
      if (!pattern.test(`${ev.title} ${ev.series_ticker}`)) continue
      const vol = (ev.markets || []).reduce((s, m) => s + num(m.volume_24h_fp ?? m.volume_fp), 0)
      out.push({ ev, vol })
    }
    return out.sort((a, b) => b.vol - a.vol).slice(0, limit)
  }, [events, pattern])
  return (
    <>
      <div className="panel-title">RELATED KALSHI MARKETS ({rows.length})</div>
      <table className="mini-table">
        <thead><tr><th>EVENT</th><th>CATEGORY</th><th>MKTS</th><th>24H VOL</th><th>CLOSES</th></tr></thead>
        <tbody>
          {rows.map(({ ev, vol }) => {
            const m0 = ev.markets?.[0]
            return (
              <tr key={ev.event_ticker} className="pf-row" onClick={() => m0 && onSelect(m0.ticker)}>
                <td className="pf-name">{ev.title}</td>
                <td className="dim">{ev.category}</td>
                <td>{ev.markets?.length}</td>
                <td>{fmtCompact(vol)}</td>
                <td className="dim">{m0?.close_time ? new Date(m0.close_time).toLocaleDateString() : '—'}</td>
              </tr>
            )
          })}
          {rows.length === 0 && <tr><td colSpan="5" className="dim">no matching Kalshi markets live</td></tr>}
        </tbody>
      </table>
    </>
  )
}

const mover = (m) => {
  const last = cents(m.last_price_dollars ?? m.last_price)
  const prev = cents(m.previous_price_dollars ?? m.previous_price)
  return last !== null && prev !== null ? last - prev : null
}

function CategoryOverview({ events, onPick }) {
  const rows = useMemo(() => {
    const by = new Map()
    for (const ev of events) {
      const c = ev.category || 'Other'
      const r = by.get(c) || { cat: c, events: 0, markets: 0, vol: 0, oi: 0, moves: [] }
      r.events++
      for (const m of ev.markets || []) {
        r.markets++
        r.vol += num(m.volume_24h_fp ?? m.volume_24h)
        r.oi += num(m.open_interest_fp ?? m.open_interest)
        const mv = mover(m)
        if (mv !== null) r.moves.push(Math.abs(mv))
      }
      by.set(c, r)
    }
    return [...by.values()].map((r) => ({ ...r, avgMove: r.moves.length ? r.moves.reduce((a, b) => a + b, 0) / r.moves.length : 0 })).sort((a, b) => b.vol - a.vol)
  }, [events])
  return (
    <table className="mini-table">
      <thead><tr><th>CATEGORY</th><th>EVENTS</th><th>MARKETS</th><th>24H VOL</th><th>OPEN INT</th><th>AVG |MOVE|</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.cat} className="pf-row" onClick={() => onPick(r.cat)}>
            <td className="pf-name">{r.cat}</td><td>{r.events}</td><td>{r.markets}</td>
            <td>{fmtCompact(r.vol)}</td><td>{fmtCompact(r.oi)}</td><td>{r.avgMove.toFixed(1)}¢</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function IndustryOverview({ events, category, onSelect }) {
  const evs = events.filter((e) => (e.category || 'Other') === category)
  const markets = evs.flatMap((ev) => (ev.markets || []).map((m) => ({ ev, m, mv: mover(m), vol: num(m.volume_24h_fp ?? m.volume_24h) })))
  const movers = [...markets].filter((x) => x.mv !== null && x.vol > 0).sort((a, b) => Math.abs(b.mv) - Math.abs(a.mv)).slice(0, 12)
  const active = [...markets].sort((a, b) => b.vol - a.vol).slice(0, 12)
  const soon = [...markets].filter((x) => x.m.close_time).sort((a, b) => new Date(a.m.close_time) - new Date(b.m.close_time)).slice(0, 12)
  const Tbl = ({ title, rows, extra }) => (
    <div className="ibq-col">
      <div className="panel-title">{title}</div>
      <table className="mini-table">
        <tbody>
          {rows.map(({ ev, m, mv, vol }) => (
            <tr key={m.ticker} className="pf-row" onClick={() => onSelect(m.ticker)}>
              <td className="pf-name">{ev.title}<div className="dim small">{m.yes_sub_title || m.ticker}</div></td>
              <td>{extra({ m, mv, vol })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
  return (
    <>
      <div className="modal-meta"><span>{category.toUpperCase()}</span><span>{evs.length} EVENTS</span><span>{markets.length} MARKETS</span></div>
      <div className="ibq-grid">
        <Tbl title="TOP MOVERS (Δ LAST vs PREV)" rows={movers} extra={({ mv }) => <span className={mv > 0 ? 'up' : 'down'}>{mv > 0 ? '+' : ''}{mv}¢</span>} />
        <Tbl title="MOST ACTIVE (24H)" rows={active} extra={({ vol }) => fmtCompact(vol)} />
        <Tbl title="EXPIRING SOONEST" rows={soon} extra={({ m }) => <span className="dim">{new Date(m.close_time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>} />
      </div>
    </>
  )
}

function EconStats({ events, onSelect }) {
  const rows = useMemo(() => {
    const out = []
    for (const ev of events) {
      if ((ev.category || '') !== 'Economics') continue
      let implied = null, unit = ''
      if (hasStrikeStructure(ev)) {
        const s = parseStrikes(ev)
        if (s?.forward !== null && s?.forward !== undefined) { implied = s.forward; unit = 'implied' }
      }
      const top = [...(ev.markets || [])].sort((a, b) => num(b.volume_fp) - num(a.volume_fp))[0]
      if (implied === null && top) {
        const mid = cents(top.last_price_dollars ?? top.last_price)
        if (mid !== null) { implied = `${top.yes_sub_title || 'YES'} ${mid}%`; unit = 'top market' }
      }
      out.push({ ev, implied, unit, close: top?.close_time, vol: (ev.markets || []).reduce((s, m) => s + num(m.volume_fp), 0), ticker: top?.ticker })
    }
    return out.sort((a, b) => b.vol - a.vol)
  }, [events])
  return (
    <table className="mini-table">
      <thead><tr><th>ECONOMIC RELEASE / QUESTION</th><th>MARKET-IMPLIED</th><th>BASIS</th><th>SETTLES</th><th>VOL</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.ev.event_ticker} className="pf-row" onClick={() => r.ticker && onSelect(r.ticker)}>
            <td className="pf-name">{r.ev.title}</td>
            <td className="amber-text">{r.implied === null ? '—' : typeof r.implied === 'number' ? r.implied.toLocaleString('en-US', { maximumFractionDigits: 3 }) : r.implied}</td>
            <td className="dim">{r.unit}</td>
            <td className="dim">{r.close ? new Date(r.close).toLocaleDateString() : '—'}</td>
            <td>{fmtCompact(r.vol)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Calendar({ events, category, onSelect }) {
  const days = useMemo(() => {
    const now = Date.now(), horizon = now + 14 * 86400e3
    const by = new Map()
    for (const ev of events) {
      if (category && (ev.category || 'Other') !== category) continue
      const m0 = ev.markets?.[0]
      if (!m0?.close_time) continue
      const t = new Date(m0.close_time).getTime()
      if (t < now || t > horizon) continue
      const key = new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
      if (!by.has(key)) by.set(key, [])
      by.get(key).push({ ev, m0, t })
    }
    return [...by.entries()].sort((a, b) => a[1][0].t - b[1][0].t)
  }, [events, category])
  return (
    <div className="weco">
      {days.map(([day, items]) => (
        <div key={day} className="weco-day">
          <div className="panel-title">{day.toUpperCase()} · {items.length}</div>
          <table className="mini-table">
            <tbody>
              {items.sort((a, b) => a.t - b.t).slice(0, 40).map(({ ev, m0, t }) => (
                <tr key={ev.event_ticker} className="pf-row" onClick={() => onSelect(m0.ticker)}>
                  <td className="dim" style={{ whiteSpace: 'nowrap' }}>{new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="pf-name">{ev.title}</td>
                  <td className="dim">{ev.category}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {days.length === 0 && <div className="dim" style={{ padding: 14 }}>nothing settling in the next 14 days{category ? ` in ${category}` : ''}</div>}
    </div>
  )
}

export default function MonitorScreen({ kind, category, events, onSelectTicker, onCategory, onClose }) {
  const [k, setK] = useState(kind)
  const [cat, setCat] = useState(category || 'Commodities')
  useEffect(() => { setK(kind); if (category) setCat(category) }, [kind, category])
  const set = QUOTE_SETS[k]
  const titles = { CBQ: 'CBQ · MARKET OVERVIEW BY CATEGORY', IBQ: `IBQ · ${cat.toUpperCase()}`, ECST: 'ECST · MARKET-IMPLIED ECONOMIC STATISTICS', WECO: `WECO · SETTLEMENT CALENDAR${category ? ' · ' + category.toUpperCase() : ''}` }
  const select = (t) => { onSelectTicker(t); onClose() }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{set ? `${k} · ${set.title}` : titles[k]}</span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="tabs">
          {['WEI', 'STK', 'SECT', 'WB', 'WCV', 'NRG', 'CBQ', 'IBQ', 'ECST', 'WECO'].map((x) => (
            <button key={x} className={k === x ? 'on' : ''} onClick={() => setK(x)}>{x}</button>
          ))}
        </div>
        {set && (
          <>
            <QuoteTable set={set} />
            <RelatedMarkets events={events} pattern={set.kalshi} onSelect={select} />
          </>
        )}
        {k === 'CBQ' && <CategoryOverview events={events} onPick={(c) => { setCat(c); setK('IBQ') }} />}
        {k === 'IBQ' && <IndustryOverview events={events} category={cat} onSelect={select} />}
        {k === 'ECST' && <EconStats events={events} onSelect={select} />}
        {k === 'WECO' && <Calendar events={events} category={category} onSelect={select} />}
        <div className="modal-foot dim">click a market to select it · then DES / YAS / ANR / GPO act on it</div>
      </div>
    </div>
  )
}
