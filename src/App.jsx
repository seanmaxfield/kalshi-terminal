import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, loadAllEvents, num, fmtMoney, cents } from './api.js'
import Sidebar from './components/Sidebar.jsx'
import EventList from './components/EventList.jsx'
import MarketPanel from './components/MarketPanel.jsx'
import StrikeAnalysis from './components/StrikeAnalysis.jsx'
import FieldAnalysis from './components/FieldAnalysis.jsx'
import PortfolioModal from './components/PortfolioModal.jsx'
import PriceChartModal from './components/PriceChartModal.jsx'
import CommodityDesk from './components/CommodityDesk.jsx'
import SpreadTool from './components/SpreadTool.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import NewsCenter from './components/NewsCenter.jsx'
import CommodityFilters, { DEFAULT_COM_FILTERS } from './components/CommodityFilters.jsx'
import CommandBar from './components/CommandBar.jsx'
import MainMenu from './components/MainMenu.jsx'
import MonitorScreen from './components/MonitorScreen.jsx'
import SecurityScreen from './components/SecurityScreen.jsx'
import DataScreen from './components/DataScreen.jsx'
import Launchpad, { loadWatchlist, saveWatchlist } from './components/Launchpad.jsx'
import NotesScreen from './components/NotesScreen.jsx'
import { symbolForEvent } from './lib/underlying.js'
import { loadPrefs } from './lib/prefs.js'

const STOP = new Set(['on', 'the', 'of', 'in', 'at', 'a', 'an', 'will', 'be', 'by', 'to', 'or', 'and', 'above', 'below', 'price', 'edt', 'et', 'pm', 'am'])
function marketKeywords(sel) {
  if (!sel) return ''
  const words = String(sel.event.title).replace(/[?()]/g, ' ').replace(/\b\d[\d,.:]*\b/g, ' ').split(/\s+/)
    .filter((w) => w && !STOP.has(w.toLowerCase())).slice(0, 5)
  return words.join(' ')
}

export default function App() {
  const [prefs, setPrefs] = useState(loadPrefs)
  const [config, setConfig] = useState({ env: '…', authConfigured: false })
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [category, setCategory] = useState(() => loadPrefs().defaultCategory || 'All')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null) // { market, event }
  const [analysisEvent, setAnalysisEvent] = useState(null)
  const [fieldEvent, setFieldEvent] = useState(null)
  const [showPortfolio, setShowPortfolio] = useState(false)
  const [portfolioTab, setPortfolioTab] = useState('summary')
  const [chartTarget, setChartTarget] = useState(null) // { market, event, mode, range }
  const [spreadEvent, setSpreadEvent] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showNews, setShowNews] = useState(false)
  const [newsInitial, setNewsInitial] = useState({})
  const [screen, setScreen] = useState(null) // { kind, props } for command-driven screens
  const [tabRequest, setTabRequest] = useState(null)
  const [toast, setToast] = useState(null)
  const [comFilters, setComFilters] = useState(DEFAULT_COM_FILTERS)
  const [balance, setBalance] = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [, setClock] = useState(0) // 1s tick so the "age" display counts up
  const abortRef = useRef(null)
  const refreshingRef = useRef(false)

  const say = (msg) => { setToast(msg); setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500) }

  // Background refresh: re-sweep the full universe, swap in atomically at the end.
  const refresh = async () => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    setLoadError(null)
    try {
      const fresh = await loadAllEvents(() => {}, abortRef.current?.signal)
      setEvents(fresh)
      setLastRefresh(Date.now())
    } catch (e) {
      setLoadError(e.message)
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
    if (config.authConfigured) refreshBalance()
  }

  useEffect(() => {
    api('/_config').then(setConfig).catch(() => {})
    const ctl = new AbortController()
    abortRef.current = ctl
    refreshingRef.current = true
    setRefreshing(true)
    loadAllEvents((acc, more) => {
      setEvents(acc)
      if (!more) { setLoading(false); setLastRefresh(Date.now()) }
    }, ctl.signal)
      .catch((e) => { setLoadError(e.message); setLoading(false) })
      .finally(() => {
        setLoading(false)
        refreshingRef.current = false
        setRefreshing(false)
        setLastRefresh((t) => t ?? Date.now())
      })
    const clockTimer = setInterval(() => setClock((c) => c + 1), 1000)
    return () => { ctl.abort(); clearInterval(clockTimer) }
  }, [])

  // Auto-refresh the whole board (interval from personal defaults).
  useEffect(() => {
    const t = setInterval(() => refresh(), Math.max(30, prefs.refreshSeconds || 120) * 1000)
    return () => clearInterval(t)
  }, [config.authConfigured, prefs.refreshSeconds])

  const refreshBalance = () => {
    api('/portfolio/balance').then((d) => setBalance(d.balance ?? null)).catch(() => setBalance(null))
  }
  useEffect(() => { if (config.authConfigured) refreshBalance() }, [config.authConfigured])

  const categories = useMemo(() => {
    const counts = new Map()
    for (const ev of events) { const c = ev.category || 'Other'; counts.set(c, (counts.get(c) || 0) + 1) }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [events])

  const marketCount = useMemo(() => events.reduce((s, ev) => s + (ev.markets?.length || 0), 0), [events])

  // ticker -> {event, market} lookup for portfolio enrichment + command line
  const marketIndex = useMemo(() => {
    const idx = new Map()
    for (const ev of events) for (const m of ev.markets || []) idx.set(m.ticker, { event: ev, market: m })
    return idx
  }, [events])

  // keep the selected market object fresh after each board refresh
  useEffect(() => {
    if (!selected) return
    const fresh = marketIndex.get(selected.market.ticker)
    if (fresh && fresh.market !== selected.market) setSelected(fresh)
  }, [marketIndex])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = events
    if (category !== 'All') list = list.filter((ev) => (ev.category || 'Other') === category)
    if (q) {
      // "a OR b" searches any term
      const terms = q.split(/\s+or\s+/).map((t) => t.trim()).filter(Boolean)
      const hit = (s) => terms.some((t) => s?.toLowerCase().includes(t))
      list = list.filter((ev) => hit(ev.title) || hit(ev.sub_title) || hit(ev.event_ticker) || hit(ev.series_ticker) ||
        ev.markets?.some((m) => hit(m.ticker) || hit(m.yes_sub_title)))
    }
    const vol24 = (ev) => ev.markets?.reduce((s, m) => s + num(m.volume_24h_fp ?? m.volume_fp), 0) ?? 0
    const earliestClose = (ev) =>
      Math.min(...(ev.markets || []).map((m) => new Date(m.close_time || m.expected_expiration_time || 8.64e15).getTime()))
    let sortFn = (a, b) => vol24(b) - vol24(a)
    if (category === 'Commodities') {
      if (comFilters.sym === 'other') list = list.filter((ev) => symbolForEvent(ev) === null)
      else if (comFilters.sym !== 'all') list = list.filter((ev) => symbolForEvent(ev) === comFilters.sym)
      if (comFilters.expiry !== 'all') {
        const now = Date.now(), cut24 = now + 24 * 3600e3, cut7d = now + 7 * 24 * 3600e3
        list = list.filter((ev) => {
          const t = earliestClose(ev)
          if (comFilters.expiry === '24h') return t <= cut24
          if (comFilters.expiry === '7d') return t <= cut7d
          return t > cut7d
        })
      }
      if (comFilters.minVol > 0) list = list.filter((ev) => vol24(ev) >= comFilters.minVol)
      if (comFilters.sort === 'close') sortFn = (a, b) => earliestClose(a) - earliestClose(b)
    }
    return [...list].sort(sortFn)
  }, [events, category, search, comFilters])

  const comCounts = useMemo(() => {
    if (category !== 'Commodities') return null
    const evs = events.filter((ev) => (ev.category || 'Other') === 'Commodities')
    const bySym = {}; let other = 0
    for (const ev of evs) { const s = symbolForEvent(ev); if (s) bySym[s] = (bySym[s] || 0) + 1; else other++ }
    return { total: evs.length, bySym, other }
  }, [events, category])

  // ---------------- command context ----------------
  const closeAll = () => {
    setScreen(null); setShowNews(false); setShowPortfolio(false); setShowSettings(false)
    setChartTarget(null); setAnalysisEvent(null); setFieldEvent(null); setSpreadEvent(null)
  }
  const selectTicker = (t) => {
    const hit = marketIndex.get(t)
    if (!hit) { say(`unknown ticker ${t}`); return false }
    setSelected(hit)
    return true
  }
  const grab = async () => {
    const lines = [`KALSHI TERMINAL SNAPSHOT · ${new Date().toLocaleString()}`, `category ${category} · ${filtered.length} events shown${search ? ` · search "${search}"` : ''}`]
    if (selected) {
      const m = selected.market
      lines.push('', `SELECTED: ${selected.event.title} — ${m.yes_sub_title || m.ticker} (${m.ticker})`,
        `YES ${cents(m.yes_bid_dollars) ?? '—'}/${cents(m.yes_ask_dollars) ?? '—'}¢ · LAST ${cents(m.last_price_dollars) ?? '—'}¢ · VOL ${num(m.volume_fp)} · OI ${num(m.open_interest_fp)} · CLOSES ${m.close_time}`)
    }
    lines.push('', 'TOP OF BOARD:')
    for (const ev of filtered.slice(0, 15)) lines.push(`  ${ev.title} · ${ev.markets?.length} mkts`)
    try { await navigator.clipboard.writeText(lines.join('\n')); say('snapshot copied to clipboard') } catch { say('clipboard blocked by browser') }
  }
  const squawk = async () => {
    if (!('speechSynthesis' in window)) return say('speech not available in this browser')
    if (window.speechSynthesis.speaking) { window.speechSynthesis.cancel(); return say('squawk stopped') }
    try {
      const d = await api(`/_underlying/news?q=${encodeURIComponent(selected ? marketKeywords(selected) : 'financial markets')}`)
      const items = (d.articles || []).slice(0, prefs.squawkCount || 5)
      if (!items.length) return say('no headlines to read')
      const u = new SpeechSynthesisUtterance(items.map((a, i) => `Headline ${i + 1}. ${a.title.replace(/ - [^-]+$/, '')}.`).join(' '))
      u.rate = 1.05
      window.speechSynthesis.speak(u)
      say(`squawking ${items.length} headlines — type BBSQ again to stop`)
    } catch (e) { say(e.message) }
  }
  const watch = (t, remove = false) => {
    if (!t) return say('no ticker given or selected')
    const wl = loadWatchlist()
    const next = remove ? wl.filter((x) => x !== t) : wl.includes(t) ? wl : [...wl, t]
    saveWatchlist(next)
    say(remove ? `${t} removed from watchlist` : `${t} added to watchlist (${next.length}) — BLP to view`)
  }

  const ctx = {
    events, marketIndex, selected,
    setCategory, setSearch, selectTicker, closeAll, toast: say,
    open: (kind, props = {}) => setScreen({ kind, props, nonce: Date.now() }),
    marketTab: (tab) => setTabRequest({ tab, nonce: Date.now() }),
    openNews: (opts) => { setNewsInitial({ ...opts, nonce: Date.now() }); setShowNews(true) },
    openPortfolio: (tab) => { if (!config.authConfigured) return say('connect an API key first (PDF)'); setPortfolioTab(tab || 'summary'); setShowPortfolio(true) },
    openSettings: () => setShowSettings(true),
    openChart: (mode, range) => selected && setChartTarget({ ...selected, mode, range: range || prefs.chartRange }),
    openStrike: () => selected && setAnalysisEvent(selected.event),
    openField: () => selected && setFieldEvent(selected.event),
    openSpread: () => selected && setSpreadEvent(selected.event),
    print: () => window.print(),
    grab, squawk, watch,
    marketKeywords: () => marketKeywords(selected),
  }

  return (
    <div className="terminal">
      <header className="topbar">
        <button className="settings-btn" title="API & connection setup (PDF)" onClick={() => setShowSettings(true)}>⚙</button>
        <span className="logo">KALSHI<span className="logo-accent">TERM</span></span>
        <span className={`env-badge ${config.env === 'demo' ? 'env-demo' : 'env-prod'}`}>{String(config.env).toUpperCase()}</span>
        <span className="topbar-stat">EVENTS <b>{events.length.toLocaleString()}</b></span>
        <span className="topbar-stat">MARKETS <b>{marketCount.toLocaleString()}</b></span>
        {loading && <span className="loading-tick">LOADING…</span>}
        {loadError && <span className="err-text">FEED ERROR: {loadError}</span>}
        <span className="refresh-cluster">
          <span className={`refresh-age ${lastRefresh && Date.now() - lastRefresh > 240_000 ? 'stale' : ''}`}>
            {refreshing ? 'REFRESHING…' : lastRefresh ? `UPD ${Math.max(0, Math.round((Date.now() - lastRefresh) / 1000))}s AGO` : '—'}
          </span>
          <button className="refresh-btn" onClick={refresh} disabled={refreshing} title="Refresh all markets now">⟳</button>
        </span>
        <input className="search" placeholder="FILTER BOARD… (a OR b)" value={search} onChange={(e) => setSearch(e.target.value)} spellCheck={false} />
        <span className="topbar-stat balance">
          {config.authConfigured ? <>BAL <b>{fmtMoney(balance)}</b></> : <span className="dim">NO API KEY — VIEW ONLY</span>}
        </span>
        <button className="portfolio-btn" onClick={() => ctx.open('main')}>MAIN</button>
        <button className="portfolio-btn" onClick={() => ctx.openNews({})}>NEWS</button>
        {config.authConfigured && <button className="portfolio-btn" onClick={() => ctx.openPortfolio('summary')}>PORTFOLIO</button>}
      </header>
      <CommandBar ctx={ctx} />

      <div className="body">
        <Sidebar categories={categories} total={events.length} active={category} onSelect={setCategory} />
        <div className="main-col">
          {category === 'Commodities' && <CommodityDesk events={events} />}
          {category === 'Commodities' && <CommodityFilters filters={comFilters} setFilters={setComFilters} counts={comCounts} />}
          <EventList
            events={filtered}
            selectedTicker={selected?.market?.ticker}
            onSelectMarket={(market, event) => setSelected({ market, event })}
            onAnalyze={setAnalysisEvent}
            onField={setFieldEvent}
            onChart={(market, event) => setChartTarget({ market, event, mode: 'line', range: prefs.chartRange })}
            onSpread={setSpreadEvent}
          />
        </div>
        <MarketPanel selected={selected} authConfigured={config.authConfigured} balance={balance} onOrderPlaced={refreshBalance} tabRequest={tabRequest} />
      </div>

      {analysisEvent && <StrikeAnalysis event={analysisEvent} onClose={() => setAnalysisEvent(null)} />}
      {fieldEvent && <FieldAnalysis event={fieldEvent} onClose={() => setFieldEvent(null)} />}
      {showPortfolio && <PortfolioModal marketIndex={marketIndex} initialTab={portfolioTab} onClose={() => setShowPortfolio(false)} />}
      {spreadEvent && <SpreadTool event={spreadEvent} onClose={() => setSpreadEvent(null)} />}
      {showNews && <NewsCenter initial={newsInitial} onClose={() => setShowNews(false)} />}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onPrefsChange={(p) => { setPrefs(p); say('personal defaults saved') }}
          onConfigChange={(c) => { setConfig(c); if (c.authConfigured) refreshBalance(); else setBalance(null) }}
        />
      )}
      {chartTarget && (
        <PriceChartModal market={chartTarget.market} event={chartTarget.event} mode={chartTarget.mode} initialRange={chartTarget.range} onClose={() => setChartTarget(null)} />
      )}

      {screen?.kind === 'main' && <MainMenu tab={screen.props.tab || 'main'} query={screen.props.query || ''} ctx={ctx} onClose={() => setScreen(null)} />}
      {screen?.kind === 'help' && <MainMenu tab="help" query={screen.props.query || ''} ctx={ctx} onClose={() => setScreen(null)} />}
      {screen?.kind === 'monitor' && (
        <MonitorScreen kind={screen.props.kind} category={screen.props.category} events={events} onSelectTicker={selectTicker} onCategory={setCategory} onClose={() => setScreen(null)} />
      )}
      {screen?.kind === 'security' && selected && (
        <SecurityScreen tab={screen.props.tab} selected={selected} events={events} balance={balance} onClose={() => setScreen(null)} />
      )}
      {screen?.kind === 'data' && <DataScreen events={events} filtered={filtered} selected={selected} authConfigured={config.authConfigured} onClose={() => setScreen(null)} />}
      {screen?.kind === 'launchpad' && (
        <Launchpad marketIndex={marketIndex} onSelectTicker={selectTicker} rotate={screen.props.rotate ? screen.nonce : null} keywords={marketKeywords} onClose={() => setScreen(null)} />
      )}
      {screen?.kind === 'notes' && <NotesScreen selected={selected} onClose={() => setScreen(null)} />}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
