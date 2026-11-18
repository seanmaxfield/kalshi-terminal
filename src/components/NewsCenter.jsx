import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'

const LS_KEY = 'kalshi-news-feeds'

const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`

// Built-in wires: keyless Google News topic searches plus a handful of direct
// publisher RSS feeds. Any can be toggled off in the FEEDS panel, and custom
// RSS/Atom feeds added alongside them.
const BUILTIN_FEEDS = [
  { id: 'markets', name: 'MARKETS', url: gnews('financial markets stocks') },
  { id: 'stocks', name: 'STOCKS', url: gnews('stock market S&P 500 Nasdaq Dow Jones') },
  { id: 'earnings', name: 'EARNINGS', url: gnews('company earnings results guidance') },
  { id: 'fed', name: 'FED / MACRO', url: gnews('federal reserve economy inflation jobs') },
  { id: 'rates', name: 'RATES / BONDS', url: gnews('treasury yields interest rates bond market') },
  { id: 'tech', name: 'TECH / AI', url: gnews('technology artificial intelligence semiconductors') },
  { id: 'commodities', name: 'COMMODITIES', url: gnews('commodities gold silver copper prices') },
  { id: 'energy', name: 'ENERGY / OIL', url: gnews('oil OPEC natural gas energy prices') },
  { id: 'crypto', name: 'CRYPTO', url: gnews('bitcoin ethereum crypto') },
  { id: 'politics', name: 'US POLITICS', url: gnews('congress white house election') },
  { id: 'world', name: 'WORLD', url: gnews('world news geopolitics') },
  { id: 'cnbc', name: 'CNBC TOP', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { id: 'cnbc-mkts', name: 'CNBC MARKETS', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
  { id: 'wsj-mkts', name: 'WSJ MARKETS', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml' },
  { id: 'marketwatch', name: 'MARKETWATCH', url: 'https://feeds.marketwatch.com/marketwatch/topstories/' },
  { id: 'bbc-biz', name: 'BBC BUSINESS', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
]

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY)) || { custom: [], disabled: [] }
  } catch {
    return { custom: [], disabled: [] }
  }
}
function savePrefs(p) {
  localStorage.setItem(LS_KEY, JSON.stringify(p))
}

function ago(pubDate) {
  const ms = Date.now() - new Date(pubDate).getTime()
  if (!Number.isFinite(ms)) return ''
  const h = ms / 3600e3
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`
  if (h < 48) return `${Math.round(h)}h`
  return `${Math.round(h / 24)}d`
}

// TOP <category> → built-in feed (or an ad-hoc query)
const TOP_CATS = {
  DEAL: { q: 'merger acquisition deal' }, MA: { q: 'merger acquisition' },
  NRG: { feed: 'energy' }, ENERGY: { feed: 'energy' }, OIL: { q: 'oil price OPEC' }, COMMODITIES: { feed: 'commodities' },
  POL: { feed: 'politics' }, POLITICS: { feed: 'politics' }, ELECTIONS: { q: 'election polls' },
  FED: { feed: 'fed' }, ECO: { feed: 'fed' }, MACRO: { feed: 'fed' }, RATES: { feed: 'rates' }, BONDS: { feed: 'rates' },
  CRYPTO: { feed: 'crypto' }, BTC: { feed: 'crypto' }, MKT: { feed: 'markets' }, MARKETS: { feed: 'markets' },
  STOCKS: { feed: 'stocks' }, EQUITY: { feed: 'stocks' }, EARN: { feed: 'earnings' }, EARNINGS: { feed: 'earnings' },
  HOT: { q: 'breaking news' }, US: { q: 'United States news' }, WORLD: { feed: 'world' }, WNEWS: { q: 'CEO appointed resigns people moves' },
  SPORTS: { q: 'sports betting odds' }, WEATHER: { q: 'hurricane heat wave weather forecast' },
  TECH: { feed: 'tech' }, AI: { q: 'artificial intelligence' },
}
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'as', 'at', 'is', 'by', 'with', 'after', 'over', 'amid', 'says', 'from', 'its', 'it', 'be', 'are', 'was', 'that', 'this', 'will', 'has', 'have', 'into', 'up', 'down', 'new', 'us'])
const storyKey = (title) => title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)).slice(0, 5).sort().join(' ')

export default function NewsCenter({ onClose, initial = {} }) {
  const [prefs, setPrefs] = useState(loadPrefs)
  const [results, setResults] = useState({}) // feedId -> {articles, err, loading}
  const [reloadTick, setReloadTick] = useState(0)
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [addErr, setAddErr] = useState(null)
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState('')
  const [adhoc, setAdhoc] = useState(null) // {id, name, url} from NI / TNI / MNI / TOP <q>
  const [focusFeed, setFocusFeed] = useState(null) // show only this feed id
  const [rank, setRank] = useState('time') // 'time' | 'coverage' (NRR / MNI)

  // apply command-line intent (mode/query/category)
  useEffect(() => {
    const { mode, query, category } = initial
    setFilter(''); setAdhoc(null); setFocusFeed(null); setRank('time')
    if (mode === 'nrr') setRank('coverage')
    if ((mode === 'ni' || mode === 'tni' || mode === 'mni') && query) {
      const q = mode === 'tni' ? query.split(/\s+/).map((w) => `"${w}"`).join(' ') : query
      const id = 'adhoc'
      setAdhoc({ id, name: `${mode.toUpperCase()} ${query.toUpperCase()}`, url: gnews(q) })
      setFocusFeed(id)
      if (mode === 'mni') setRank('coverage')
    }
    if (mode === 'top' && category) {
      const spec = TOP_CATS[category.toUpperCase()]
      if (spec?.feed) setFocusFeed(spec.feed)
      else { const q = spec?.q || category; setAdhoc({ id: 'adhoc', name: `TOP ${category.toUpperCase()}`, url: gnews(q) }); setFocusFeed('adhoc') }
    }
    if (mode === 'nrc' && query) { setNewName(query.toUpperCase()); setNewUrl(gnews(query)) }
  }, [initial])

  const feeds = useMemo(
    () => [...BUILTIN_FEEDS, ...prefs.custom.map((c) => ({ ...c, custom: true })), ...(adhoc ? [{ ...adhoc, adhoc: true }] : [])],
    [prefs.custom, adhoc]
  )
  const active = feeds.filter((f) => !prefs.disabled.includes(f.id))

  useEffect(() => {
    let live = true
    for (const f of active) {
      setResults((r) => ({ ...r, [f.id]: { ...(r[f.id] || {}), loading: true } }))
      api(`/_news/fetch?url=${encodeURIComponent(f.url)}`)
        .then((d) => live && setResults((r) => ({ ...r, [f.id]: { articles: d.articles, loading: false } })))
        .catch((e) => live && setResults((r) => ({ ...r, [f.id]: { articles: [], err: e.message, loading: false } })))
    }
    const t = setInterval(() => setReloadTick((k) => k + 1), 300_000)
    return () => { live = false; clearInterval(t) }
  }, [feeds.length, prefs.disabled.join(','), reloadTick])

  const stream = useMemo(() => {
    const seen = new Set()
    const all = []
    for (const f of active) {
      for (const a of results[f.id]?.articles || []) {
        const key = a.title.toLowerCase().slice(0, 80)
        if (seen.has(key)) continue
        seen.add(key)
        all.push({ ...a, feed: f.name })
      }
    }
    const q = filter.trim().toLowerCase()
    let list = all.filter((a) => !q || a.title.toLowerCase().includes(q) || a.feed.toLowerCase().includes(q))
    if (focusFeed) {
      const name = feeds.find((f) => f.id === focusFeed)?.name
      list = list.filter((a) => a.feed === name)
    }
    if (rank === 'coverage') {
      // NRR / MNI: rank stories by how many distinct sources/feeds carry them
      const groups = new Map()
      for (const f of active) for (const a of results[f.id]?.articles || []) {
        const k = storyKey(a.title)
        if (!k) continue
        const g = groups.get(k) || { sources: new Set(), feeds: new Set() }
        g.sources.add((a.source || a.feed || '').toLowerCase()); g.feeds.add(f.name)
        groups.set(k, g)
      }
      list = list.map((a) => { const g = groups.get(storyKey(a.title)); return { ...a, coverage: g ? g.sources.size + g.feeds.size - 1 : 1 } })
        .sort((a, b) => b.coverage - a.coverage || new Date(b.pubDate || 0) - new Date(a.pubDate || 0))
      return list.slice(0, 100)
    }
    return list.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0)).slice(0, 200)
  }, [results, active.length, filter, focusFeed, rank, feeds])

  const toggleFeed = (id) =>
    setPrefs((p) => {
      const next = {
        ...p,
        disabled: p.disabled.includes(id) ? p.disabled.filter((x) => x !== id) : [...p.disabled, id],
      }
      savePrefs(next)
      return next
    })

  const removeFeed = (id) =>
    setPrefs((p) => {
      const next = { ...p, custom: p.custom.filter((c) => c.id !== id), disabled: p.disabled.filter((x) => x !== id) }
      savePrefs(next)
      return next
    })

  const addFeed = async () => {
    const name = newName.trim().toUpperCase()
    const url = newUrl.trim()
    setAddErr(null)
    if (!name || !url) return setAddErr('name and RSS url required')
    if (feeds.some((f) => f.url === url)) return setAddErr('feed already added')
    setAdding(true)
    try {
      const d = await api(`/_news/fetch?url=${encodeURIComponent(url)}`)
      const id = `custom-${Date.now()}`
      setPrefs((p) => {
        const next = { ...p, custom: [...p.custom, { id, name: name || d.feedTitle || 'FEED', url }] }
        savePrefs(next)
        return next
      })
      setNewName('')
      setNewUrl('')
    } catch (e) {
      setAddErr(`feed check failed: ${e.message}`)
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">
            {rank === 'coverage' ? `NRR · MOST COVERED${focusFeed ? ' · ' + (feeds.find((f) => f.id === focusFeed)?.name || '') : ''}` : focusFeed ? (focusFeed === 'adhoc' ? adhoc?.name : `TOP · ${feeds.find((f) => f.id === focusFeed)?.name || ''}`) : 'NEWS CENTER'}
          </span>
          <span className="range-btns" style={{ marginRight: 12 }}>
            <button className={`table-toggle ${rank === 'time' ? 'on' : ''}`} onClick={() => setRank('time')}>LATEST</button>
            <button className={`table-toggle ${rank === 'coverage' ? 'on' : ''}`} onClick={() => setRank('coverage')}>MOST COVERED</button>
            {focusFeed && <button className="table-toggle on" onClick={() => setFocusFeed(null)}>ALL FEEDS ✕</button>}
          </span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="news-center">
          <aside className="news-feeds">
            <div className="panel-title">FEEDS</div>
            {feeds.map((f) => {
              const r = results[f.id]
              const off = prefs.disabled.includes(f.id)
              return (
                <div key={f.id} className={`feed-row ${off ? 'off' : ''}`}>
                  <label>
                    <input type="checkbox" checked={!off} onChange={() => toggleFeed(f.id)} />
                    <span>{f.name}</span>
                  </label>
                  <span className="feed-meta">
                    {r?.loading ? '…' : r?.err ? <span className="no" title={r.err}>ERR</span> : r ? r.articles.length : ''}
                    {f.custom && (
                      <button className="link-btn" title="remove feed" onClick={() => removeFeed(f.id)}>✕</button>
                    )}
                  </span>
                </div>
              )
            })}

            <div className="panel-title" style={{ marginTop: 10 }}>ADD RSS FEED</div>
            <div className="add-feed">
              <input placeholder="NAME (e.g. WSJ)" value={newName} onChange={(e) => setNewName(e.target.value)} spellCheck={false} />
              <input placeholder="https://…/rss.xml" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} spellCheck={false} />
              <button className="submit yes" disabled={adding} onClick={addFeed}>
                {adding ? 'CHECKING…' : '+ ADD'}
              </button>
              {addErr && <div className="err-text">{addErr}</div>}
              <div className="dim small">any RSS or Atom URL works — it's validated before saving · stored in this browser</div>
            </div>
          </aside>

          <main className="news-stream">
            <div className="news-toolbar">
              <input
                className="pf-search"
                placeholder="FILTER HEADLINES…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                spellCheck={false}
              />
              <button className="table-toggle" onClick={() => setReloadTick((k) => k + 1)}>⟳ REFRESH</button>
              <span className="dim small">{stream.length} headlines · auto-refresh 5m</span>
            </div>
            <div className="news-list news-list-tall">
              {stream.map((a, i) => (
                <a key={i} className="news-item" href={a.link} target="_blank" rel="noreferrer">
                  <span className="news-title">{a.title}</span>
                  <span className="news-meta dim">
                    <span className="tag" style={{ marginRight: 6 }}>{a.feed}</span>
                    {a.source ? `${a.source} · ` : ''}{a.pubDate ? `${ago(a.pubDate)} ago` : ''}
                  </span>
                </a>
              ))}
              {stream.length === 0 && <div className="dim" style={{ padding: 14 }}>no headlines — enable a feed on the left</div>}
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
