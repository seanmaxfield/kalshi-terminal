import React, { useEffect, useMemo, useState } from 'react'
import { api, cents, fmtMoney, num } from '../api.js'
import ReportTab from './ReportTab.jsx'
import EquityTab from './EquityTab.jsx'

const fmtCt = (v) => {
  const n = num(v)
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2)
}
const fmtTime = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
const dollars = (v) => (v === null || v === undefined || v === '' ? '—' : `$${num(v).toFixed(2)}`)

function useEndpoint(path, deps, extract) {
  const [state, setState] = useState({ loading: true, data: null, err: null })
  const load = () => {
    setState((s) => ({ ...s, loading: true, err: null }))
    api(path)
      .then((d) => setState({ loading: false, data: extract(d), err: null }))
      .catch((e) => setState({ loading: false, data: null, err: e.message }))
  }
  useEffect(load, deps)
  return [state, load]
}

function SummaryTab({ marketIndex }) {
  const [bal] = useEndpoint('/portfolio/balance', [], (d) => d)
  const [pos] = useEndpoint('/portfolio/positions?limit=200', [], (d) => d.market_positions || [])
  const [ord] = useEndpoint('/portfolio/orders?status=resting&limit=200', [], (d) => d.orders || [])
  const [set] = useEndpoint('/portfolio/settlements?limit=100', [], (d) => d.settlements || [])

  const open = (pos.data || []).filter((p) => p.position !== 0 || num(p.position_fp) !== 0)
  // Payout = netted yes/no pairs (returned as cash at $1/pair) + settlement revenue.
  const settledPnl = (set.data || []).reduce((s, x) => {
    const nettedCredit = Math.min(num(x.yes_count_fp), num(x.no_count_fp))
    const payout = nettedCredit + num(x.revenue) / 100
    const cost = num(x.yes_total_cost_dollars) + num(x.no_total_cost_dollars)
    return s + payout - cost - num(x.fee_cost)
  }, 0)
  const feesPaid = (set.data || []).reduce((s, x) => s + num(x.fee_cost), 0)

  return (
    <div className="pf-summary">
      <div className="pf-stat"><span>CASH</span><b>{bal.data ? fmtMoney(bal.data.balance) : '…'}</b></div>
      <div className="pf-stat"><span>POSITION VALUE</span><b>{bal.data ? fmtMoney(bal.data.portfolio_value ?? 0) : '…'}</b></div>
      <div className="pf-stat"><span>OPEN POSITIONS</span><b>{pos.loading ? '…' : open.length}</b></div>
      <div className="pf-stat"><span>RESTING ORDERS</span><b>{ord.loading ? '…' : (ord.data || []).length}</b></div>
      <div className="pf-stat">
        <span>SETTLED P&L (LAST {set.data?.length ?? '…'})</span>
        <b className={settledPnl > 0 ? 'up' : settledPnl < 0 ? 'down' : ''}>{set.loading ? '…' : dollars(settledPnl)}</b>
      </div>
      <div className="pf-stat"><span>FEES PAID (SETTLED)</span><b>{set.loading ? '…' : dollars(feesPaid)}</b></div>
    </div>
  )
}

// Inline limit-sell ticket for one held position, with exit analysis.
function ExitTicket({ row, onPlaced, onClose }) {
  const heldSide = row.posCt > 0 ? 'yes' : 'no'
  const held = Math.abs(row.posCt)
  const m = row.info?.market
  const sideBid = m
    ? heldSide === 'yes'
      ? cents(m.yes_bid_dollars ?? m.yes_bid)
      : cents(m.no_bid_dollars ?? m.no_bid) ?? (cents(m.yes_ask_dollars ?? m.yes_ask) !== null ? 100 - cents(m.yes_ask_dollars ?? m.yes_ask) : null)
    : null
  const sideAsk = m
    ? heldSide === 'yes'
      ? cents(m.yes_ask_dollars ?? m.yes_ask)
      : cents(m.no_ask_dollars ?? m.no_ask) ?? (cents(m.yes_bid_dollars ?? m.yes_bid) !== null ? 100 - cents(m.yes_bid_dollars ?? m.yes_bid) : null)
    : null
  const sideMid = sideBid !== null && sideAsk !== null ? Math.round((sideBid + sideAsk) / 2) : sideBid ?? sideAsk
  const basis = held > 0 ? row.exposure / held : 0 // cents per contract

  const [count, setCount] = useState(held)
  const [price, setPrice] = useState(() => Math.min(99, Math.max(1, sideBid ?? sideMid ?? 50)))
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)

  const clamp = (v) => Math.min(99, Math.max(1, Math.round(v)))
  const quicks = [
    ['BID', sideBid],
    ['MID', sideMid],
    ['ASK', sideAsk],
    ['B/E', basis > 0 ? Math.ceil(basis) : null],
    ['+5', sideBid !== null ? sideBid + 5 : null],
    ['+10', sideBid !== null ? sideBid + 10 : null],
  ]

  const n = Math.max(0, Number(count) || 0)
  const px = Number(price)
  const crossing = sideBid !== null && px <= sideBid
  const proceeds = n * px // cents
  const p = px / 100
  const fee = crossing ? Math.ceil(7 * n * p * (1 - p)) : 0 // taker only when crossing
  const net = proceeds - fee
  const costOfSold = basis * n
  const pnl = net - costOfSold
  const heldWin = 100 * n - costOfSold
  const heldLose = -costOfSold

  const submit = async () => {
    setBusy(true)
    setStatus(null)
    try {
      // sell held side in V2 single-book terms: sell yes → ask @ p; sell no → bid @ 100−p
      const isBid = heldSide === 'no'
      const yesCents = heldSide === 'yes' ? px : 100 - px
      const res = await api('/portfolio/events/orders', {
        method: 'POST',
        body: {
          ticker: row.ticker,
          client_order_id: crypto.randomUUID(),
          side: isBid ? 'bid' : 'ask',
          count: n.toFixed(2),
          price: (yesCents / 100).toFixed(4),
          time_in_force: 'good_till_canceled',
          self_trade_prevention_type: 'taker_at_cross',
          reduce_only: true,
        },
      })
      const filled = parseFloat(res.fill_count ?? '0')
      const remaining = parseFloat(res.remaining_count ?? '0')
      setStatus({
        kind: 'ok',
        msg: `${filled > 0 ? `FILLED ${filled}` : ''}${filled > 0 && remaining > 0 ? ' · ' : ''}${remaining > 0 ? `RESTING ${remaining}` : ''}${filled === 0 && remaining === 0 ? 'NO FILL (CANCELED)' : ''} · ID ${res.order_id?.slice(0, 8) || '?'}`,
      })
      onPlaced?.()
    } catch (e) {
      setStatus({ kind: 'err', msg: e.message })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="exit-ticket">
      <div className="exit-head">
        <span className="panel-title" style={{ border: 'none', padding: 0 }}>
          SELL TO CLOSE · {row.info?.event?.title ?? row.ticker}
        </span>
        <button className="close-btn" onClick={onClose}>✕</button>
      </div>
      <div className="exit-sub dim">
        {row.info?.market?.yes_sub_title || row.ticker} — holding{' '}
        <b className={heldSide === 'yes' ? 'yes' : 'no'}>{held} {heldSide.toUpperCase()}</b> · cost basis{' '}
        <b>{basis > 0 ? `${basis.toFixed(1)}¢` : '—'}</b>/contract · book {heldSide.toUpperCase()}{' '}
        {sideBid ?? '—'}/{sideAsk ?? '—'}¢
      </div>
      <div className="exit-grid">
        <label className="field">
          <span>CONTRACTS</span>
          <input type="number" min="0.01" step="0.01" max={held} value={count} onChange={(e) => setCount(e.target.value)} />
        </label>
        <label className="field">
          <span>LIMIT (¢)</span>
          <input type="number" min="1" max="99" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <div className="exit-quicks">
          {quicks.map(([label, v]) => (
            <button key={label} disabled={v === null} onClick={() => setPrice(clamp(v))} title={v === null ? 'n/a' : `${clamp(v)}¢`}>
              {label}
            </button>
          ))}
        </div>

        <div className="exit-analysis">
          <div className="kelly-line">
            PROCEEDS <b>{fmtMoney(proceeds)}</b> · FEE <b>{crossing ? fmtMoney(fee) : '$0.00 (maker)'}</b> · NET <b>{fmtMoney(net)}</b>
          </div>
          <div className="kelly-line">
            P&L VS BASIS{' '}
            <b className={pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}>
              {fmtMoney(pnl)}{costOfSold > 0 ? ` (${((pnl / costOfSold) * 100).toFixed(1)}%)` : ''}
            </b>
          </div>
          <div className="kelly-line">
            VS HOLDING TO SETTLEMENT: WIN <b className="up">{fmtMoney(heldWin)}</b> · LOSE <b className="down">{fmtMoney(heldLose)}</b>
          </div>
          <div className="dim small">
            {crossing
              ? `limit ≤ bid — crosses the book and fills immediately at ${sideBid}¢ or better (taker fee applies)`
              : sideAsk !== null && px >= sideAsk
                ? 'limit at/above the ask — rests until the market trades up to it'
                : 'inside the spread — rests at top of book, fills on the next taker'}
          </div>
        </div>

        {!confirming ? (
          <button className="submit no" disabled={busy || n <= 0} onClick={() => setConfirming(true)}>
            SELL {n} {heldSide.toUpperCase()} @ {px}¢
          </button>
        ) : (
          <div className="confirm-box">
            <div className="confirm-title">CONFIRM: SELL {n} {heldSide.toUpperCase()} @ {px}¢ LIMIT</div>
            <div className="confirm-line"><span>{crossing ? 'PROCEEDS (IMMEDIATE)' : 'PROCEEDS IF FILLED'}</span><b className="confirm-amount">{fmtMoney(proceeds)}</b></div>
            <div className="confirm-line"><span>EST. FEE</span><b>{crossing ? fmtMoney(fee) : '$0.00'}</b></div>
            <div className="confirm-line total"><span>NET CREDIT</span><b className="confirm-amount">{fmtMoney(net)}</b></div>
            <div className="confirm-row">
              <button className="submit no" disabled={busy} onClick={submit}>{busy ? 'SENDING…' : `CONFIRM ${fmtMoney(net)}`}</button>
              <button className="submit cancel" disabled={busy} onClick={() => setConfirming(false)}>ABORT</button>
            </div>
          </div>
        )}
        {status && <div className={status.kind === 'ok' ? 'ok-text' : 'err-text'}>{status.msg}</div>}
      </div>
    </div>
  )
}

function PositionsTab({ marketIndex, onInspect }) {
  const [pos, reload] = useEndpoint('/portfolio/positions?limit=200', [], (d) => d.market_positions || [])
  const [picked, setPicked] = useState(() => new Set())
  const [selling, setSelling] = useState(null) // ticker being exited
  if (pos.err) return <div className="err-text" style={{ padding: 14 }}>{pos.err}</div>
  const rows = (pos.data || []).map((p) => {
    const posCt = p.position ?? num(p.position_fp)
    const info = marketIndex.get(p.ticker)
    const mid = info
      ? (() => {
          const b = cents(info.market.yes_bid_dollars ?? info.market.yes_bid)
          const a = cents(info.market.yes_ask_dollars ?? info.market.yes_ask)
          return b !== null && a !== null ? (b + a) / 2 : cents(info.market.last_price_dollars ?? info.market.last_price)
        })()
      : null
    // exposure = cost basis of the open position (cents); value = what it's worth at mid
    const exposure = num(p.market_exposure ?? p.market_exposure_dollars * 100)
    const value = mid !== null ? Math.abs(posCt) * (posCt > 0 ? mid : 100 - mid) : null
    return { ...p, posCt, info, mid, exposure, value, unreal: value !== null ? value - exposure : null }
  })

  // Parlay-style what-if over the checked positions.
  const selectable = rows.filter((p) => p.posCt !== 0)
  const selected = selectable.filter((p) => picked.has(p.ticker))
  const allPicked = selectable.length > 0 && selected.length === selectable.length
  const toggle = (ticker) =>
    setPicked((prev) => {
      const next = new Set(prev)
      next.has(ticker) ? next.delete(ticker) : next.add(ticker)
      return next
    })
  const risked = selected.reduce((s, p) => s + p.exposure, 0)
  const ifAllHit = selected.reduce((s, p) => s + Math.abs(p.posCt) * 100, 0)
  const totalReturn = ifAllHit - risked
  const sellingRow = selling ? rows.find((r) => r.ticker === selling) : null

  return (
    <>
      {sellingRow && (
        <ExitTicket
          key={sellingRow.ticker}
          row={sellingRow}
          onPlaced={reload}
          onClose={() => setSelling(null)}
        />
      )}
      <div className="pf-summary whatif-bar">
        <div className="pf-stat">
          <span>SELECTED</span>
          <b>{selected.length} / {selectable.length}</b>
        </div>
        <div className="pf-stat">
          <span>AMOUNT RISKED</span>
          <b>{selected.length ? fmtMoney(risked) : '—'}</b>
        </div>
        <div className="pf-stat">
          <span>IF EVERYTHING HITS</span>
          <b className="up">{selected.length ? fmtMoney(ifAllHit) : '—'}</b>
        </div>
        <div className="pf-stat">
          <span>TOTAL RETURN</span>
          <b className={totalReturn > 0 ? 'up' : totalReturn < 0 ? 'down' : ''}>
            {selected.length
              ? `${fmtMoney(totalReturn)}${risked > 0 ? ` (${((totalReturn / risked) * 100).toFixed(1)}%)` : ''}`
              : 'select positions below'}
          </b>
        </div>
      </div>
      <table className="mini-table pf-table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                checked={allPicked}
                onChange={() =>
                  setPicked(allPicked ? new Set() : new Set(selectable.map((p) => p.ticker)))
                }
                title="select all / none"
              />
            </th>
            <th>MARKET</th><th>POS</th><th>COST</th><th>MID</th><th>VALUE</th><th>UNREAL</th><th>REALIZED</th><th>FEES</th><th>REST</th><th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.ticker} className="pf-row" onClick={() => onInspect(p.ticker)} title={`${p.info?.event?.title ?? ''} — click for fills`}>
              <td onClick={(e) => e.stopPropagation()}>
                {p.posCt !== 0 && (
                  <input
                    type="checkbox"
                    checked={picked.has(p.ticker)}
                    onChange={() => toggle(p.ticker)}
                  />
                )}
              </td>
              <td className="pf-name">
              <div>{p.info?.event?.title ?? p.ticker}</div>
              <div className="dim small">{p.info?.market?.yes_sub_title || p.ticker}</div>
            </td>
            <td className={p.posCt > 0 ? 'yes' : p.posCt < 0 ? 'no' : 'dim'}>
              {p.posCt > 0 ? `${fmtCt(p.posCt)} YES` : p.posCt < 0 ? `${fmtCt(-p.posCt)} NO` : '0'}
            </td>
            <td>{fmtMoney(p.exposure)}</td>
            <td>{p.mid === null ? '—' : `${Math.round(p.mid)}¢`}</td>
            <td>{p.value === null ? '—' : fmtMoney(p.value)}</td>
            <td className={p.unreal > 0 ? 'up' : p.unreal < 0 ? 'down' : ''}>{p.unreal === null ? '—' : fmtMoney(p.unreal)}</td>
            <td className={num(p.realized_pnl) > 0 ? 'up' : num(p.realized_pnl) < 0 ? 'down' : ''}>{fmtMoney(num(p.realized_pnl))}</td>
            <td className="dim">{fmtMoney(num(p.fees_paid))}</td>
            <td className="dim">{p.resting_orders_count ?? 0}</td>
            <td onClick={(e) => e.stopPropagation()}>
              {p.posCt !== 0 && (
                <button
                  className={`sell-btn ${selling === p.ticker ? 'on' : ''}`}
                  onClick={() => setSelling(selling === p.ticker ? null : p.ticker)}
                >
                  SELL
                </button>
              )}
            </td>
          </tr>
        ))}
          {rows.length === 0 && !pos.loading && <tr><td colSpan="11" className="dim">no positions</td></tr>}
        </tbody>
      </table>
    </>
  )
}

function OrdersTab() {
  const [status, setStatus] = useState('resting')
  const q = status === 'all' ? '' : `status=${status}&`
  const [ord, reload] = useEndpoint(`/portfolio/orders?${q}limit=200`, [status], (d) => d.orders || [])
  const [err, setErr] = useState(null)

  const cancel = async (id) => {
    try {
      await api(`/portfolio/events/orders/${id}`, { method: 'DELETE' })
      reload()
    } catch (e) {
      setErr(e.message)
    }
  }

  return (
    <>
      <div className="pf-filters">
        {['resting', 'executed', 'canceled', 'all'].map((s) => (
          <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{s.toUpperCase()}</button>
        ))}
      </div>
      {(err || ord.err) && <div className="err-text" style={{ padding: '4px 14px' }}>{err || ord.err}</div>}
      <div className="scroll-x">
        <table className="mini-table pf-table">
          <thead>
            <tr><th>TIME</th><th>TICKER</th><th>ORDER</th><th>TYPE</th><th>FILLED</th><th>REMAIN</th><th>FILL COST</th><th>FEES</th><th>STATUS</th><th></th></tr>
          </thead>
          <tbody>
            {(ord.data || []).map((o) => {
              const px = cents(o.yes_price_dollars ?? o.no_price_dollars) ?? o.yes_price ?? o.no_price
              const fillCost = num(o.taker_fill_cost_dollars) + num(o.maker_fill_cost_dollars)
              const fees = num(o.taker_fees_dollars) + num(o.maker_fees_dollars)
              return (
                <tr key={o.order_id}>
                  <td className="dim">{fmtTime(o.created_time)}</td>
                  <td className="pf-name">{o.ticker}</td>
                  <td className={o.side === 'yes' ? 'yes' : 'no'}>
                    {o.action?.toUpperCase()} {o.side?.toUpperCase()} @ {px}¢
                  </td>
                  <td className="dim">{o.type}</td>
                  <td>{fmtCt(o.fill_count_fp ?? o.fill_count ?? 0)}/{fmtCt(o.initial_count_fp ?? o.initial_count ?? 0)}</td>
                  <td>{fmtCt(o.remaining_count_fp ?? o.remaining_count ?? 0)}</td>
                  <td>{dollars(fillCost)}</td>
                  <td className="dim">{dollars(fees)}</td>
                  <td className={o.status === 'resting' ? 'yes' : o.status === 'canceled' ? 'dim' : ''}>{o.status}</td>
                  <td>{o.status === 'resting' && <button className="link-btn" onClick={() => cancel(o.order_id)}>CXL</button>}</td>
                </tr>
              )
            })}
            {(ord.data || []).length === 0 && !ord.loading && <tr><td colSpan="10" className="dim">no {status} orders</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  )
}

function FillsTab({ tickerFilter, setTickerFilter }) {
  const q = tickerFilter ? `ticker=${encodeURIComponent(tickerFilter)}&` : ''
  const [fills] = useEndpoint(`/portfolio/fills?${q}limit=200`, [tickerFilter], (d) => d.fills || [])
  return (
    <>
      <div className="pf-filters">
        <input
          className="pf-search"
          placeholder="FILTER BY TICKER…"
          value={tickerFilter}
          onChange={(e) => setTickerFilter(e.target.value.trim())}
          spellCheck={false}
        />
        {tickerFilter && <button onClick={() => setTickerFilter('')}>CLEAR</button>}
      </div>
      {fills.err && <div className="err-text" style={{ padding: '4px 14px' }}>{fills.err}</div>}
      <div className="scroll-x">
        <table className="mini-table pf-table">
          <thead>
            <tr><th>TIME</th><th>TICKER</th><th>FILL</th><th>COUNT</th><th>COST</th><th>FEE</th><th>ROLE</th></tr>
          </thead>
          <tbody>
            {(fills.data || []).map((f) => {
              const px = cents(f.side === 'yes' ? f.yes_price_dollars : f.no_price_dollars) ?? (f.side === 'yes' ? f.yes_price : f.no_price)
              const ct = num(f.count_fp ?? f.count)
              return (
                <tr key={f.trade_id}>
                  <td className="dim">{fmtTime(f.created_time)}</td>
                  <td className="pf-name">{f.ticker}</td>
                  <td className={f.side === 'yes' ? 'yes' : 'no'}>
                    {f.action?.toUpperCase()} {f.side?.toUpperCase()} @ {px}¢
                  </td>
                  <td>{fmtCt(ct)}</td>
                  <td>{dollars((ct * px) / 100)}</td>
                  <td className="dim">{dollars(f.fee_cost)}</td>
                  <td className="dim">{f.is_taker ? 'taker' : 'maker'}</td>
                </tr>
              )
            })}
            {(fills.data || []).length === 0 && !fills.loading && <tr><td colSpan="7" className="dim">no fills</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  )
}

function SettlementsTab() {
  const [set] = useEndpoint('/portfolio/settlements?limit=200', [], (d) => d.settlements || [])
  return (
    <>
      {set.err && <div className="err-text" style={{ padding: '4px 14px' }}>{set.err}</div>}
      <div className="scroll-x">
        <table className="mini-table pf-table">
          <thead>
            <tr><th>SETTLED</th><th>TICKER</th><th>RESULT</th><th>YES CT/COST</th><th>NO CT/COST</th><th>PAYOUT</th><th>FEE</th><th>NET</th></tr>
          </thead>
          <tbody>
            {(set.data || []).map((x, i) => {
              // equal yes/no holdings are netted to cash at $1/pair before
              // settlement; `revenue` covers only the residual winning side
              const payout = Math.min(num(x.yes_count_fp), num(x.no_count_fp)) + num(x.revenue) / 100
              const cost = num(x.yes_total_cost_dollars) + num(x.no_total_cost_dollars)
              const net = payout - cost - num(x.fee_cost)
              return (
                <tr key={`${x.ticker}${x.settled_time}${i}`}>
                  <td className="dim">{fmtTime(x.settled_time)}</td>
                  <td className="pf-name">{x.ticker}</td>
                  <td className={x.market_result === 'yes' ? 'yes' : 'no'}>{x.market_result?.toUpperCase()}</td>
                  <td>{fmtCt(x.yes_count_fp)} / {dollars(x.yes_total_cost_dollars)}</td>
                  <td>{fmtCt(x.no_count_fp)} / {dollars(x.no_total_cost_dollars)}</td>
                  <td>{dollars(payout)}</td>
                  <td className="dim">{dollars(x.fee_cost)}</td>
                  <td className={net > 0 ? 'up' : net < 0 ? 'down' : ''}>{dollars(net)}</td>
                </tr>
              )
            })}
            {(set.data || []).length === 0 && !set.loading && <tr><td colSpan="8" className="dim">no settlements yet</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  )
}

export default function PortfolioModal({ marketIndex, onClose, initialTab }) {
  const [tab, setTab] = useState(initialTab || 'summary')
  useEffect(() => { if (initialTab) setTab(initialTab) }, [initialTab])
  const [tickerFilter, setTickerFilter] = useState('')
  const inspect = (ticker) => {
    setTickerFilter(ticker)
    setTab('fills')
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">PORTFOLIO</span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="tabs">
          <button className={tab === 'summary' ? 'on' : ''} onClick={() => setTab('summary')}>SUMMARY</button>
          <button className={tab === 'positions' ? 'on' : ''} onClick={() => setTab('positions')}>POSITIONS</button>
          <button className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}>ORDERS</button>
          <button className={tab === 'fills' ? 'on' : ''} onClick={() => setTab('fills')}>FILLS</button>
          <button className={tab === 'settlements' ? 'on' : ''} onClick={() => setTab('settlements')}>SETTLEMENTS</button>
          <button className={tab === 'equity' ? 'on' : ''} onClick={() => setTab('equity')}>EQUITY</button>
          <button className={tab === 'report' ? 'on' : ''} onClick={() => setTab('report')}>DAILY REPORT</button>
        </div>
        {tab === 'summary' && <SummaryTab marketIndex={marketIndex} />}
        {tab === 'positions' && <PositionsTab marketIndex={marketIndex} onInspect={inspect} />}
        {tab === 'orders' && <OrdersTab />}
        {tab === 'fills' && <FillsTab tickerFilter={tickerFilter} setTickerFilter={setTickerFilter} />}
        {tab === 'settlements' && <SettlementsTab />}
        {tab === 'equity' && <EquityTab />}
        {tab === 'report' && <ReportTab marketIndex={marketIndex} />}
        <div className="modal-foot dim">
          {tab === 'equity'
            ? 'curve = cash + cost basis of opens (MTM in the stats) · amber bars = deposits'
            : 'click a position for its fills · unreal = value at current mid − cost basis · net = payout − cost − fees'}
        </div>
      </div>
    </div>
  )
}
