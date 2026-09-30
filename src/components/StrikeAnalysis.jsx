import React, { useEffect, useMemo, useState } from 'react'
import { num } from '../api.js'
import { parseStrikes } from '../lib/quant.js'
import { symbolForEvent, fetchDailyBars, avgDailyRange, fetchIntradayBars, avgBarRange } from '../lib/underlying.js'
import LineChart from './LineChart.jsx'
import BarChart from './BarChart.jsx'
import PrecisionToggle, { makeStrikeFmt } from './PrecisionToggle.jsx'
import StrikeVolChart from './StrikeVolChart.jsx'

const ADR_MODES = [
  { key: '1D', label: 'TODAY', type: 'daily', n: 1 },
  { key: '5D', label: '5D AVG', type: 'daily', n: 5 },
  { key: '30D', label: '30D AVG', type: 'daily', n: 30 },
  { key: '1H', label: '1H AVG', type: 'intra', interval: '60m' },
  { key: '30M', label: '30M AVG', type: 'intra', interval: '30m' },
  { key: '5M', label: '5M AVG', type: 'intra', interval: '5m' },
]

const fmtK = (v) =>
  Math.abs(v) >= 1000
    ? Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v)
    : +(+v).toFixed(2)

export default function StrikeAnalysis({ event, onClose }) {
  const [showTable, setShowTable] = useState(false)
  const [dp, setDp] = useState(null) // strike decimals: null = auto
  const s = useMemo(() => parseStrikes(event), [event])
  const fmtStrike = makeStrikeFmt(dp, fmtK)

  // ADR ruler: pick a mode, then click the price chart to stamp the range there.
  const [dailyBars, setDailyBars] = useState(null) // null = loading/unavailable
  const [intraBars, setIntraBars] = useState({}) // interval -> bars (undefined = loading)
  const [adrMode, setAdrMode] = useState(null)
  const [adrAnchor, setAdrAnchor] = useState(null)
  const underlyingSymbol = useMemo(() => symbolForEvent(event), [event])
  useEffect(() => {
    let live = true
    setDailyBars(null)
    setIntraBars({})
    setAdrMode(null)
    setAdrAnchor(null)
    if (!underlyingSymbol) return
    fetchDailyBars(underlyingSymbol)
      .then((bars) => live && setDailyBars(bars))
      .catch(() => live && setDailyBars([]))
    for (const m of ADR_MODES.filter((m) => m.type === 'intra')) {
      fetchIntradayBars(underlyingSymbol, m.interval)
        .then((bars) => live && setIntraBars((prev) => ({ ...prev, [m.interval]: bars })))
        .catch(() => live && setIntraBars((prev) => ({ ...prev, [m.interval]: [] })))
    }
    return () => { live = false }
  }, [event, underlyingSymbol])

  const adrValueFor = (m) =>
    m.type === 'daily'
      ? dailyBars?.length
        ? avgDailyRange(dailyBars, m.n)
        : null
      : avgBarRange(intraBars[m.interval])

  const adrValue = useMemo(() => {
    if (!adrMode) return null
    return adrValueFor(ADR_MODES.find((m) => m.key === adrMode))
  }, [adrMode, dailyBars, intraBars])

  const fmtAdr = (v) =>
    v >= 1000
      ? Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v)
      : +v.toFixed(2)

  const rangeMarker =
    adrValue !== null && adrAnchor !== null
      ? {
          x1: adrAnchor - adrValue / 2,
          x2: adrAnchor + adrValue / 2,
          label: `${ADR_MODES.find((m) => m.key === adrMode).label} RANGE ${fmtAdr(adrValue)} @ ${fmtAdr(adrAnchor)}`,
        }
      : null

  if (!s) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head">
            <span>STRIKE ANALYSIS</span>
            <button className="close-btn" onClick={onClose}>✕</button>
          </div>
          <div className="dim" style={{ padding: 16 }}>
            Not enough priced strike markets in this event to build a curve.
          </div>
        </div>
      </div>
    )
  }

  const priceSeries = [
    { name: 'YES', color: 'var(--yes)', points: s.priceCurve.map((p) => ({ x: p.k, y: p.yes })) },
    { name: 'NO', color: 'var(--no)', dashed: true, points: s.priceCurve.map((p) => ({ x: p.k, y: p.no })) },
  ]

  // Merge consecutive strikes with positive Kelly edge into shaded bands,
  // extending each band half a gap beyond its end strikes. Strikes where BOTH
  // sides show edge (crossed asks — an arb-ish window) shade blue instead.
  const edgeBands = (test, fill) => {
    const pts = s.priceCurve
    const bands = []
    let start = null
    const gap = (i) => {
      const prev = i > 0 ? pts[i].k - pts[i - 1].k : null
      const next = i < pts.length - 1 ? pts[i + 1].k - pts[i].k : null
      return Math.min(prev ?? next ?? 0, next ?? prev ?? 0) / 2
    }
    for (let i = 0; i < pts.length; i++) {
      const on = test(pts[i])
      if (on && start === null) start = i
      if ((!on || i === pts.length - 1) && start !== null) {
        const end = on ? i : i - 1
        bands.push({ x1: pts[start].k - gap(start), x2: pts[end].k + gap(end), fill })
        start = null
      }
    }
    return bands
  }
  const yesOn = (p) => p.yesEdge !== null && p.yesEdge > 0
  const noOn = (p) => p.noEdge !== null && p.noEdge > 0
  const kellyBands = [
    ...edgeBands((p) => yesOn(p) && !noOn(p), 'rgba(33, 206, 99, 0.10)'),
    ...edgeBands((p) => noOn(p) && !yesOn(p), 'rgba(155, 30, 30, 0.18)'),
    ...edgeBands((p) => yesOn(p) && noOn(p), 'rgba(80, 140, 255, 0.18)'),
  ]
  const toPts = (curve) =>
    curve.map((p) => ({ x: p.k, y: s.model === 'lognormal' ? p.sigma * 100 : p.sigma }))
  const ivSeries = []
  if (s.ivYes.length >= 2)
    ivSeries.push({ name: 'YES IV', color: 'var(--yes)', points: toPts(s.ivYes) })
  if (s.ivNo.length >= 2)
    ivSeries.push({ name: 'NO IV', color: 'var(--no)', dashed: true, points: toPts(s.ivNo) })
  if (ivSeries.length === 0 && s.iv.length >= 2)
    ivSeries.push({ name: 'MID IV', color: 'var(--amber)', points: toPts(s.iv) })

  const volPoints = s.priceCurve.map((p) => ({
    x: p.k,
    y: num(p.market.volume_fp ?? p.market.volume),
    label: `24H ${Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
      .format(num(p.market.volume_24h_fp ?? p.market.volume_24h))} · OI ${Intl.NumberFormat('en-US', {
      notation: 'compact', maximumFractionDigits: 1 }).format(num(p.market.open_interest_fp ?? p.market.open_interest))}`,
  }))
  const hasVolume = volPoints.some((p) => p.y > 0)

  const days = s.T !== null ? (s.T * 365.25).toFixed(1) : '—'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{event.title}</span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-meta">
          <span>{s.strikeCount} STRIKES</span>
          <span>MODEL <b>{s.model.toUpperCase()}</b></span>
          <span>FWD <b>{s.forward !== null ? fmtStrike(s.forward) : 'n/a'}</b></span>
          <PrecisionToggle dp={dp} setDp={setDp} />
          <span>T <b>{days}d</b></span>
          {s.bucketed && (
            <span>Σ MASS <b className={Math.abs(s.totalMass - 1) > 0.12 ? 'no' : ''}>{(s.totalMass * 100).toFixed(0)}%</b></span>
          )}
          <button className={`table-toggle ${showTable ? 'on' : ''}`} onClick={() => setShowTable((v) => !v)}>
            {showTable ? 'CHARTS' : 'TABLE'}
          </button>
        </div>

        {!showTable ? (
          <>
            <div className="chart-block">
              <div className="chart-title">
                {s.bucketed ? 'PRICE (PROBABILITY MASS) VS STRIKE' : 'PRICE / IMPLIED PROBABILITY VS STRIKE'}
                <span className="dim">
                  {' '}· mid, ¢ per $1 payout
                  {kellyBands.length > 0 && ' · shaded: +KELLY at ask (green YES / red NO / blue BOTH = crossed asks) vs fitted-vol model'}
                </span>
              </div>
              <div className="adr-row">
                <span className="dim small">ADR RULER</span>
                {underlyingSymbol === null ? (
                  <span className="dim small">no underlying mapping for this event</span>
                ) : dailyBars === null ? (
                  <span className="dim small">loading daily ranges…</span>
                ) : dailyBars.length === 0 ? (
                  <span className="dim small">underlying data unavailable</span>
                ) : (
                  <>
                    {ADR_MODES.map((m) => {
                      const v = adrValueFor(m)
                      const loading = m.type === 'intra' && intraBars[m.interval] === undefined
                      return (
                        <button
                          key={m.key}
                          className={`table-toggle ${adrMode === m.key ? 'on' : ''}`}
                          disabled={!loading && v === null}
                          onClick={() => {
                            setAdrMode((cur) => (cur === m.key ? null : m.key))
                            setAdrAnchor(null)
                          }}
                        >
                          {m.label} {loading ? '…' : v === null ? 'n/a' : fmtAdr(v)}
                        </button>
                      )
                    })}
                    {adrMode && adrAnchor === null && (
                      <span className="amber-text small">click the chart to place the range</span>
                    )}
                    {rangeMarker && (
                      <button className="table-toggle" onClick={() => setAdrAnchor(null)}>CLEAR</button>
                    )}
                  </>
                )}
              </div>
              <LineChart
                series={priceSeries}
                bands={kellyBands}
                rangeMarker={rangeMarker}
                onPlotClick={adrMode && dailyBars?.length ? (x) => setAdrAnchor(x) : undefined}
                yDomain={[0, 100]}
                yFmt={(v) => `${Math.round(v)}¢`}
                xFmt={fmtStrike}
                xLabel="STRIKE / UNDERLYING"
              />
            </div>
            <div className="chart-block">
              <div className="chart-title">
                IMPLIED VOLATILITY SMILE
                <span className="dim">
                  {' '}· {s.model === 'lognormal' ? 'annualized %, lognormal' : 'annualized, underlying units (normal model)'}
                  {' '}· each side priced at its ask
                </span>
              </div>
              {ivSeries.length > 0 ? (
                <LineChart
                  series={ivSeries}
                  yFmt={(v) => (s.model === 'lognormal' ? `${Math.round(v)}%` : fmtK(v))}
                  xFmt={fmtStrike}
                  xLabel="STRIKE"
                />
              ) : (
                <div className="dim" style={{ padding: '14px 16px' }}>
                  Not enough mid-range quotes to invert a vol curve (need ≥2 strikes priced between 2¢ and 98¢
                  and a 50% crossing to estimate the forward).
                </div>
              )}
            </div>
            <div className="chart-block">
              <div className="chart-title">
                VOLUME BY STRIKE
                <span className="dim"> · total contracts traded · hover for 24h + open interest</span>
              </div>
              {hasVolume ? (
                <BarChart points={volPoints} xFmt={fmtStrike} xLabel="STRIKE" />
              ) : (
                <div className="dim" style={{ padding: '14px 16px' }}>no volume traded across these strikes yet</div>
              )}
            </div>
            <StrikeVolChart
              event={event}
              strikes={s.priceCurve.map((p) => ({
                k: p.k,
                ticker: p.market.ticker,
                volume: num(p.market.volume_fp ?? p.market.volume),
              }))}
              fmtStrike={fmtStrike}
            />
          </>
        ) : (
          <table className="mini-table" style={{ margin: '4px 0 12px' }}>
            <thead>
              <tr><th>STRIKE</th><th>YES MID</th><th>NO MID</th><th>P(S&gt;K)</th><th>IV MID</th><th>IV YES</th><th>IV NO</th><th>VOL</th></tr>
            </thead>
            <tbody>
              {s.priceCurve.map((p) => {
                const c = s.cdf.find((c) => c.k === p.k)
                const fmtIv = (iv) =>
                  iv ? (s.model === 'lognormal' ? `${(iv.sigma * 100).toFixed(1)}%` : fmtK(iv.sigma)) : '—'
                return (
                  <tr key={p.market.ticker}>
                    <td>{fmtStrike(p.k)}</td>
                    <td className="yes">{p.yes.toFixed(1)}¢</td>
                    <td className="no">{p.no.toFixed(1)}¢</td>
                    <td>{c ? `${(c.pAbove * 100).toFixed(1)}%` : '—'}</td>
                    <td>{fmtIv(s.iv.find((i) => i.k === p.k))}</td>
                    <td className="yes">{fmtIv(s.ivYes.find((i) => i.k === p.k))}</td>
                    <td className="no">{fmtIv(s.ivNo.find((i) => i.k === p.k))}</td>
                    <td className="vol">{Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(num(p.market.volume_fp ?? p.market.volume))}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <div className="modal-foot dim">
          mid prices treated as risk-neutral probabilities · forward = interpolated 50% crossing · binary IV from
          Φ⁻¹(price) · YES IV uses the yes ask, NO IV the no ask (= 100 − yes bid) — the gap is the spread in vol
          space · shading = Kelly f* = (q − ask)/(1 − ask) &gt; 0 where q comes from the fitted model (forward +
          median mid-IV) — a model view, not free money
        </div>
      </div>
    </div>
  )
}
