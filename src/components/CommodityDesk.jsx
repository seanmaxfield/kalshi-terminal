import React, { useEffect, useState } from 'react'
import { COMMODITIES, RANGES, SESSIONS, fetchUnderlyingChart, fetchCommodityNews, underlyingStats, sessionBandsFromBars, fetchExchangeQuote, adjudicationSourcesFor } from '../lib/underlying.js'
import { fmtCompact } from '../api.js'
import LineChart from './LineChart.jsx'
import BarChart from './BarChart.jsx'
import MarkovTool from './MarkovTool.jsx'

const fmtPx = (v) => (v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(2))

function ago(pubDate) {
  const ms = Date.now() - new Date(pubDate).getTime()
  if (!Number.isFinite(ms)) return ''
  const h = ms / 3600e3
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`
  if (h < 48) return `${Math.round(h)}h`
  return `${Math.round(h / 24)}d`
}

export default function CommodityDesk({ events }) {
  const [open, setOpen] = useState(true)
  const [commodity, setCommodity] = useState(COMMODITIES[0])
  const [range, setRange] = useState('1M')
  const [source, setSource] = useState('yahoo') // 'yahoo' | 'exchange'
  const [exQuote, setExQuote] = useState({ loading: false, data: null, err: null })
  const [chart, setChart] = useState({ loading: true, bars: [], meta: null, err: null })
  const [news, setNews] = useState({ loading: true, articles: [], err: null })
  const [showMarkov, setShowMarkov] = useState(false)

  // Exchange reference quote (the venue adjudication points at), 10-min delayed.
  useEffect(() => {
    if (!open || source !== 'exchange') return
    let live = true
    const load = () => {
      setExQuote((s) => ({ ...s, loading: true }))
      fetchExchangeQuote(commodity.tv)
        .then((d) => live && setExQuote({ loading: false, data: d, err: null }))
        .catch((e) => live && setExQuote({ loading: false, data: null, err: e.message }))
    }
    load()
    const t = setInterval(load, 60_000)
    return () => { live = false; clearInterval(t) }
  }, [commodity.key, source, open])

  useEffect(() => {
    if (!open) return
    let live = true
    setChart((s) => ({ ...s, loading: true, err: null }))
    fetchUnderlyingChart(commodity.symbol, range)
      .then((d) => live && setChart({ loading: false, bars: d.bars, meta: d.meta, err: null }))
      .catch((e) => live && setChart({ loading: false, bars: [], meta: null, err: e.message }))
    const t = setInterval(() => {
      fetchUnderlyingChart(commodity.symbol, range)
        .then((d) => live && setChart({ loading: false, bars: d.bars, meta: d.meta, err: null }))
        .catch(() => {})
    }, 60_000)
    return () => { live = false; clearInterval(t) }
  }, [commodity.key, range, open])

  useEffect(() => {
    if (!open) return
    let live = true
    setNews((s) => ({ ...s, loading: true, err: null }))
    const load = () =>
      fetchCommodityNews(commodity.query)
        .then((d) => live && setNews({ loading: false, articles: d.articles, err: null }))
        .catch((e) => live && setNews({ loading: false, articles: [], err: e.message }))
    load()
    const t = setInterval(load, 300_000)
    return () => { live = false; clearInterval(t) }
  }, [commodity.key, open])

  const stats = underlyingStats(chart.bars)
  const short = range === '1D' || range === '1W'
  // Session shading only makes sense on intraday bars — a daily bar spans
  // every session at once.
  const sessionBands = short ? sessionBandsFromBars(chart.bars) : []
  const xFmt = (t) =>
    new Date(t * 1000).toLocaleString([], short
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric' })

  return (
    <div className="commodity-desk">
      <div className="desk-head" onClick={() => setOpen((v) => !v)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="panel-title" style={{ border: 'none', padding: 0 }}>COMMODITY DESK · UNDERLYING</span>
        {!open && <span className="dim small">expand for underlying prices, vol + news</span>}
      </div>
      {open && (
        <>
          <div className="desk-controls">
            {COMMODITIES.map((c) => (
              <button
                key={c.key}
                className={`table-toggle ${commodity.key === c.key ? 'on' : ''}`}
                onClick={() => setCommodity(c)}
              >
                {c.label}
              </button>
            ))}
            <span className="range-btns">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  className={`table-toggle ${range === r.key ? 'on' : ''}`}
                  onClick={() => setRange(r.key)}
                >
                  {r.key}
                </button>
              ))}
              <button className="table-toggle markov-btn" onClick={() => setShowMarkov(true)}>
                ⛓ MARKOV
              </button>
            </span>
          </div>
          <div className="desk-controls">
            <span className="dim small">PRICE SOURCE</span>
            <button className={`table-toggle ${source === 'yahoo' ? 'on' : ''}`} onClick={() => setSource('yahoo')}>
              YAHOO MIRROR
            </button>
            <button className={`table-toggle ${source === 'exchange' ? 'on' : ''}`} onClick={() => setSource('exchange')}>
              EXCHANGE REF ({commodity.exchange})
            </button>
            <span className="adjud-chips">
              <span className="dim small">ADJUDICATION:</span>
              {(() => {
                const srcs = adjudicationSourcesFor(events, commodity)
                if (!srcs.length) return <span className="dim small">per-market rules (select a market for details)</span>
                return srcs.slice(0, 4).map((s) =>
                  s.url ? (
                    <a key={s.name} className="adjud-chip" href={s.url} target="_blank" rel="noreferrer">{s.name}</a>
                  ) : (
                    <span key={s.name} className="adjud-chip">{s.name}</span>
                  )
                )
              })()}
            </span>
          </div>
          {source === 'exchange' && (
            <div className="exchange-quote">
              {exQuote.err && <span className="err-text">EXCHANGE QUOTE: {exQuote.err}</span>}
              {exQuote.data && (
                <>
                  <span className="dim small">{commodity.tv}</span>
                  <b className="ex-price">${exQuote.data.price >= 1000 ? exQuote.data.price.toLocaleString('en-US', { maximumFractionDigits: 1 }) : exQuote.data.price.toFixed(2)}</b>
                  {exQuote.data.changePct !== null && (
                    <span className={exQuote.data.changePct > 0 ? 'up' : 'down'}>
                      {exQuote.data.changePct > 0 ? '+' : ''}{exQuote.data.changePct.toFixed(2)}%
                    </span>
                  )}
                  {stats && (
                    <span className="dim small">
                      vs yahoo mirror {((exQuote.data.price / stats.last - 1) * 100).toFixed(2)}% diff
                    </span>
                  )}
                  {exQuote.data.delayed && <span className="tag">10-MIN DELAYED</span>}
                  <span className="dim small">chart bars below remain yahoo — exchange feed has no free history</span>
                </>
              )}
            </div>
          )}

          <div className="desk-body">
            <div className="desk-chart">
              {chart.err && <div className="err-text" style={{ padding: 10 }}>UNDERLYING: {chart.err}</div>}
              {chart.loading && !chart.bars.length && <div className="dim" style={{ padding: 10 }}>loading {commodity.label}…</div>}
              {stats && (
                <div className="desk-stats">
                  <div className="desk-stat">
                    <span>{chart.meta?.shortName || commodity.label}</span>
                    <b>${fmtPx(stats.last)}</b>
                  </div>
                  <div className="desk-stat">
                    <span>Δ {range}</span>
                    <b className={stats.changePct > 0 ? 'up' : stats.changePct < 0 ? 'down' : ''}>
                      {stats.changePct > 0 ? '+' : ''}{stats.changePct.toFixed(2)}%
                    </b>
                  </div>
                  <div className="desk-stat"><span>HI / LO</span><b>${fmtPx(stats.hi)} / ${fmtPx(stats.lo)}</b></div>
                  <div className="desk-stat"><span>REALIZED VOL (ANN)</span><b className="amber-text">{stats.volAnn.toFixed(1)}%</b></div>
                  <div className="desk-stat"><span>σ / BAR</span><b>{stats.sdPerBar.toFixed(2)}%</b></div>
                  <div className="desk-stat"><span>AVG VOL / BAR</span><b>{fmtCompact(stats.volAvg)}</b></div>
                </div>
              )}
              {chart.bars.length >= 2 && (
                <>
                  {sessionBands.length > 0 && (
                    <div className="session-legend">
                      <span className="dim small">SESSIONS (ET):</span>
                      {SESSIONS.map((s) => (
                        <span key={s.key} className="session-key">
                          <span className="session-swatch" style={{ background: s.swatch }} />
                          {s.label}
                        </span>
                      ))}
                    </div>
                  )}
                  <LineChart
                    series={[{ name: commodity.label, color: 'var(--amber)', points: chart.bars.map((b) => ({ x: b.t, y: b.close })) }]}
                    bands={sessionBands}
                    yFmt={(v) => `$${fmtPx(v)}`}
                    xFmt={xFmt}
                  />
                  {chart.bars.some((b) => b.volume > 0) && (
                    <BarChart
                      points={chart.bars.filter((b) => b.volume > 0).map((b) => ({ x: b.t, y: b.volume }))}
                      bands={sessionBands}
                      xFmt={xFmt}
                    />
                  )}
                </>
              )}
            </div>

            <div className="desk-news">
              <div className="panel-title">NEWS WIRE · {commodity.label}</div>
              {news.err && <div className="err-text" style={{ padding: 10 }}>NEWS: {news.err}</div>}
              {news.loading && !news.articles.length && <div className="dim" style={{ padding: 10 }}>scraping headlines…</div>}
              <div className="news-list">
                {news.articles.map((a, i) => (
                  <a key={i} className="news-item" href={a.link} target="_blank" rel="noreferrer">
                    <span className="news-title">{a.title}</span>
                    <span className="news-meta dim">
                      {a.source || ''}{a.pubDate ? ` · ${ago(a.pubDate)} ago` : ''}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
      {showMarkov && <MarkovTool initialCommodity={commodity} onClose={() => setShowMarkov(false)} />}
    </div>
  )
}
