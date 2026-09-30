import React, { useEffect, useState } from 'react'
import { cents, fmtCents, fmtCompact, num } from '../api.js'
import { hasStrikeStructure, isFieldEvent } from '../lib/quant.js'

const PAGE = 150

function MarketRow({ market, event, selected, onSelect, onChart }) {
  const yesBid = cents(market.yes_bid_dollars ?? market.yes_bid)
  const yesAsk = cents(market.yes_ask_dollars ?? market.yes_ask)
  const noBid = cents(market.no_bid_dollars ?? market.no_bid)
  const noAsk = cents(market.no_ask_dollars ?? market.no_ask)
  const last = cents(market.last_price_dollars ?? market.last_price)
  const prev = cents(market.previous_price_dollars ?? market.previous_price)
  const chg = last !== null && prev !== null ? last - prev : null
  return (
    <tr
      className={`mkt-row ${selected ? 'selected' : ''}`}
      onClick={() => onSelect(market, event)}
    >
      <td className="mkt-name">
        {market.yes_sub_title || market.sub_title || market.title || market.ticker}
        <button
          className="chart-btn"
          title="Price history"
          onClick={(e) => {
            e.stopPropagation()
            onChart(market, event)
          }}
        >
          CHART
        </button>
      </td>
      <td className="px yes">{fmtCents(yesBid)}</td>
      <td className="px yes">{fmtCents(yesAsk)}</td>
      <td className="px no">{fmtCents(noBid)}</td>
      <td className="px no">{fmtCents(noAsk)}</td>
      <td className="px">{fmtCents(last)}</td>
      <td className={`px ${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}`}>
        {chg === null ? '—' : `${chg > 0 ? '+' : ''}${chg}`}
      </td>
      <td className="vol">{fmtCompact(num(market.volume_24h_fp ?? market.volume_24h))}</td>
      <td className="vol">{fmtCompact(num(market.volume_fp ?? market.volume))}</td>
    </tr>
  )
}

function EventBlock({ event, expanded, onToggle, selectedTicker, onSelectMarket, onAnalyze, onField, onChart, onSpread }) {
  const markets = event.markets || []
  const vol24 = markets.reduce((s, m) => s + num(m.volume_24h_fp ?? m.volume_24h), 0)
  return (
    <div className="event-block">
      <div className="event-head" onClick={onToggle}>
        <span className="caret">{expanded ? '▾' : '▸'}</span>
        <span className="event-title">{event.title}</span>
        {event.sub_title && <span className="event-sub">{event.sub_title}</span>}
        <span className="event-meta">
          {isFieldEvent(event) && (
            <button
              className="analyze-btn field-btn"
              onClick={(e) => {
                e.stopPropagation()
                onField(event)
              }}
            >
              ⛳ FIELD
            </button>
          )}
          {hasStrikeStructure(event) && (
            <>
              <button
                className="analyze-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  onAnalyze(event)
                }}
              >
                ⌁ ANALYZE
              </button>
              <button
                className="analyze-btn spread-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  onSpread(event)
                }}
              >
                ⇄ SPREAD
              </button>
            </>
          )}
          <span className="tag">{(event.category || 'OTHER').toUpperCase()}</span>
          <span className="dim">{markets.length} MKT</span>
          <span className="dim">24H {fmtCompact(vol24)}</span>
        </span>
      </div>
      {expanded && (
        <table className="mkt-table">
          <thead>
            <tr>
              <th>OUTCOME</th>
              <th>YES BID</th>
              <th>YES ASK</th>
              <th>NO BID</th>
              <th>NO ASK</th>
              <th>LAST</th>
              <th>CHG</th>
              <th>VOL 24H</th>
              <th>VOL</th>
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => (
              <MarketRow
                key={m.ticker}
                market={m}
                event={event}
                selected={m.ticker === selectedTicker}
                onSelect={onSelectMarket}
                onChart={onChart}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default function EventList({ events, selectedTicker, onSelectMarket, onAnalyze, onField, onChart, onSpread }) {
  const [shown, setShown] = useState(PAGE)
  const [expanded, setExpanded] = useState(() => new Set())

  // Reset paging when the filter changes the list identity.
  useEffect(() => setShown(PAGE), [events])

  const toggle = (ticker) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(ticker) ? next.delete(ticker) : next.add(ticker)
      return next
    })

  return (
    <main className="event-list">
      {events.slice(0, shown).map((ev) => (
        <EventBlock
          key={ev.event_ticker}
          event={ev}
          expanded={expanded.has(ev.event_ticker)}
          onToggle={() => toggle(ev.event_ticker)}
          selectedTicker={selectedTicker}
          onSelectMarket={onSelectMarket}
          onAnalyze={onAnalyze}
          onField={onField}
          onChart={onChart}
          onSpread={onSpread}
        />
      ))}
      {events.length > shown && (
        <button className="show-more" onClick={() => setShown((s) => s + PAGE)}>
          SHOW MORE ({(events.length - shown).toLocaleString()} REMAINING)
        </button>
      )}
      {events.length === 0 && <div className="empty">NO MARKETS MATCH</div>}
    </main>
  )
}
