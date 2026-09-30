import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { COMMODITIES } from '../lib/underlying.js'
import { buildMarkov } from '../lib/markov.js'

// horizon = the size of one "move" (one Markov step)
const HORIZONS = [
  { key: 'MINUTE', interval: '1m', windows: ['1W'] },
  { key: 'HOUR', interval: '60m', windows: ['1W', '30D', '60D', '1Y'] },
  { key: 'DAY', interval: '1d', windows: ['30D', '60D', '1Y'] },
  { key: 'WEEK', interval: '1wk', windows: ['60D', '1Y'] },
]
// training window → yahoo range to fetch + client-side slice in days
const WINDOWS = {
  '1W': { range: '5d', sliceDays: 7, note: '~5 trading days' },
  '30D': { range: '1mo', sliceDays: 30 },
  '60D': { range: '3mo', sliceDays: 60 },
  '1Y': { range: '1y', sliceDays: 366 },
}

const pct = (v, dp = 1) => `${(v * 100).toFixed(dp)}%`

export default function MarkovTool({ initialCommodity, onClose }) {
  const [commodity, setCommodity] = useState(initialCommodity || COMMODITIES[0])
  const [horizon, setHorizon] = useState(HORIZONS[2]) // DAY
  const [windowKey, setWindowKey] = useState('60D')
  const [state, setState] = useState({ loading: true, bars: [], err: null })

  // keep window valid for the chosen horizon
  useEffect(() => {
    if (!horizon.windows.includes(windowKey)) setWindowKey(horizon.windows[horizon.windows.length - 1])
  }, [horizon])

  useEffect(() => {
    if (!horizon.windows.includes(windowKey)) return
    let live = true
    setState({ loading: true, bars: [], err: null })
    const w = WINDOWS[windowKey]
    api(`/_underlying/chart?symbol=${encodeURIComponent(commodity.symbol)}&range=${w.range}&interval=${horizon.interval}`)
      .then((d) => {
        if (!live) return
        const cutoff = Date.now() / 1000 - w.sliceDays * 86400
        setState({ loading: false, bars: (d.bars || []).filter((b) => b.t >= cutoff), err: null })
      })
      .catch((e) => live && setState({ loading: false, bars: [], err: e.message }))
    return () => { live = false }
  }, [commodity.key, horizon.key, windowKey])

  const model = useMemo(() => (state.bars.length ? buildMarkov(state.bars) : null), [state.bars])
  const stepWord = horizon.key.toLowerCase()

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">MARKOV CHAIN · {commodity.label}</span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="desk-controls" style={{ paddingTop: 8 }}>
          {COMMODITIES.map((c) => (
            <button key={c.key} className={`table-toggle ${commodity.key === c.key ? 'on' : ''}`} onClick={() => setCommodity(c)}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="desk-controls">
          <span className="dim small">MOVE SIZE</span>
          {HORIZONS.map((h) => (
            <button key={h.key} className={`table-toggle ${horizon.key === h.key ? 'on' : ''}`} onClick={() => setHorizon(h)}>
              {h.key}
            </button>
          ))}
          <span className="dim small" style={{ marginLeft: 12 }}>TRAINED ON</span>
          {Object.keys(WINDOWS).map((k) => (
            <button
              key={k}
              className={`table-toggle ${windowKey === k ? 'on' : ''}`}
              disabled={!horizon.windows.includes(k)}
              onClick={() => setWindowKey(k)}
            >
              {k}
            </button>
          ))}
        </div>

        {state.loading && <div className="dim" style={{ padding: 16 }}>training on {commodity.label} {stepWord} bars…</div>}
        {state.err && <div className="err-text" style={{ padding: 16 }}>{state.err}</div>}
        {!state.loading && !state.err && !model && (
          <div className="dim" style={{ padding: 16 }}>not enough bars in this window to fit a chain (need ≥ 12 returns)</div>
        )}

        {model && (
          <>
            <div className="modal-meta">
              <span>{model.nRets} MOVES SAMPLED</span>
              <span>σ / {stepWord.toUpperCase()} <b>{pct(model.sigma, 2)}</b></span>
              <span>LAST <b>${model.lastClose >= 1000 ? model.lastClose.toLocaleString('en-US', { maximumFractionDigits: 0 }) : model.lastClose.toFixed(2)}</b></span>
              <span>
                CURRENT STATE{' '}
                <b className={model.current < model.stateStats.length / 2 - 0.5 ? 'no' : model.current > model.stateStats.length / 2 - 0.5 ? 'yes' : ''}>
                  {model.stateStats[model.current].name}
                </b>{' '}
                <span className="dim">(last move {pct(model.lastRet, 2)})</span>
              </span>
              {model.nRets < 60 && <span className="dim">sparse data → 3-state chain</span>}
            </div>

            <div className="chart-block">
              <div className="chart-title">
                NEXT {horizon.key} — MOVE PROBABILITIES FROM CURRENT STATE
                <span className="dim"> · sorted by likelihood · mean move of each state shown</span>
              </div>
              <div className="markov-probs">
                {model.stateStats
                  .map((s, i) => ({ ...s, p: model.matrix[model.current][i], i }))
                  .sort((a, b) => b.p - a.p)
                  .map((s) => (
                    <div key={s.key} className="markov-prob-row">
                      <span className="markov-state">{s.name}</span>
                      <div className="markov-bar-track">
                        <div
                          className={`markov-bar ${s.i < model.stateStats.length / 2 - 0.5 ? 'neg' : s.i > model.stateStats.length / 2 - 0.5 ? 'pos' : 'flat'}`}
                          style={{ width: `${Math.max(1, s.p * 100)}%` }}
                        />
                      </div>
                      <b className="markov-pct">{pct(s.p)}</b>
                      <span className="dim small">
                        {s.meanRet ? `${s.meanRet > 0 ? '+' : ''}${pct(s.meanRet, 2)} ≈ $${Math.abs(s.meanRet * model.lastClose).toFixed(2)}` : '—'}{' '}
                        · seen {s.count}×
                      </span>
                    </div>
                  ))}
              </div>
            </div>

            <div className="chart-block">
              <div className="chart-title">
                TRANSITION MATRIX <span className="dim">· P(row → column) per {stepWord} · current row highlighted</span>
              </div>
              <div className="scroll-x">
                <table className="corr-table markov-matrix">
                  <thead>
                    <tr><th>FROM \ TO</th>{model.stateStats.map((s) => <th key={s.key}>{s.name}</th>)}</tr>
                  </thead>
                  <tbody>
                    {model.matrix.map((row, i) => (
                      <tr key={i} className={i === model.current ? 'current-row' : ''}>
                        <th>{model.stateStats[i].name}{i === model.current ? ' ◀' : ''}</th>
                        {row.map((p, j) => (
                          <td
                            key={j}
                            style={{ background: `rgba(255, 157, 0, ${(p * 0.75).toFixed(3)})` }}
                            title={`${model.stateStats[i].name} → ${model.stateStats[j].name}: ${pct(p)} (${model.counts[i][j]} observed)`}
                          >
                            {Math.round(p * 100)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="chart-block">
              <div className="chart-title">
                OUTLOOK <span className="dim">· state distribution k {stepWord}s ahead · drift = Σ p×mean move, compounded</span>
              </div>
              <table className="mini-table">
                <thead>
                  <tr><th>+K</th><th>MOST LIKELY</th><th>P</th>{model.stateStats.map((s) => <th key={s.key} className="dim">{s.key}</th>)}<th>CUM DRIFT</th></tr>
                </thead>
                <tbody>
                  {(() => {
                    let cum = 1
                    return model.steps.map((dist, k) => {
                      const top = dist.indexOf(Math.max(...dist))
                      const drift = dist.reduce((s, p, i) => s + p * model.stateStats[i].meanRet, 0)
                      cum *= 1 + drift
                      return (
                        <tr key={k}>
                          <td>+{k + 1}</td>
                          <td>{model.stateStats[top].name}</td>
                          <td><b>{pct(dist[top])}</b></td>
                          {dist.map((p, i) => <td key={i} className="dim">{Math.round(p * 100)}</td>)}
                          <td className={cum - 1 > 0 ? 'up' : cum - 1 < 0 ? 'down' : ''}>
                            {pct(cum - 1, 2)} ≈ ${(model.lastClose * (cum - 1)).toFixed(2)}
                          </td>
                        </tr>
                      )
                    })
                  })()}
                </tbody>
              </table>
            </div>

            <div className="modal-foot dim">
              states bucket each {stepWord}'s return by σ ({model.stateStats.length === 5 ? 'flat ≤ 0.25σ · big > 1.25σ' : 'flat ≤ 0.25σ'}) ·
              transition probs are historical frequencies with 0.5 Laplace smoothing · a first-order chain only knows the
              last move — treat as a pattern lens, not a forecast
            </div>
          </>
        )}
      </div>
    </div>
  )
}
