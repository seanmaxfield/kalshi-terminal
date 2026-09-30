import React, { useEffect, useState } from 'react'
import { STRIKE_VOL_BARS, STRIKE_VOL_HISTORIES, volComboValid, fetchStrikeVols } from '../lib/history.js'
import LineChart from './LineChart.jsx'
import BoxPlot from './BoxPlot.jsx'

const CAP = 24

// Kalshi price volatility per strike: σ of yes/no returns (line) or the
// distribution of per-bar Δyes (box). Bar size and history length are chosen
// independently; impossible combos are disabled.
export default function StrikeVolChart({ event, strikes, fmtStrike }) {
  const [barKey, setBarKey] = useState('1H')
  const [histKey, setHistKey] = useState('1W')
  const [form, setForm] = useState('line') // 'line' | 'box'
  const [cache, setCache] = useState({}) // `${bar}|${hist}` -> {status, ...}

  const bar = STRIKE_VOL_BARS.find((b) => b.key === barKey)
  const hist = STRIKE_VOL_HISTORIES.find((h) => h.key === histKey)

  // snap history to the nearest valid option when the bar size invalidates it
  useEffect(() => {
    if (volComboValid(bar, hist)) return
    const valid = STRIKE_VOL_HISTORIES.filter((h) => volComboValid(bar, h))
    if (valid.length) {
      const closest = valid.reduce((best, h) =>
        Math.abs(Math.log(h.days / hist.days)) < Math.abs(Math.log(best.days / hist.days)) ? h : best
      )
      setHistKey(closest.key)
    }
  }, [barKey])

  const cacheKey = `${barKey}|${histKey}`
  const capped = [...strikes].sort((a, b) => b.volume - a.volume).slice(0, CAP).sort((a, b) => a.k - b.k)

  useEffect(() => {
    if (!volComboValid(bar, hist) || cache[cacheKey]) return
    let live = true
    setCache((c) => ({ ...c, [cacheKey]: { status: 'loading', progress: [0, capped.length] } }))
    fetchStrikeVols(event.series_ticker, capped, bar, hist.days, (done, total) => {
      if (live)
        setCache((c) =>
          c[cacheKey]?.status === 'loading'
            ? { ...c, [cacheKey]: { status: 'loading', progress: [done, total] } }
            : c
        )
    })
      .then((data) => live && setCache((c) => ({ ...c, [cacheKey]: { status: 'ready', data } })))
      .catch((e) => live && setCache((c) => ({ ...c, [cacheKey]: { status: 'error', msg: e.message } })))
    return () => { live = false }
  }, [cacheKey, event.series_ticker])

  const entry = cache[cacheKey]
  const data = entry?.status === 'ready' ? entry.data : null
  const nBars = Math.round((hist.days * 86400) / bar.step)

  return (
    <div className="chart-block">
      <div className="chart-title">
        KALSHI PRICE VOLATILITY BY STRIKE
        <span className="dim">
          {' '}· {barKey.toLowerCase()} bars over {histKey.toLowerCase()} (≈{nBars.toLocaleString()} bars) · top{' '}
          {Math.min(CAP, strikes.length)} of {strikes.length} strikes by volume
        </span>
      </div>
      <div className="strike-vol-controls">
        <span className="dim small">BAR</span>
        {STRIKE_VOL_BARS.map((b) => (
          <button
            key={b.key}
            className={`table-toggle ${barKey === b.key ? 'on' : ''}`}
            onClick={() => setBarKey(b.key)}
          >
            {b.key}
          </button>
        ))}
        <span className="dim small" style={{ marginLeft: 10 }}>HISTORY</span>
        {STRIKE_VOL_HISTORIES.map((h) => (
          <button
            key={h.key}
            className={`table-toggle ${histKey === h.key ? 'on' : ''}`}
            disabled={!volComboValid(bar, h)}
            title={!volComboValid(bar, h) ? 'combo unavailable: too many candles or too few bars' : undefined}
            onClick={() => setHistKey(h.key)}
          >
            {h.key}
          </button>
        ))}
        <span style={{ width: 12 }} />
        <button className={`table-toggle ${form === 'line' ? 'on' : ''}`} onClick={() => setForm('line')}>LINE</button>
        <button className={`table-toggle ${form === 'box' ? 'on' : ''}`} onClick={() => setForm('box')}>BOX</button>
      </div>

      {entry?.status === 'loading' && (
        <div className="dim" style={{ padding: '10px 16px' }}>
          loading candles… {entry.progress?.[0] ?? 0}/{entry.progress?.[1] ?? capped.length}
        </div>
      )}
      {entry?.status === 'error' && <div className="err-text" style={{ padding: '10px 16px' }}>{entry.msg}</div>}
      {data && data.length < 3 && (
        <div className="dim" style={{ padding: '10px 16px' }}>
          not enough candle history for {barKey} bars over {histKey} (only {data.length} strikes with ≥4 bars)
        </div>
      )}

      {data && data.length >= 3 && form === 'line' && (
        <LineChart
          series={[
            { name: 'YES σ', color: 'var(--yes)', points: data.map((d) => ({ x: d.k, y: d.stats.yesVol })) },
            { name: 'NO σ', color: 'var(--no)', dashed: true, points: data.map((d) => ({ x: d.k, y: d.stats.noVol })) },
          ]}
          yFmt={(v) => `${v.toFixed(1)}%`}
          xFmt={fmtStrike}
          xLabel="STRIKE"
        />
      )}
      {data && data.length >= 3 && form === 'box' && (
        <BoxPlot
          points={data.map((d) => ({ x: d.k, ...d.stats.box }))}
          xFmt={fmtStrike}
          yFmt={(v) => `${v > 0 ? '+' : ''}${(+v).toFixed(1)}¢`}
          xLabel="STRIKE"
        />
      )}
      <div className="dim small" style={{ padding: '2px 16px 6px' }}>
        line: σ of per-bar % returns of each side's mid (cheap side = higher % vol) · box: distribution of per-bar
        Δyes in cents (box q1–q3, white median, whiskers p5–p95) — NO deltas are the mirror image
      </div>
    </div>
  )
}
