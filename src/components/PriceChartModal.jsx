import React, { useEffect, useState } from 'react'
import { fetchCandles } from '../lib/history.js'
import LineChart from './LineChart.jsx'
import BarChart from './BarChart.jsx'
import CandleChart from './CandleChart.jsx'

const RANGES = [
  { key: '1D', days: 1, interval: 1 },
  { key: '1W', days: 7, interval: 60 },
  { key: '1M', days: 30, interval: 60 },
  { key: '3M', days: 90, interval: 1440 },
]

// CHART / GIP (line) and GPO (OHLC candles) for one market.
export default function PriceChartModal({ market, event, mode: initialMode = 'line', initialRange = '1W', onClose }) {
  const [range, setRange] = useState(initialRange)
  const [mode, setMode] = useState(initialMode)
  const [state, setState] = useState({ loading: true, candles: [], err: null })
  useEffect(() => { setRange(initialRange); setMode(initialMode) }, [initialRange, initialMode, market.ticker])

  useEffect(() => {
    let live = true
    setState({ loading: true, candles: [], err: null })
    const r = RANGES.find((x) => x.key === range) || RANGES[1]
    fetchCandles(event.series_ticker, market.ticker, r.days, r.interval)
      .then((candles) => live && setState({ loading: false, candles, err: null }))
      .catch((e) => live && setState({ loading: false, candles: [], err: e.message }))
    return () => { live = false }
  }, [market.ticker, range])

  const { candles } = state
  const short = range === '1D'
  const xFmt = (t) =>
    new Date(t * 1000).toLocaleString([], short ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' })

  const priceSeries = candles.length >= 2
    ? [
        { name: 'MID', color: 'var(--amber)', points: candles.map((c) => ({ x: c.t, y: c.mid })) },
        ...(candles.some((c) => c.bid !== null) ? [{ name: 'BID', color: 'var(--yes)', dashed: true, points: candles.filter((c) => c.bid !== null).map((c) => ({ x: c.t, y: c.bid })) }] : []),
        ...(candles.some((c) => c.ask !== null) ? [{ name: 'ASK', color: 'var(--no)', dashed: true, points: candles.filter((c) => c.ask !== null).map((c) => ({ x: c.t, y: c.ask })) }] : []),
      ]
    : null
  const volPoints = candles.filter((c) => c.volume > 0).map((c) => ({ x: c.t, y: c.volume }))
  const hi = candles.length ? Math.max(...candles.map((c) => c.high ?? c.mid)) : null
  const lo = candles.length ? Math.min(...candles.map((c) => c.low ?? c.mid)) : null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{mode === 'ohlc' ? 'GPO' : short ? 'GIP' : 'GP'} · {event.title} — {market.yes_sub_title || market.sub_title || market.ticker}</span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-meta">
          <span className="dim">{market.ticker}</span>
          {hi !== null && <span>RANGE HI <b>{hi.toFixed(0)}¢</b> LO <b>{lo.toFixed(0)}¢</b></span>}
          <span className="range-btns">
            <button className={`table-toggle ${mode === 'line' ? 'on' : ''}`} onClick={() => setMode('line')}>LINE</button>
            <button className={`table-toggle ${mode === 'ohlc' ? 'on' : ''}`} onClick={() => setMode('ohlc')}>CANDLES</button>
            <span style={{ width: 10 }} />
            {RANGES.map((r) => (
              <button key={r.key} className={`table-toggle ${range === r.key ? 'on' : ''}`} onClick={() => setRange(r.key)}>{r.key}</button>
            ))}
          </span>
        </div>
        {state.loading && <div className="dim" style={{ padding: 16 }}>loading price history…</div>}
        {state.err && <div className="err-text" style={{ padding: 16 }}>{state.err}</div>}
        {!state.loading && !state.err && !priceSeries && <div className="dim" style={{ padding: 16 }}>not enough history in this range</div>}
        {priceSeries && (
          <>
            <div className="chart-block">
              <div className="chart-title">YES PRICE <span className="dim">· ¢ per $1 payout · {range} · {mode === 'ohlc' ? 'open/high/low/close of each bucket' : 'close of each bucket'}</span></div>
              {mode === 'ohlc' ? (
                <CandleChart candles={candles} xFmt={xFmt} />
              ) : (
                <LineChart series={priceSeries} yDomain={[0, 100]} yFmt={(v) => `${Math.round(v)}¢`} xFmt={xFmt} />
              )}
            </div>
            <div className="chart-block">
              <div className="chart-title">VOLUME <span className="dim">· contracts per bucket</span></div>
              {volPoints.length > 0 ? <BarChart points={volPoints} xFmt={xFmt} /> : <div className="dim" style={{ padding: '10px 16px' }}>no volume in this range</div>}
            </div>
          </>
        )}
        <div className="modal-foot dim">NO price mirrors YES (no = 100 − yes) · bid/ask gap = the spread you cross · candles use the mid of the yes bid/ask OHLC</div>
      </div>
    </div>
  )
}
