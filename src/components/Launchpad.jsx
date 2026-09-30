import React, { useEffect, useState } from 'react'
import { api, cents, num, fmtCompact } from '../api.js'
import { fetchCandles } from '../lib/history.js'
import { Orderbook } from './MarketPanel.jsx'
import LineChart from './LineChart.jsx'

// BLP: a four-panel monitor over the watchlist. PANEL rotates the focus.
export const WL_KEY = 'kalshi-watchlist'
export const loadWatchlist = () => { try { return JSON.parse(localStorage.getItem(WL_KEY)) || [] } catch { return [] } }
export const saveWatchlist = (l) => localStorage.setItem(WL_KEY, JSON.stringify(l))

function MiniChart({ ticker, series }) {
  const [c, setC] = useState([])
  useEffect(() => {
    let live = true
    setC([])
    fetchCandles(series, ticker, 7, 60).then((x) => live && setC(x)).catch(() => {})
    return () => { live = false }
  }, [ticker])
  if (c.length < 2) return <div className="dim" style={{ padding: 10 }}>loading 1W…</div>
  return <LineChart series={[{ name: 'MID', color: 'var(--amber)', points: c.map((x) => ({ x: x.t, y: x.mid })) }]} yDomain={[0, 100]} yFmt={(v) => `${Math.round(v)}¢`} xFmt={(t) => new Date(t * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })} />
}

function MiniNews({ query }) {
  const [items, setItems] = useState([])
  useEffect(() => {
    let live = true
    api(`/_underlying/news?q=${encodeURIComponent(query)}`).then((d) => live && setItems((d.articles || []).slice(0, 8))).catch(() => {})
    return () => { live = false }
  }, [query])
  return (
    <div className="news-list">
      {items.map((a, i) => <a key={i} className="news-item" href={a.link} target="_blank" rel="noreferrer"><span className="news-title">{a.title}</span><span className="news-meta dim">{a.source}</span></a>)}
      {items.length === 0 && <div className="dim" style={{ padding: 10 }}>no headlines</div>}
    </div>
  )
}

export default function Launchpad({ marketIndex, onSelectTicker, rotate, onClose, keywords }) {
  const [wl, setWl] = useState(loadWatchlist)
  const [focus, setFocus] = useState(0)
  useEffect(() => { if (rotate && wl.length) setFocus((f) => (f + 1) % wl.length) }, [rotate])
  const remove = (t) => { const n = wl.filter((x) => x !== t); setWl(n); saveWatchlist(n); setFocus(0) }
  const rows = wl.map((t) => ({ t, info: marketIndex.get(t) }))
  const cur = rows[focus]?.info

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">BLP · LAUNCHPAD</span>
          <span className="dim small" style={{ marginLeft: 'auto', marginRight: 12 }}>PANEL rotates focus · SPDL adds the selected market · UNWATCH removes</span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        {wl.length === 0 ? (
          <div className="dim" style={{ padding: 16 }}>watchlist is empty — select a market and type <b>SPDL</b></div>
        ) : (
          <div className="lp-grid">
            <div className="lp-panel">
              <div className="panel-title">WATCHLIST · {wl.length}</div>
              <table className="mini-table">
                <thead><tr><th>MARKET</th><th>YES</th><th>LAST</th><th>24H</th><th></th></tr></thead>
                <tbody>
                  {rows.map(({ t, info }, i) => {
                    const m = info?.market
                    return (
                      <tr key={t} className={`pf-row ${i === focus ? 'current-row' : ''}`} style={i === focus ? { outline: '1px solid var(--amber)' } : undefined} onClick={() => setFocus(i)} onDoubleClick={() => { onSelectTicker(t); onClose() }}>
                        <td className="pf-name">{info ? info.event.title : t}<div className="dim small">{m?.yes_sub_title || t}</div></td>
                        <td className="yes">{m ? `${cents(m.yes_bid_dollars) ?? '—'}/${cents(m.yes_ask_dollars) ?? '—'}` : '—'}</td>
                        <td>{m ? `${cents(m.last_price_dollars) ?? '—'}¢` : '—'}</td>
                        <td className="dim">{m ? fmtCompact(num(m.volume_24h_fp)) : '—'}</td>
                        <td><button className="link-btn" onClick={(e) => { e.stopPropagation(); remove(t) }}>✕</button></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="dim small" style={{ padding: '4px 10px' }}>double-click selects the market in the main window</div>
            </div>
            <div className="lp-panel">
              <div className="panel-title">CHART · {cur?.market.yes_sub_title || rows[focus]?.t}</div>
              {cur ? <MiniChart ticker={cur.market.ticker} series={cur.event.series_ticker} /> : <div className="dim" style={{ padding: 10 }}>market not in live feed</div>}
            </div>
            <div className="lp-panel">
              <div className="panel-title">BOOK</div>
              {cur ? <Orderbook ticker={cur.market.ticker} /> : null}
            </div>
            <div className="lp-panel">
              <div className="panel-title">NEWS</div>
              {cur ? <MiniNews query={keywords(cur)} /> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
