import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

// Speed test / latency diagnostics. For each path we time the full round trip
// the browser actually experiences (browser → local proxy → source → back),
// read the proxy→source leg the server reports, and — for price feeds — the
// age/delay of the data itself. The point is sensitivity: the Kalshi API is
// the live, tradable path, while the price feeds are DELAYED reference data.

const PROBES = [
  { key: 'internet', label: 'INTERNET BASELINE', hint: 'raw connectivity floor (Google 204) — your link’s best case' },
  { key: 'kalshi', label: 'KALSHI API', hint: 'live order book & trade path — quotes here are executable' },
  { key: 'yahoo', label: 'PRICE FEED · YAHOO', hint: 'monitor + underlying prices (STK / SECT / WEI …)' },
  { key: 'tradingview', label: 'PRICE FEED · TRADINGVIEW', hint: 'exchange reference quote (commodity desk)' },
]

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null)
const stdev = (a) => {
  if (a.length < 2) return 0
  const m = avg(a)
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1))
}
const ms = (v) => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${Math.round(v)} ms`)
const freshness = (sec) => {
  if (sec === null || sec === undefined) return '—'
  if (sec < 60) return `${sec}s old`
  if (sec < 3600) return `${Math.round(sec / 60)}m old`
  return `${Math.round(sec / 3600)}h old`
}

// Rating from average round-trip (ms). Error → DOWN.
function rate(avgMs, ok) {
  if (!ok) return { label: 'DOWN', cls: 'down' }
  if (avgMs < 150) return { label: 'EXCELLENT', cls: 'up' }
  if (avgMs < 400) return { label: 'GOOD', cls: 'up' }
  if (avgMs < 900) return { label: 'FAIR', cls: 'amber-text' }
  return { label: 'SLOW', cls: 'down' }
}

// One target: 1 warm-up (discarded) + `samples` measured round trips.
async function probe(target, samples, onSample) {
  const totals = []
  const upstreams = []
  let meta = { ok: false }
  for (let i = -1; i < samples; i++) {
    const t0 = performance.now()
    try {
      const d = await api(`/_diag/ping?target=${target}`)
      const total = performance.now() - t0
      meta = { ok: d.ok, status: d.status, error: d.error, dataAgeSec: d.dataAgeSec, delayed: d.delayed }
      if (i >= 0) {
        totals.push(total)
        if (typeof d.upstreamMs === 'number') upstreams.push(d.upstreamMs)
      }
    } catch (e) {
      meta = { ok: false, error: e.message }
      if (i >= 0) totals.push(performance.now() - t0)
    }
    if (i >= 0) onSample(i + 1)
  }
  const avgTotal = avg(totals)
  const avgUp = avg(upstreams)
  return {
    ...meta,
    n: totals.length,
    avgTotal,
    best: totals.length ? Math.min(...totals) : null,
    jitter: stdev(totals),
    avgUpstream: avgUp,
    local: avgTotal !== null && avgUp !== null ? Math.max(0, avgTotal - avgUp) : null,
  }
}

export default function DiagScreen({ onClose }) {
  const [samples, setSamples] = useState(6)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState({}) // key -> result
  const [progress, setProgress] = useState({}) // key -> count
  const [ranAt, setRanAt] = useState(null)
  const live = useRef(true)

  const run = useCallback(async () => {
    setRunning(true)
    setResults({})
    setProgress(Object.fromEntries(PROBES.map((p) => [p.key, 0])))
    await Promise.all(
      PROBES.map(async (p) => {
        const r = await probe(p.key, samples, (c) => live.current && setProgress((x) => ({ ...x, [p.key]: c })))
        if (live.current) setResults((x) => ({ ...x, [p.key]: r }))
      })
    )
    if (live.current) {
      setRunning(false)
      setRanAt(new Date())
    }
  }, [samples])

  useEffect(() => {
    live.current = true
    run()
    return () => { live.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">SPD · CONNECTION &amp; FEED SPEED TEST</span>
          <span className="range-btns" style={{ marginRight: 12 }}>
            {[4, 6, 10].map((n) => (
              <button key={n} className={`table-toggle ${samples === n ? 'on' : ''}`} disabled={running} onClick={() => setSamples(n)}>
                {n}×
              </button>
            ))}
            <button className="table-toggle" disabled={running} onClick={run}>⟳ RUN</button>
          </span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-meta">
          <span>{running ? 'MEASURING…' : ranAt ? `LAST RUN ${ranAt.toLocaleTimeString()}` : 'READY'}</span>
          <span>{samples} SAMPLES / PATH</span>
          <span>FULL ROUND TRIP: BROWSER → PROXY → SOURCE</span>
        </div>

        <table className="mini-table">
          <thead>
            <tr>
              <th>DATA PATH</th><th>STATUS</th><th>RTT (avg)</th><th>BEST</th>
              <th>JITTER</th><th>SOURCE LEG</th><th>LOCAL</th><th>FRESHNESS</th>
            </tr>
          </thead>
          <tbody>
            {PROBES.map((p) => {
              const r = results[p.key]
              const prog = progress[p.key] || 0
              const r8 = r ? rate(r.avgTotal, r.ok) : null
              return (
                <tr key={p.key}>
                  <td className="pf-name">
                    {p.label}
                    <div className="dim small">{p.hint}</div>
                  </td>
                  <td className={r8 ? r8.cls : 'dim'}>
                    {r ? r8.label : running ? `${prog}/${samples}` : '…'}
                    {r && !r.ok && r.error ? <div className="dim small" title={r.error}>{String(r.error).slice(0, 28)}</div> : null}
                  </td>
                  <td>{r ? ms(r.avgTotal) : '—'}</td>
                  <td className="dim">{r ? ms(r.best) : '—'}</td>
                  <td className={r && r.jitter > (r.avgTotal || 0) * 0.5 ? 'amber-text' : 'dim'}>
                    {r ? `± ${ms(r.jitter)}` : '—'}
                  </td>
                  <td className="dim">{r ? ms(r.avgUpstream) : '—'}</td>
                  <td className="dim">{r ? ms(r.local) : '—'}</td>
                  <td className={r && r.delayed ? 'down' : r && r.dataAgeSec !== null && r.dataAgeSec > 120 ? 'amber-text' : 'dim'}>
                    {r
                      ? r.delayed
                        ? '~15m DELAYED'
                        : r.dataAgeSec !== null && r.dataAgeSec !== undefined
                          ? freshness(r.dataAgeSec)
                          : '—'
                      : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        <div className="panel-title" style={{ marginTop: 12 }}>READING THE SENSITIVITY</div>
        <div className="diag-notes dim small">
          <p><b>RTT</b> is the full round trip you actually feel. <b>SOURCE LEG</b> is the proxy→source time the server measured; <b>LOCAL</b> (RTT − source leg) is your browser↔proxy overhead. If a path’s RTT barely exceeds the <b>INTERNET BASELINE</b>, your connection — not the service — is the floor.</p>
          <p><b>KALSHI API</b> is the live, tradable path: this latency is how fast your quotes and orders refresh. Treat it as your execution sensitivity.</p>
          <p><b>PRICE FEEDS (Yahoo / TradingView)</b> are <span className="amber-text">reference data, not executable prices</span>. <b>FRESHNESS</b> shows the age of the quote itself — a <span className="down">~15m DELAYED</span> or minutes-old reading means the headline price can lag the real market, so don’t trade a Kalshi strike off a stale underlying.</p>
          <p><b>JITTER</b> (± std-dev) is consistency. High jitter — flagged amber when it exceeds half the average — means latency is spiky and quotes can lag unpredictably even when the average looks fine.</p>
        </div>
        <div className="modal-foot dim">keyless probes · no data leaves this machine except the timing requests · re-run anytime with ⟳</div>
      </div>
    </div>
  )
}
