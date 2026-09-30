import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, fmtMoney, num } from '../api.js'

// Page an endpoint until exhausted (newest-first lists; we keep everything).
async function fetchAll(path, listKey, maxPages = 20) {
  let cursor = ''
  const out = []
  for (let page = 0; page < maxPages; page++) {
    const q = cursor ? `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : path
    const d = await api(q)
    const items = d[listKey] || []
    out.push(...items)
    cursor = d.cursor || ''
    if (!cursor || items.length === 0) break
  }
  return out
}

function sidePrice(f) {
  const side = f.outcome_side || f.side
  return num(side === 'yes' ? f.yes_price_dollars : f.no_price_dollars)
}

// Reconstruct cash + book equity from deposits / fills / settlements.
// Fills always acquire the outcome side (pay price+fee). Complementary
// yes/no pairs net to $1/contract immediately. Settlements pay residual
// winners (revenue); settlement fee_cost is already reflected in fill fees.
function buildEquity(deposits, withdrawals, fills, settlements) {
  const events = []
  for (const d of deposits) {
    if (d.status !== 'applied') continue
    events.push({ t: d.finalized_ts || d.created_ts, k: 'dep', d })
  }
  for (const w of withdrawals) {
    if (w.status !== 'applied') continue
    events.push({ t: w.finalized_ts || w.created_ts, k: 'wd', w })
  }
  for (const f of fills) {
    events.push({ t: f.ts || Math.floor(new Date(f.created_time).getTime() / 1000), k: 'fill', f })
  }
  for (const s of settlements) {
    events.push({ t: Math.floor(new Date(s.settled_time).getTime() / 1000), k: 'set', s })
  }
  events.sort((a, b) => a.t - b.t || rank(a.k) - rank(b.k))

  let cash = 0
  const yes = new Map()
  const no = new Map()
  const cy = new Map()
  const cn = new Map()
  const get = (m, t) => m.get(t) || 0
  const set = (m, t, v) => (Math.abs(v) < 1e-9 ? m.delete(t) : m.set(t, v))
  const bookOf = () => {
    let b = 0
    for (const v of cy.values()) b += v
    for (const v of cn.values()) b += v
    return b
  }

  const depositMarks = []
  const points = [] // {x: ms, y: equity dollars, kind}
  const push = (t, kind) => {
    const book = bookOf()
    points.push({ x: t * 1000, y: cash + book, cash, book, kind })
  }

  for (const e of events) {
    if (e.k === 'dep') {
      const amt = e.d.amount_cents / 100
      const fee = e.d.fee_cents / 100
      cash += amt - fee
      depositMarks.push({ x: e.t * 1000, amount: amt, fee, type: e.d.type || '—' })
      push(e.t, 'dep')
    } else if (e.k === 'wd') {
      cash -= e.w.amount_cents / 100 + e.w.fee_cents / 100
      push(e.t, 'wd')
    } else if (e.k === 'fill') {
      const f = e.f
      const ticker = f.ticker
      const ct = num(f.count_fp ?? f.count)
      const fee = num(f.fee_cost)
      const side = f.outcome_side || f.side
      const px = sidePrice(f)
      if (side === 'yes') {
        set(yes, ticker, get(yes, ticker) + ct)
        set(cy, ticker, get(cy, ticker) + ct * px)
      } else {
        set(no, ticker, get(no, ticker) + ct)
        set(cn, ticker, get(cn, ticker) + ct * px)
      }
      cash -= ct * px + fee
      // Net complementary pairs → $1 cash each
      const paired = Math.min(get(yes, ticker), get(no, ticker))
      if (paired > 1e-12) {
        const y = get(yes, ticker)
        const n = get(no, ticker)
        const by = y ? get(cy, ticker) * (paired / y) : 0
        const bn = n ? get(cn, ticker) * (paired / n) : 0
        cash += paired
        set(yes, ticker, y - paired)
        set(no, ticker, n - paired)
        set(cy, ticker, get(cy, ticker) - by)
        set(cn, ticker, get(cn, ticker) - bn)
      }
      push(e.t, 'fill')
    } else if (e.k === 'set') {
      const s = e.s
      const ticker = s.ticker
      const paired = Math.min(get(yes, ticker), get(no, ticker))
      cash += paired + num(s.revenue) / 100
      yes.delete(ticker)
      no.delete(ticker)
      cy.delete(ticker)
      cn.delete(ticker)
      push(e.t, 'set')
    }
  }

  // Extend to "now" at the latest reconstructed equity (book value of opens).
  if (points.length) {
    points.push({ ...points[points.length - 1], x: Date.now(), kind: 'now' })
  }

  return { points, depositMarks, cash, book: bookOf() }
}

function rank(k) {
  return { dep: 0, wd: 1, fill: 2, set: 3 }[k] ?? 9
}

// Collapse to one point per calendar day (last equity that day) plus every deposit.
function downsample(points, depositMarks) {
  const byDay = new Map()
  for (const p of points) {
    if (p.kind === 'dep' || p.kind === 'now') continue
    const day = new Date(p.x).toDateString()
    byDay.set(day, p)
  }
  const out = [...byDay.values()]
  for (const p of points) {
    if (p.kind === 'dep' || p.kind === 'now') out.push(p)
  }
  out.sort((a, b) => a.x - b.x)
  // Ensure a starting point just before first deposit if needed
  if (depositMarks.length && (out.length === 0 || out[0].x > depositMarks[0].x)) {
    out.unshift({ x: depositMarks[0].x - 86400e3, y: 0, kind: 'start' })
  }
  return out
}

const W = 720
const H = 220
const PAD = { l: 52, r: 20, t: 16, b: 28 }

function niceTicks(min, max, n = 4) {
  if (!(max > min)) {
    min = Math.min(min, 0)
    max = Math.max(max, 1)
  }
  const span = max - min
  const step0 = Math.pow(10, Math.floor(Math.log10(span / n)))
  const err = span / n / step0
  const step = step0 * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1)
  const ticks = []
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(v)
  return ticks
}

function EquityChart({ points, deposits }) {
  const svgRef = useRef(null)
  const [hover, setHover] = useState(null)

  const { xMin, xMax, yMin, yMax, xTicks, yTicks } = useMemo(() => {
    const xs = [...points.map((p) => p.x), ...deposits.map((d) => d.x)]
    const ys = [...points.map((p) => p.y), ...deposits.map((d) => d.amount), 0]
    let xMin = Math.min(...xs)
    let xMax = Math.max(...xs)
    if (!(xMax > xMin)) {
      xMin -= 86400e3
      xMax += 86400e3
    }
    // pad x so deposit bars aren't clipped
    const padX = (xMax - xMin) * 0.04
    xMin -= padX
    xMax += padX
    let yMin = Math.min(...ys)
    let yMax = Math.max(...ys)
    const pad = (yMax - yMin || 1) * 0.1
    yMin = Math.min(0, yMin - pad * 0.2)
    yMax += pad
    // ~5 date ticks
    const xTicks = []
    const n = 5
    for (let i = 0; i < n; i++) xTicks.push(xMin + ((xMax - xMin) * i) / (n - 1))
    return { xMin, xMax, yMin, yMax, xTicks, yTicks: niceTicks(yMin, yMax, 4) }
  }, [points, deposits])

  const sx = (x) => PAD.l + ((x - xMin) / (xMax - xMin || 1)) * (W - PAD.l - PAD.r)
  const sy = (y) => H - PAD.b - ((y - yMin) / (yMax - yMin || 1)) * (H - PAD.t - PAD.b)

  const money = (v) =>
    v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  const dateFmt = (ms) =>
    new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })

  const onMove = (e) => {
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    const dataX = xMin + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (xMax - xMin)
    let best = points[0]
    for (const p of points) if (Math.abs(p.x - dataX) < Math.abs(best.x - dataX)) best = p
    // Prefer a deposit mark if closer
    let bestDep = null
    for (const d of deposits) {
      if (!bestDep || Math.abs(d.x - dataX) < Math.abs(bestDep.x - dataX)) bestDep = d
    }
    const nearDep = bestDep && Math.abs(sx(bestDep.x) - px) < 14
    setHover(nearDep ? { kind: 'dep', ...bestDep } : { kind: 'eq', ...best })
  }

  const barW = Math.max(8, Math.min(22, ((W - PAD.l - PAD.r) / Math.max(deposits.length * 6, 12))))

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', display: 'block' }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} stroke="var(--border)" strokeWidth="1" />
          <text x={PAD.l - 6} y={sy(t) + 3} textAnchor="end" fill="var(--dim)" fontSize="9">
            {money(t)}
          </text>
        </g>
      ))}
      {xTicks.map((t) => (
        <g key={`x${t}`}>
          <line x1={sx(t)} x2={sx(t)} y1={H - PAD.b} y2={H - PAD.b + 3} stroke="var(--dim)" strokeWidth="1" />
          <text x={sx(t)} y={H - PAD.b + 14} textAnchor="middle" fill="var(--dim)" fontSize="9">
            {dateFmt(t)}
          </text>
        </g>
      ))}

      {/* zero line */}
      <line x1={PAD.l} x2={W - PAD.r} y1={sy(0)} y2={sy(0)} stroke="var(--dim)" strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />

      {/* deposit bars */}
      {deposits.map((d) => (
        <g key={d.x + d.amount}>
          <rect
            x={sx(d.x) - barW / 2}
            y={sy(d.amount)}
            width={barW}
            height={Math.max(0, sy(0) - sy(d.amount))}
            fill="var(--amber)"
            opacity={hover?.kind === 'dep' && hover.x === d.x ? 0.95 : 0.45}
            rx="1.5"
          />
          <text
            x={sx(d.x)}
            y={sy(d.amount) - 4}
            textAnchor="middle"
            fill="var(--amber)"
            fontSize="9"
            letterSpacing="0.5"
          >
            +{money(d.amount)}
          </text>
        </g>
      ))}

      {/* equity line */}
      {points.length > 1 && (
        <path
          d={points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('')}
          fill="none"
          stroke="var(--yes)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      )}
      {points.length > 0 && (
        <circle
          cx={sx(points[points.length - 1].x)}
          cy={sy(points[points.length - 1].y)}
          r="3.5"
          fill="var(--yes)"
        />
      )}

      {hover && (
        <g pointerEvents="none">
          <line
            x1={sx(hover.x)}
            x2={sx(hover.x)}
            y1={PAD.t}
            y2={H - PAD.b}
            stroke="var(--dim)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
          <g transform={`translate(${sx(hover.x) > W / 2 ? sx(hover.x) - 148 : sx(hover.x) + 8},${PAD.t + 4})`}>
            <rect width="140" height={hover.kind === 'dep' ? 42 : 30} fill="#000" stroke="var(--border)" />
            <text x="6" y="12" fill="var(--dim)" fontSize="9">
              {new Date(hover.x).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </text>
            {hover.kind === 'dep' ? (
              <>
                <text x="6" y="26" fill="var(--amber)" fontSize="9">
                  DEPOSIT {money(hover.amount)}
                </text>
                <text x="6" y="38" fill="var(--dim)" fontSize="9">
                  {(hover.type || '').toUpperCase()}
                </text>
              </>
            ) : (
              <text x="6" y="26" fill="var(--text)" fontSize="9">
                EQUITY {money(hover.y)}
              </text>
            )}
          </g>
        </g>
      )}
    </svg>
  )
}

export default function EquityTab() {
  const [state, setState] = useState({ loading: true, err: null, data: null })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setState((s) => ({ ...s, loading: true, err: null }))
      try {
        const [bal, deposits, withdrawals, fills, settlements] = await Promise.all([
          api('/portfolio/balance'),
          fetchAll('/portfolio/deposits?limit=200', 'deposits'),
          fetchAll('/portfolio/withdrawals?limit=200', 'withdrawals'),
          fetchAll('/portfolio/fills?limit=200', 'fills'),
          fetchAll('/portfolio/settlements?limit=200', 'settlements'),
        ])
        if (cancelled) return
        const nowEquity = (num(bal.balance) + num(bal.portfolio_value ?? 0)) / 100
        const built = buildEquity(deposits, withdrawals, fills, settlements)
        const series = downsample(built.points, built.depositMarks)
        const netDeposits =
          deposits.filter((d) => d.status === 'applied').reduce((s, d) => s + d.amount_cents - d.fee_cents, 0) / 100 -
          withdrawals.filter((w) => w.status === 'applied').reduce((s, w) => s + w.amount_cents + w.fee_cents, 0) / 100
        setState({
          loading: false,
          err: null,
          data: {
            series,
            deposits: built.depositMarks,
            nowEquity,
            netDeposits,
            tradingPnl: nowEquity - netDeposits,
            nDeposits: built.depositMarks.length,
          },
        })
      } catch (e) {
        if (!cancelled) setState({ loading: false, err: e.message, data: null })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (state.err) return <div className="err-text" style={{ padding: 14 }}>{state.err}</div>
  if (state.loading || !state.data) return <div className="dim" style={{ padding: 14 }}>loading equity…</div>

  const d = state.data
  return (
    <div className="equity-tab">
      <div className="pf-summary">
        <div className="pf-stat">
          <span>EQUITY (MTM)</span>
          <b>{d.nowEquity.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</b>
        </div>
        <div className="pf-stat">
          <span>NET DEPOSITS</span>
          <b>{d.netDeposits.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</b>
        </div>
        <div className="pf-stat">
          <span>TRADING P&L</span>
          <b className={d.tradingPnl > 0 ? 'up' : d.tradingPnl < 0 ? 'down' : ''}>
            {d.tradingPnl.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
          </b>
        </div>
        <div className="pf-stat">
          <span>DEPOSITS</span>
          <b>{d.nDeposits}</b>
        </div>
      </div>

      <div className="chart-block">
        <div className="chart-title">
          ACCOUNT EQUITY
          <span className="dim" style={{ marginLeft: 10, letterSpacing: 0 }}>
            line = equity · bars = deposits
          </span>
        </div>
        {d.series.length === 0 ? (
          <div className="dim" style={{ padding: '20px 0' }}>no deposit or trade history yet</div>
        ) : (
          <EquityChart points={d.series} deposits={d.deposits} />
        )}
      </div>

      {d.deposits.length > 0 && (
        <div className="scroll-x">
          <table className="mini-table pf-table">
            <thead>
              <tr>
                <th>WHEN</th>
                <th>TYPE</th>
                <th>AMOUNT</th>
                <th>FEE</th>
              </tr>
            </thead>
            <tbody>
              {[...d.deposits].reverse().map((dep) => (
                <tr key={dep.x + dep.amount}>
                  <td className="dim">
                    {new Date(dep.x).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="dim">{(dep.type || '—').toUpperCase()}</td>
                  <td className="up">{fmtMoney(dep.amount * 100)}</td>
                  <td className="dim">{fmtMoney(dep.fee * 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
