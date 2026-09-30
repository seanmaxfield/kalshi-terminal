import React, { useEffect, useMemo, useState } from 'react'
import { buildFieldDistribution, stressScenarios } from '../lib/quant.js'
import {
  fetchFieldHistories,
  buildReturnMatrix,
  correlationMatrix,
  fieldCorrelations,
} from '../lib/history.js'

const short = (name) => {
  const parts = String(name).trim().split(/\s+/)
  return parts.length > 1 ? `${parts[0][0]}.${parts[parts.length - 1]}`.slice(0, 10) : String(name).slice(0, 10)
}

// Diverging cell color: red (neg) ↔ neutral ↔ green (pos); value printed in
// every cell so identity never rides on color alone.
function corrColor(c) {
  if (c === null) return 'transparent'
  const a = Math.min(Math.abs(c), 1) * 0.55
  return c >= 0 ? `rgba(33, 206, 99, ${a})` : `rgba(255, 77, 77, ${a})`
}

function DistributionTab({ event }) {
  const dist = useMemo(() => buildFieldDistribution(event), [event])
  if (!dist) return <div className="dim" style={{ padding: 16 }}>no priced outcomes</div>
  const scenarios = stressScenarios(dist)

  return (
    <>
      <div className="modal-meta" style={{ borderTop: 'none' }}>
        <span>{dist.rows.length} OUTCOMES</span>
        <span>Σ IMPLIED <b>{(dist.sumImplied * 100).toFixed(1)}%</b></span>
        <span>VIG <b className={dist.vig > 0.08 ? 'no' : ''}>{(dist.vig * 100).toFixed(1)}%</b></span>
        <span>ENTROPY <b>{dist.entropy.toFixed(2)} bits</b></span>
      </div>
      <div className="scroll-x">
        <table className="mini-table field-table">
          <thead>
            <tr>
              <th>OUTCOME</th><th>BID/ASK</th><th>IMPLIED</th><th>FAIR</th><th>EV@ASK</th>
              {scenarios.map((s) => <th key={s.key} className="stress-col">{s.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {dist.rows.map((r) => (
              <tr key={r.ticker}>
                <td className="field-name">{r.name}</td>
                <td>{r.bid ?? '—'}/{r.ask ?? '—'}¢</td>
                <td>{(r.implied * 100).toFixed(1)}%</td>
                <td><b>{r.fairCents.toFixed(1)}¢</b></td>
                <td className={r.evAtAsk > 0 ? 'up' : r.evAtAsk < 0 ? 'down' : ''}>
                  {r.evAtAsk === null ? '—' : `${r.evAtAsk > 0 ? '+' : ''}${r.evAtAsk.toFixed(1)}¢`}
                </td>
                {scenarios.map((s) => {
                  const p = s.probs.get(r.ticker)
                  if (p === null || p === undefined)
                    return <td key={s.key} className="dim stress-col">OUT</td>
                  const delta = p * 100 - r.fairCents
                  return (
                    <td key={s.key} className="stress-col">
                      {(p * 100).toFixed(1)}¢{' '}
                      <span className={delta > 0.05 ? 'up' : delta < -0.05 ? 'down' : 'dim'}>
                        ({delta > 0 ? '+' : ''}{delta.toFixed(1)})
                      </span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="modal-foot dim">
        fair = mid / Σ mids (de-vigged) · EV@ASK = fair − ask per $1 contract · stresses renormalize the joint
        distribution: favorite withdraws, favorite prob ×1.2, sub-5% tails ×1.5
      </div>
    </>
  )
}

function useHistories(event) {
  const [state, setState] = useState({ status: 'loading', progress: [0, 0] })
  useEffect(() => {
    let live = true
    setState({ status: 'loading', progress: [0, 0] })
    fetchFieldHistories(event, 20, 10, (done, total) => {
      if (live) setState((s) => (s.status === 'loading' ? { ...s, progress: [done, total] } : s))
    })
      .then(({ players, capped, total }) => {
        if (!live) return
        if (players.length < 3) {
          setState({ status: 'error', msg: `only ${players.length} outcomes have enough price history` })
          return
        }
        const rm = buildReturnMatrix(players)
        setState({
          status: 'ready',
          players,
          capped,
          total,
          matrix: correlationMatrix(rm.returns),
          field: fieldCorrelations(players, rm),
          samples: rm.grid.length,
        })
      })
      .catch((e) => live && setState({ status: 'error', msg: e.message }))
    return () => { live = false }
  }, [event])
  return state
}

function MatrixTab({ h }) {
  if (h.status !== 'ready') return null
  const { players, matrix } = h
  return (
    <>
      <div className="scroll-x">
        <table className="corr-table">
          <thead>
            <tr>
              <th></th>
              {players.map((p) => <th key={p.ticker} title={p.name}>{short(p.name)}</th>)}
            </tr>
          </thead>
          <tbody>
            {players.map((p, i) => (
              <tr key={p.ticker}>
                <th title={p.name}>{short(p.name)}</th>
                {players.map((q, j) => {
                  const c = matrix[i][j]
                  return (
                    <td
                      key={q.ticker}
                      style={{ background: i === j ? 'var(--panel2)' : corrColor(c) }}
                      title={`${p.name} × ${q.name}: ${c === null ? 'n/a' : c.toFixed(3)}`}
                    >
                      {i === j ? '·' : c === null ? '—' : Math.round(c * 100)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="modal-foot dim">
        pearson correlation ×100 of hourly mid-price changes, last 10 days · green positive / red negative,
        value printed in each cell
      </div>
    </>
  )
}

function FieldCorrTab({ h }) {
  if (h.status !== 'ready') return null
  return (
    <>
      <table className="mini-table field-table">
        <thead>
          <tr><th>OUTCOME</th><th>CORR VS REST-OF-FIELD</th><th></th><th>β</th><th>N</th></tr>
        </thead>
        <tbody>
          {h.field.map(({ player, corr, beta, samples }) => (
            <tr key={player.ticker}>
              <td className="field-name">{player.name}</td>
              <td className={corr === null ? 'dim' : corr < 0 ? 'down' : 'up'}>
                {corr === null ? 'n/a' : corr.toFixed(3)}
              </td>
              <td className="corr-bar-cell">
                {corr !== null && (
                  <div className="corr-bar">
                    <div
                      className={`corr-bar-fill ${corr < 0 ? 'neg' : 'pos'}`}
                      style={{
                        width: `${Math.abs(corr) * 50}%`,
                        [corr < 0 ? 'right' : 'left']: '50%',
                      }}
                    />
                  </div>
                )}
              </td>
              <td>{beta === null ? '—' : beta.toFixed(2)}</td>
              <td className="dim">{samples}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="modal-foot dim">
        corr of each outcome's hourly price change vs the summed price change of everyone else · in a
        winner-take-all field this should lean negative — an outcome moving up drains the rest; positive
        values flag co-moving blocs (news lifting several names together)
      </div>
    </>
  )
}

export default function FieldAnalysis({ event, onClose }) {
  const [tab, setTab] = useState('dist')
  const h = useHistories(event)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{event.title} · FIELD ANALYSIS</span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="tabs">
          <button className={tab === 'dist' ? 'on' : ''} onClick={() => setTab('dist')}>JOINT DIST + STRESS</button>
          <button className={tab === 'matrix' ? 'on' : ''} onClick={() => setTab('matrix')}>CORR MATRIX</button>
          <button className={tab === 'field' ? 'on' : ''} onClick={() => setTab('field')}>VS FIELD</button>
        </div>

        {tab === 'dist' && <DistributionTab event={event} />}

        {tab !== 'dist' && h.status === 'loading' && (
          <div className="dim" style={{ padding: 16 }}>
            loading price history… {h.progress[0]}/{h.progress[1] || '?'}
          </div>
        )}
        {tab !== 'dist' && h.status === 'error' && (
          <div className="err-text" style={{ padding: 16 }}>{h.msg}</div>
        )}
        {tab !== 'dist' && h.status === 'ready' && h.capped && (
          <div className="modal-meta">
            <span className="dim">
              TOP {h.players.length} OF {h.total} OUTCOMES BY VOLUME — remainder omitted from history analysis
            </span>
          </div>
        )}
        {tab === 'matrix' && <MatrixTab h={h} />}
        {tab === 'field' && <FieldCorrTab h={h} />}
      </div>
    </div>
  )
}
