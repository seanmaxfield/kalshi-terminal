import React, { useState } from 'react'
import { api, cents, num } from '../api.js'
import { fetchCandles } from '../lib/history.js'

// DATA: export what the terminal knows as CSV / JSON.
function download(name, text, type = 'text/csv') {
  const blob = new Blob([text], { type })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}
const csv = (rows, cols) =>
  [cols.join(','), ...rows.map((r) => cols.map((c) => {
    const v = r[c] ?? ''
    const s = String(v).replace(/"/g, '""')
    return /[",\n]/.test(s) ? `"${s}"` : s
  }).join(','))].join('\n')

export default function DataScreen({ events, filtered, selected, authConfigured, onClose }) {
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)
  const stamp = new Date().toISOString().slice(0, 10)

  const marketRows = (evs) => evs.flatMap((ev) => (ev.markets || []).map((m) => ({
    event_ticker: ev.event_ticker, series: ev.series_ticker, category: ev.category, event_title: ev.title,
    ticker: m.ticker, outcome: m.yes_sub_title || '', strike: m.floor_strike ?? m.cap_strike ?? '',
    yes_bid: cents(m.yes_bid_dollars ?? m.yes_bid), yes_ask: cents(m.yes_ask_dollars ?? m.yes_ask),
    last: cents(m.last_price_dollars ?? m.last_price), volume: num(m.volume_fp ?? m.volume),
    volume_24h: num(m.volume_24h_fp ?? m.volume_24h), open_interest: num(m.open_interest_fp ?? m.open_interest),
    close_time: m.close_time, status: m.status,
  })))
  const COLS = ['event_ticker', 'series', 'category', 'event_title', 'ticker', 'outcome', 'strike', 'yes_bid', 'yes_ask', 'last', 'volume', 'volume_24h', 'open_interest', 'close_time', 'status']

  const act = async (key, fn) => {
    setBusy(key); setMsg(null)
    try { await fn(); setMsg('exported') } catch (e) { setMsg(`error: ${e.message}`) } finally { setBusy(null) }
  }

  const items = [
    ['markets-view', `Markets in current view (${filtered.reduce((s, e) => s + (e.markets?.length || 0), 0)} rows) · CSV`, () => download(`kalshi-markets-view-${stamp}.csv`, csv(marketRows(filtered), COLS))],
    ['markets-all', `All markets (${events.reduce((s, e) => s + (e.markets?.length || 0), 0)} rows) · CSV`, () => download(`kalshi-markets-all-${stamp}.csv`, csv(marketRows(events), COLS))],
    ['events-json', 'All events with nested markets · JSON', () => download(`kalshi-events-${stamp}.json`, JSON.stringify(events), 'application/json')],
    selected && ['candles', `Price history of ${selected.market.ticker} (1M hourly) · CSV`, async () => {
      const c = await fetchCandles(selected.event.series_ticker, selected.market.ticker, 30, 60)
      download(`${selected.market.ticker}-candles.csv`, csv(c.map((x) => ({ ...x, time: new Date(x.t * 1000).toISOString() })), ['time', 't', 'bid', 'ask', 'mid', 'volume', 'oi']))
    }],
    selected && ['book', `Order book of ${selected.market.ticker} · JSON`, async () => {
      const d = await api(`/markets/${selected.market.ticker}/orderbook?depth=50`)
      download(`${selected.market.ticker}-book.json`, JSON.stringify(d, null, 2), 'application/json')
    }],
    selected && ['tape', `Trade tape of ${selected.market.ticker} · CSV`, async () => {
      const d = await api(`/markets/trades?ticker=${selected.market.ticker}&limit=500`)
      download(`${selected.market.ticker}-trades.csv`, csv(d.trades || [], ['created_time', 'taker_side', 'count_fp', 'yes_price_dollars', 'no_price_dollars', 'is_block_trade', 'trade_id']))
    }],
    authConfigured && ['positions', 'Portfolio positions · CSV', async () => {
      const d = await api('/portfolio/positions?limit=500')
      download(`positions-${stamp}.csv`, csv(d.market_positions || [], ['ticker', 'position', 'position_fp', 'market_exposure', 'market_exposure_dollars', 'realized_pnl', 'realized_pnl_dollars', 'fees_paid', 'resting_orders_count']))
    }],
    authConfigured && ['fills', 'Fills (last 1000) · CSV', async () => {
      let cursor = '', all = []
      for (let i = 0; i < 5; i++) {
        const d = await api(`/portfolio/fills?limit=200${cursor ? `&cursor=${cursor}` : ''}`)
        all = all.concat(d.fills || []); cursor = d.cursor || ''
        if (!cursor) break
      }
      download(`fills-${stamp}.csv`, csv(all, ['created_time', 'ticker', 'action', 'side', 'count_fp', 'yes_price_dollars', 'no_price_dollars', 'fee_cost', 'is_taker', 'order_id', 'trade_id']))
    }],
    authConfigured && ['settlements', 'Settlements · CSV', async () => {
      const d = await api('/portfolio/settlements?limit=500')
      download(`settlements-${stamp}.csv`, csv(d.settlements || [], ['settled_time', 'ticker', 'market_result', 'yes_count_fp', 'no_count_fp', 'yes_total_cost_dollars', 'no_total_cost_dollars', 'revenue', 'fee_cost']))
    }],
  ].filter(Boolean)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">DATA · EXPORT</span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="data-list">
          {items.map(([key, label, fn]) => (
            <button key={key} className="menu-row" disabled={busy !== null} onClick={() => act(key, fn)}>
              <span className="cmd-code">{busy === key ? '…' : '⬇'}</span>
              <span className="menu-desc">{label}</span>
            </button>
          ))}
          {!selected && <div className="dim small" style={{ padding: '6px 10px' }}>select a market to enable per-market exports (candles, book, tape)</div>}
          {!authConfigured && <div className="dim small" style={{ padding: '6px 10px' }}>connect an API key (PDF) to export portfolio data</div>}
          {msg && <div className={msg.startsWith('error') ? 'err-text' : 'ok-text'} style={{ padding: '6px 10px' }}>{msg}</div>}
        </div>
        <div className="modal-foot dim">files download through your browser · prices in cents · timestamps ISO-8601 UTC</div>
      </div>
    </div>
  )
}
