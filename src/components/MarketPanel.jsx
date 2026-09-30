import React, { useEffect, useMemo, useState } from 'react'
import { api, cents, fmtCents, fmtCompact, fmtMoney, num } from '../api.js'
import { kellyFraction } from '../lib/quant.js'

function levelsFrom(raw) {
  // Orderbook levels arrive as [price, qty] pairs; price may be cents (int)
  // or a dollar string depending on API vintage. Normalize to cents.
  if (!raw) return []
  return raw
    .map(([p, q]) => ({ price: typeof p === 'string' ? cents(p) : p, qty: num(q) }))
    .filter((l) => l.price !== null)
    .sort((a, b) => b.price - a.price)
}

export function Orderbook({ ticker }) {
  const [book, setBook] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let live = true
    setBook(null)
    setErr(null)
    const load = () =>
      api(`/markets/${ticker}/orderbook?depth=8`)
        .then((d) => live && setBook(d.orderbook_fp || d.orderbook || {}))
        .catch((e) => live && setErr(e.message))
    load()
    const t = setInterval(load, 5000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [ticker])

  if (err) return <div className="err-text">ORDERBOOK: {err}</div>
  if (!book) return <div className="dim">loading book…</div>

  const yes = levelsFrom(book.yes_dollars || book.yes)
  const no = levelsFrom(book.no_dollars || book.no)

  return (
    <div className="book">
      <div className="book-col">
        <div className="book-head yes">YES BIDS</div>
        {yes.length === 0 && <div className="dim book-row">—</div>}
        {yes.map((l) => (
          <div key={l.price} className="book-row">
            <span className="px yes">{l.price}¢</span>
            <span className="qty">{fmtCompact(l.qty)}</span>
          </div>
        ))}
      </div>
      <div className="book-col">
        <div className="book-head no">NO BIDS</div>
        {no.length === 0 && <div className="dim book-row">—</div>}
        {no.map((l) => (
          <div key={l.price} className="book-row">
            <span className="px no">{l.price}¢</span>
            <span className="qty">{fmtCompact(l.qty)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Kelly sizing for a binary contract: cost c per $1 payout, win prob q
// (your estimate) → optimal bankroll fraction f* = (q − c) / (1 − c).
// One P(YES) input sizes BOTH sides: the yes bet at the yes cost with prob q,
// and the no bet at the no cost with prob 1 − q.
function KellySide({ side, costCents, prob, balance, onApply }) {
  const title = `BUY ${side.toUpperCase()} @ ${costCents ?? '—'}¢`
  if (!costCents || costCents <= 0 || costCents >= 100) {
    return (
      <div className="kelly-side">
        <div className="kelly-side-head">{title}</div>
        <div className="dim small">needs a cost between 1¢ and 99¢</div>
      </div>
    )
  }
  const c = costCents / 100
  const f = kellyFraction(prob, c) ?? 0
  const edge = prob - c
  const bank = balance ?? 0
  const rows = [
    ['FULL', 1],
    ['HALF', 0.5],
    ['QTR', 0.25],
  ].map(([label, mult]) => {
    const dollars = Math.max(0, f * mult * bank) // cents
    return { label, dollars, contracts: Math.floor(dollars / costCents) }
  })

  return (
    <div className="kelly-side">
      <div className={`kelly-side-head ${side}`}>{title}</div>
      <div className="kelly-line">
        EDGE / EV PER CONTRACT{' '}
        <b className={edge > 0 ? 'up' : edge < 0 ? 'down' : ''}>{(edge * 100).toFixed(1)}¢</b>
      </div>
      {f <= 0 ? (
        <div className="kelly-noedge">NO EDGE — KELLY 0</div>
      ) : (
        <>
          <div className="kelly-line">
            KELLY <b className="up">{(f * 100).toFixed(1)}%</b> OF {fmtMoney(bank)}
          </div>
          <table className="mini-table kelly-table">
            <thead><tr><th>SIZE</th><th>STAKE</th><th>CTS</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td>{fmtMoney(Math.round(r.dollars))}</td>
                  <td>{r.contracts}</td>
                  <td>
                    {r.contracts > 0 && (
                      <button className="link-btn apply" onClick={() => onApply(side, r.contracts)}>
                        APPLY
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

function KellyPanel({ market, side, type, price, balance, onApply }) {
  const yesBid = cents(market.yes_bid_dollars ?? market.yes_bid)
  const yesAsk = cents(market.yes_ask_dollars ?? market.yes_ask)
  const yesMid = Math.min(99, Math.max(1,
    yesBid !== null && yesAsk !== null ? Math.round((yesBid + yesAsk) / 2) : yesAsk ?? yesBid ?? 50
  ))

  const [q, setQ] = useState(yesMid)
  useEffect(() => setQ(yesMid), [market.ticker])

  const qf = Math.min(99, Math.max(1, Number(q) || 0)) / 100

  // Cost per side: the ticket's limit price for the side being quoted there,
  // the ask otherwise.
  const noAsk = cents(market.no_ask_dollars ?? market.no_ask) ?? (yesBid !== null ? 100 - yesBid : null)
  const yesCost = type === 'limit' && side === 'yes' ? Number(price) : yesAsk
  const noCost = type === 'limit' && side === 'no' ? Number(price) : noAsk

  return (
    <div className="kelly">
      <div className="panel-title">KELLY SIZING</div>
      <div className="kelly-grid">
        <label className="field">
          <span>YOUR P(YES) %</span>
          <input type="number" min="1" max="99" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="kelly-line">
          MKT IMPLIED P(YES) <b>{yesMid}¢</b> · YOUR P(NO) <b>{(100 - (Number(q) || 0)).toFixed(0)}%</b>
        </div>
        {balance === null && (
          <div className="dim">balance unavailable — sizing needs the account connection</div>
        )}
        <div className="kelly-sides">
          <KellySide side="yes" costCents={yesCost} prob={qf} balance={balance} onApply={onApply} />
          <KellySide side="no" costCents={noCost} prob={1 - qf} balance={balance} onApply={onApply} />
        </div>
        <div className="dim small">
          full Kelly assumes your probability is exactly right — half or quarter is the
          conventional haircut for estimation error
        </div>
      </div>
    </div>
  )
}

// Data source & adjudication: the exact rules text and settlement sources
// Kalshi publishes for the selected market — shown verbatim.
export function RulesPanel({ market, event }) {
  const [openRules, setOpenRules] = useState(true)
  const sources = event.settlement_sources || []
  const expiry = market.expected_expiration_time || market.close_time
  return (
    <div className="rules-panel">
      <div className="rules-head" onClick={() => setOpenRules((v) => !v)}>
        <span className="caret">{openRules ? '▾' : '▸'}</span>
        <span className="panel-title" style={{ border: 'none', padding: 0 }}>DATA SOURCE & ADJUDICATION</span>
      </div>
      {openRules && (
        <div className="rules-body">
          {market.rules_primary ? (
            <div className="rules-text">{market.rules_primary}</div>
          ) : (
            <div className="dim small">no rules text published on this market object</div>
          )}
          {market.rules_secondary && <div className="rules-text dim">{market.rules_secondary}</div>}
          <div className="rules-facts">
            <span>
              SETTLES{' '}
              <b>{expiry ? new Date(expiry).toLocaleString() : '—'}</b>
            </span>
            {market.settlement_timer_seconds ? (
              <span>SETTLEMENT TIMER <b>{Math.round(market.settlement_timer_seconds / 60)} MIN</b></span>
            ) : null}
            <span>
              EARLY CLOSE{' '}
              <b>{market.can_close_early ? 'POSSIBLE' : 'NO'}</b>
            </span>
          </div>
          {market.early_close_condition && (
            <div className="dim small">early close: {market.early_close_condition}</div>
          )}
          <div className="rules-sources">
            <span className="dim small">OFFICIAL SETTLEMENT SOURCES:</span>
            {sources.length ? (
              sources.slice(0, 8).map((s) =>
                s.url ? (
                  <a key={s.name} className="adjud-chip" href={s.url} target="_blank" rel="noreferrer">{s.name}</a>
                ) : (
                  <span key={s.name} className="adjud-chip">{s.name}</span>
                )
              )
            ) : (
              <span className="dim small">none listed — adjudication follows the rules text above</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Public trade tape for one market: recent bets + average clip size per side.
export function TradesPanel({ ticker }) {
  const [state, setState] = useState({ loading: true, trades: [], err: null })

  useEffect(() => {
    let live = true
    setState({ loading: true, trades: [], err: null })
    const load = async () => {
      try {
        // pull up to 3 pages (~300 trades) of history
        let cursor = ''
        const all = []
        for (let i = 0; i < 3; i++) {
          const q = new URLSearchParams({ ticker, limit: '100' })
          if (cursor) q.set('cursor', cursor)
          const d = await api(`/markets/trades?${q}`)
          all.push(...(d.trades || []))
          cursor = d.cursor || ''
          if (!cursor) break
        }
        if (live) setState({ loading: false, trades: all, err: null })
      } catch (e) {
        if (live) setState({ loading: false, trades: [], err: e.message })
      }
    }
    load()
    const t = setInterval(load, 15000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [ticker])

  const stats = useMemo(() => {
    const side = (s) => state.trades.filter((t) => t.taker_side === s)
    const agg = (list) => {
      const sizes = list.map((t) => num(t.count_fp ?? t.count))
      const total = sizes.reduce((a, b) => a + b, 0)
      return { n: list.length, total, avg: list.length ? total / list.length : null }
    }
    return { yes: agg(side('yes')), no: agg(side('no')), blocks: state.trades.filter((t) => t.is_block_trade).length }
  }, [state.trades])

  if (state.err) return <div className="err-text" style={{ padding: '8px 12px' }}>TRADES: {state.err}</div>

  return (
    <div className="trades-panel">
      <div className="trades-stats">
        <div className="trades-stat">
          <span>YES TAKERS</span>
          <b className="yes">{stats.yes.n}</b>
          <span className="dim">AVG CLIP <b>{stats.yes.avg === null ? '—' : stats.yes.avg.toFixed(1)}</b></span>
        </div>
        <div className="trades-stat">
          <span>NO TAKERS</span>
          <b className="no">{stats.no.n}</b>
          <span className="dim">AVG CLIP <b>{stats.no.avg === null ? '—' : stats.no.avg.toFixed(1)}</b></span>
        </div>
        <div className="trades-stat">
          <span>FLOW</span>
          <b>{fmtCompact(stats.yes.total + stats.no.total)}</b>
          <span className="dim">
            {stats.yes.total + stats.no.total > 0
              ? `${Math.round((stats.yes.total / (stats.yes.total + stats.no.total)) * 100)}% YES-SIDE`
              : '—'}
            {stats.blocks > 0 && ` · ${stats.blocks} BLOCK`}
          </span>
        </div>
      </div>
      {state.loading ? (
        <div className="dim" style={{ padding: '8px 12px' }}>loading tape…</div>
      ) : state.trades.length === 0 ? (
        <div className="dim" style={{ padding: '8px 12px' }}>no trades yet on this market</div>
      ) : (
        <table className="mini-table trades-table">
          <thead>
            <tr><th>TIME</th><th>TAKER</th><th>PRICE</th><th>SIZE</th></tr>
          </thead>
          <tbody>
            {state.trades.slice(0, 60).map((t) => {
              const px = cents(t.taker_side === 'yes' ? t.yes_price_dollars ?? t.yes_price : t.no_price_dollars ?? t.no_price)
              return (
                <tr key={t.trade_id}>
                  <td className="dim">
                    {new Date(t.created_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </td>
                  <td className={t.taker_side === 'yes' ? 'yes' : 'no'}>
                    {t.taker_side?.toUpperCase()}{t.is_block_trade ? ' ▪BLK' : ''}
                  </td>
                  <td>{px}¢</td>
                  <td>{num(t.count_fp ?? t.count).toLocaleString()}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <div className="dim small" style={{ padding: '4px 12px 8px' }}>
        last {state.trades.length} trades · avg clip = mean contracts per taker fill on that side
      </div>
    </div>
  )
}

function TradeTicket({ market, authConfigured, balance, onOrderPlaced }) {
  const [side, setSide] = useState('yes')
  const [action, setAction] = useState('buy')
  const [type, setType] = useState('limit')
  const [count, setCount] = useState(10)
  const [price, setPrice] = useState(50)
  const [confirming, setConfirming] = useState(false)
  const [status, setStatus] = useState(null) // {kind:'ok'|'err', msg}
  const [busy, setBusy] = useState(false)

  // Fully reset the ticket when the market changes so stale sizes/sides can't
  // carry over to a different contract.
  useEffect(() => {
    setSide('yes')
    setAction('buy')
    setType('limit')
    setCount(10)
    setConfirming(false)
    setStatus(null)
  }, [market.ticker])

  // Seed limit price from the current ask/bid whenever market or side changes.
  useEffect(() => {
    const ask = cents(side === 'yes' ? market.yes_ask_dollars ?? market.yes_ask : market.no_ask_dollars ?? market.no_ask)
    const bid = cents(side === 'yes' ? market.yes_bid_dollars ?? market.yes_bid : market.no_bid_dollars ?? market.no_bid)
    const seed = action === 'buy' ? ask ?? bid : bid ?? ask
    if (seed) setPrice(Math.min(99, Math.max(1, seed)))
    setConfirming(false)
    setStatus(null)
  }, [market.ticker, side, action])

  const maxCost = useMemo(() => {
    if (type === 'limit') return count * price
    return null
  }, [count, price, type])

  const submit = async () => {
    setBusy(true)
    setStatus(null)
    try {
      // Kalshi Create Order V2: single YES book. Everything is expressed in
      // yes terms — buying NO at q is an ask (short yes) at 100 − q.
      //   yes buy  -> bid @ p        yes sell -> ask @ p
      //   no  buy  -> ask @ 100-p    no  sell -> bid @ 100-p
      const isBid = (side === 'yes') === (action === 'buy')
      let yesCents
      if (type === 'limit') {
        yesCents = side === 'yes' ? Number(price) : 100 - Number(price)
      } else {
        // market order = immediate-or-cancel at the most aggressive price
        yesCents = isBid ? 99 : 1
      }
      const order = {
        ticker: market.ticker,
        client_order_id: crypto.randomUUID(),
        side: isBid ? 'bid' : 'ask',
        count: Number(count).toFixed(2),
        price: (yesCents / 100).toFixed(4),
        time_in_force: type === 'limit' ? 'good_till_canceled' : 'immediate_or_cancel',
        self_trade_prevention_type: 'taker_at_cross',
      }
      const res = await api('/portfolio/events/orders', { method: 'POST', body: order })
      const filled = parseFloat(res.fill_count ?? '0')
      const remaining = parseFloat(res.remaining_count ?? '0')
      const avg = res.average_fill_price ? Math.round(parseFloat(res.average_fill_price) * 100) : null
      const parts = []
      if (filled > 0) parts.push(`FILLED ${filled}${avg !== null ? ` @ ${side === 'yes' ? avg : 100 - avg}¢ AVG` : ''}`)
      if (remaining > 0) parts.push(`RESTING ${remaining}`)
      if (parts.length === 0) parts.push('NO FILL (CANCELED)')
      setStatus({ kind: 'ok', msg: `${parts.join(' · ')} · ID ${res.order_id?.slice(0, 8) || '?'}` })
      onOrderPlaced?.()
    } catch (e) {
      setStatus({ kind: 'err', msg: e.message })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="ticket">
      <div className="panel-title">TRADE TICKET</div>
      {!authConfigured && (
        <div className="warn">
          No API key configured — orders disabled. Add credentials to
          kalshi-terminal/.env (see .env.example) and restart.
        </div>
      )}
      <div className="ticket-grid">
        <div className="seg">
          <button className={`seg-btn yes ${side === 'yes' ? 'on' : ''}`} onClick={() => setSide('yes')}>YES</button>
          <button className={`seg-btn no ${side === 'no' ? 'on' : ''}`} onClick={() => setSide('no')}>NO</button>
        </div>
        <div className="seg">
          <button className={`seg-btn ${action === 'buy' ? 'on' : ''}`} onClick={() => setAction('buy')}>BUY</button>
          <button className={`seg-btn ${action === 'sell' ? 'on' : ''}`} onClick={() => setAction('sell')}>SELL</button>
        </div>
        <div className="seg">
          <button className={`seg-btn ${type === 'limit' ? 'on' : ''}`} onClick={() => setType('limit')}>LIMIT</button>
          <button className={`seg-btn ${type === 'market' ? 'on' : ''}`} onClick={() => setType('market')}>MKT</button>
        </div>
        <label className="field">
          <span>CONTRACTS</span>
          <input type="number" min="1" value={count} onChange={(e) => setCount(e.target.value)} />
        </label>
        {type === 'limit' && (
          <label className="field">
            <span>PRICE (¢)</span>
            <input type="number" min="1" max="99" value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
        )}
        <div className="cost-line">
          {type === 'limit'
            ? <>MAX {action === 'buy' ? 'COST' : 'PROCEEDS'} <b>{fmtMoney(maxCost)}</b></>
            : <span className="dim">market order — fills at best available</span>}
        </div>
        {!confirming ? (
          <button
            className={`submit ${side}`}
            disabled={!authConfigured || busy}
            onClick={() => setConfirming(true)}
          >
            {action.toUpperCase()} {count} {side.toUpperCase()} {type === 'limit' ? `@ ${price}¢` : 'MKT'}
          </button>
        ) : (
          (() => {
            // Dollar figures the user is actually committing to.
            const n = Math.max(0, Number(count) || 0)
            const ask = cents(side === 'yes' ? market.yes_ask_dollars ?? market.yes_ask : market.no_ask_dollars ?? market.no_ask)
            const bid = cents(side === 'yes' ? market.yes_bid_dollars ?? market.yes_bid : market.no_bid_dollars ?? market.no_bid)
            const px = type === 'limit' ? Number(price) : action === 'buy' ? ask : bid
            const gross = px !== null ? n * px : null // cents
            const p = px !== null ? px / 100 : 0.5
            // Kalshi taker fee ≈ ceil(7% × count × price × (1−price))
            const fee = px !== null ? Math.ceil(7 * n * p * (1 - p)) : null // cents
            const isBuy = action === 'buy'
            return (
              <div className="confirm-box">
                <div className="confirm-title">
                  CONFIRM: {action.toUpperCase()} {n} {side.toUpperCase()}{' '}
                  {type === 'limit' ? `@ ${price}¢ LIMIT` : 'AT MARKET'}
                </div>
                <div className="confirm-line">
                  <span>{isBuy ? (type === 'limit' ? 'MAX SPEND' : 'EST. SPEND') : type === 'limit' ? 'MIN PROCEEDS' : 'EST. PROCEEDS'}</span>
                  <b className="confirm-amount">{gross === null ? '—' : fmtMoney(gross)}</b>
                </div>
                <div className="confirm-line">
                  <span>EST. FEE</span>
                  <b>{fee === null ? '—' : fmtMoney(fee)}</b>
                </div>
                <div className="confirm-line total">
                  <span>{isBuy ? 'TOTAL OUT OF POCKET' : 'NET CREDIT'}</span>
                  <b className="confirm-amount">
                    {gross === null ? '—' : fmtMoney(isBuy ? gross + (fee ?? 0) : Math.max(0, gross - (fee ?? 0)))}
                  </b>
                </div>
                {type === 'market' && (
                  <div className="dim small">market order — actual fill can differ from top-of-book estimate</div>
                )}
                <div className="confirm-row">
                  <button className={`submit ${side}`} disabled={busy} onClick={submit}>
                    {busy ? 'SENDING…' : `CONFIRM ${gross === null ? '' : fmtMoney(isBuy ? gross + (fee ?? 0) : gross)}`}
                  </button>
                  <button className="submit cancel" disabled={busy} onClick={() => setConfirming(false)}>
                    ABORT
                  </button>
                </div>
              </div>
            )
          })()
        )}
        {status && <div className={status.kind === 'ok' ? 'ok-text' : 'err-text'}>{status.msg}</div>}
      </div>
      {action === 'buy' ? (
        <KellyPanel
          market={market}
          side={side}
          type={type}
          price={price}
          balance={balance}
          onApply={(s, c) => {
            setSide(s)
            setCount(c)
          }}
        />
      ) : (
        <div className="kelly">
          <div className="panel-title">KELLY SIZING</div>
          <div className="dim" style={{ padding: '8px 12px' }}>
            Kelly sizing applies to opening (buy) orders — switch to BUY to size a position.
          </div>
        </div>
      )}
    </div>
  )
}

function Portfolio({ authConfigured, refreshKey }) {
  const [tab, setTab] = useState('positions')
  const [positions, setPositions] = useState([])
  const [orders, setOrders] = useState([])
  const [err, setErr] = useState(null)

  const load = () => {
    if (!authConfigured) return
    setErr(null)
    api('/portfolio/positions?limit=100&count_filter=position')
      .then((d) => setPositions(d.market_positions || []))
      .catch((e) => setErr(e.message))
    api('/portfolio/orders?status=resting&limit=100')
      .then((d) => setOrders(d.orders || []))
      .catch((e) => setErr(e.message))
  }
  useEffect(load, [authConfigured, refreshKey])

  const cancel = async (id) => {
    try {
      await api(`/portfolio/events/orders/${id}`, { method: 'DELETE' })
      load()
    } catch (e) {
      setErr(e.message)
    }
  }

  if (!authConfigured) return null
  return (
    <div className="portfolio">
      <div className="tabs">
        <button className={tab === 'positions' ? 'on' : ''} onClick={() => setTab('positions')}>
          POSITIONS ({positions.length})
        </button>
        <button className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}>
          OPEN ORDERS ({orders.length})
        </button>
        <button onClick={load}>⟳</button>
      </div>
      {err && <div className="err-text">{err}</div>}
      {tab === 'positions' && (
        <table className="mini-table">
          <thead><tr><th>TICKER</th><th>POS</th><th>EXPOSURE</th><th>REALIZED</th></tr></thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.ticker}>
                <td>{p.ticker}</td>
                <td className={p.position > 0 ? 'up' : p.position < 0 ? 'down' : ''}>
                  {p.position > 0 ? `+${p.position} YES` : p.position < 0 ? `${-p.position} NO` : '0'}
                </td>
                <td>{fmtMoney(p.market_exposure)}</td>
                <td>{fmtMoney(p.realized_pnl)}</td>
              </tr>
            ))}
            {positions.length === 0 && <tr><td colSpan="4" className="dim">no open positions</td></tr>}
          </tbody>
        </table>
      )}
      {tab === 'orders' && (
        <table className="mini-table">
          <thead><tr><th>TICKER</th><th>ORDER</th><th>REMAIN</th><th></th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.order_id}>
                <td>{o.ticker}</td>
                <td className={o.side === 'yes' ? 'yes' : 'no'}>
                  {o.action?.toUpperCase()} {o.side?.toUpperCase()} @{' '}
                  {cents(o.yes_price_dollars ?? o.no_price_dollars) ?? o.yes_price ?? o.no_price}¢
                </td>
                <td>{o.remaining_count}</td>
                <td><button className="link-btn" onClick={() => cancel(o.order_id)}>CXL</button></td>
              </tr>
            ))}
            {orders.length === 0 && <tr><td colSpan="4" className="dim">no resting orders</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default function MarketPanel({ selected, authConfigured, balance, onOrderPlaced, tabRequest }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [tab, setTab] = useState('ticket')
  useEffect(() => setTab('ticket'), [selected?.market?.ticker])
  // command-line driven tab switch (ET / TRADES)
  useEffect(() => { if (tabRequest?.tab) setTab(tabRequest.tab) }, [tabRequest])
  const handleOrderPlaced = () => {
    setRefreshKey((k) => k + 1)
    onOrderPlaced?.()
  }

  if (!selected) {
    return (
      <aside className="market-panel">
        <div className="empty-panel">
          <div className="dim">SELECT A MARKET</div>
          <div className="dim small">click an event to expand its submarkets, then click a row</div>
        </div>
        <Portfolio authConfigured={authConfigured} refreshKey={refreshKey} />
      </aside>
    )
  }

  const { market, event } = selected
  const yesBid = cents(market.yes_bid_dollars ?? market.yes_bid)
  const yesAsk = cents(market.yes_ask_dollars ?? market.yes_ask)
  const last = cents(market.last_price_dollars ?? market.last_price)

  return (
    <aside className="market-panel">
      <div className="detail-head">
        <div className="detail-event">{event.title}</div>
        <div className="detail-outcome">{market.yes_sub_title || market.sub_title || market.ticker}</div>
        <div className="detail-ticker dim">{market.ticker}</div>
        <div className="detail-prices">
          <span>YES <b className="yes">{fmtCents(yesBid)}/{fmtCents(yesAsk)}</b></span>
          <span>LAST <b>{fmtCents(last)}</b></span>
          <span>VOL <b>{fmtCompact(num(market.volume_fp ?? market.volume))}</b></span>
          <span>OI <b>{fmtCompact(num(market.open_interest_fp ?? market.open_interest))}</b></span>
        </div>
        <div className="detail-close dim">
          CLOSES {market.close_time ? new Date(market.close_time).toLocaleString() : '—'}
        </div>
      </div>
      <RulesPanel market={market} event={event} />
      <Orderbook ticker={market.ticker} />
      <div className="tabs">
        <button className={tab === 'ticket' ? 'on' : ''} onClick={() => setTab('ticket')}>TICKET</button>
        <button className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>TRADES</button>
      </div>
      {tab === 'ticket' ? (
        <TradeTicket market={market} authConfigured={authConfigured} balance={balance} onOrderPlaced={handleOrderPlaced} />
      ) : (
        <TradesPanel ticker={market.ticker} />
      )}
      <Portfolio authConfigured={authConfigured} refreshKey={refreshKey} />
    </aside>
  )
}
