import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { COMMANDS, findCommand } from '../lib/commands.js'

const GROUP_ORDER = ['NAVIGATION', 'SECTORS', 'NEWS', 'MONITORS', 'SECURITY', 'ANALYSIS', 'COMMUNICATION', 'SETUP']

const TIPS = [
  ['/', 'or Ctrl/⌘-K focuses the command line from anywhere'],
  ['Esc', 'is MENU — closes the top window'],
  ['TICKER CODE', 'Bloomberg ticker-first syntax works: "KXWTI-26AUG0414-T77.49 GPO"'],
  ['Any words', 'that are not a function code run a HELP search across markets, functions and news'],
  ['Click a row', 'to select a market; every SECURITY function (DES YAS ANR GPO …) then acts on it'],
  ['NRG · FXIP · IRSM', 'jump straight to sector monitors with live underlying quotes'],
  ['SPDL', 'adds the selected market to the watchlist; BLP shows the Launchpad; PANEL rotates focus'],
  ['GRAB', 'copies a text snapshot of what you are looking at; PRINT prints it'],
  ['PDFQ / PDF', 'set personal defaults: default category, refresh rate, strike decimals, chart range'],
  ['DATA', 'exports anything on screen to CSV/JSON'],
]

const DOCS = [
  { key: 'commands', title: 'Function codes', body: 'Every code from the Bloomberg Getting Started cheat-sheet is mapped to a terminal action. Type MAIN for the grouped menu, HELP <words> to search. Keyboard-only Bloomberg keys (Page Fwd/Back, Panel, Print, Grab) are commands here.' },
  { key: 'security', title: 'Security analysis (per selected market)', body: 'DES rules & adjudication · YAS yield/spread calculator (hold-to-settle return, annualized, fee-adjusted, breakeven) · GY yield history · ANR model consensus (lognormal edge, neighbor value, Markov drift, Kelly) · EM expected-value matrix across the ladder · RV relative value vs peer strikes · FA scenario P&L and Kelly · ALLQ full book + tape · DDIS volume/OI by strike · CRPR settlement base rates for the series · PHDC holders/flow · ISSD series structure · CN/MCN news.' },
  { key: 'monitors', title: 'Market monitors', body: 'WEI world equity indices · WB/WS/IM rates & bonds · WCV currencies · NRG energy · CBQ overview of all Kalshi categories · IBQ <category> deep dive (movers, volume, expiries) · ECST market-implied economic statistics · WECO settlement calendar. Underlying quotes come from a free delayed feed; Kalshi markets are live.' },
  { key: 'news', title: 'News', body: 'N news center · TOP [cat] top headlines · READ/NRR most-covered stories (ranked by how many sources carry them) · NI <cat> category search · TNI a b both categories · MNI <cat> most read in category · NRC <name> find/add a wire · AV/LIVE/BBSQ squawk reads headlines aloud.' },
  { key: 'remote', title: 'Remote access (ANY / BERRY)', body: 'The terminal is a local web app: run it on an always-on machine (a $4/mo VPS or a home Pi) and open it from any browser or phone. See research/bot/README for the VPS install recipe. Never expose the proxy port publicly without a password/VPN — it signs with your API key.' },
  { key: 'trading', title: 'Trading & risk', body: 'ET opens the ticket; every order shows dollars-at-risk before CONFIRM. OMS lists resting orders. FUND/PORT positions with parlay what-if and SELL-to-close. REPORT gives the daily P&L with pending outcomes. Kelly sizing is in the ticket and FA.' },
  { key: 'strategy', title: 'Research & strategy', body: 'research/STRATEGY.md holds the backtests: band spreads on commodity ladders, KNN-filtered hourly entries, lockbox. research/bot is the demo-first auto-trader. Retrain with backtest.py collect + backtest3.py.' },
]

export default function MainMenu({ tab: initialTab = 'main', query = '', ctx, onClose }) {
  const [tab, setTab] = useState(initialTab)
  const [q, setQ] = useState(query)
  const [news, setNews] = useState({ loading: false, items: [] })

  useEffect(() => { setTab(initialTab); setQ(query) }, [initialTab, query])

  // HELP: news leg of the search
  useEffect(() => {
    if (tab !== 'help' || !q.trim()) { setNews({ loading: false, items: [] }); return }
    let live = true
    setNews({ loading: true, items: [] })
    api(`/_underlying/news?q=${encodeURIComponent(q)}`)
      .then((d) => live && setNews({ loading: false, items: (d.articles || []).slice(0, 8) }))
      .catch(() => live && setNews({ loading: false, items: [] }))
    return () => { live = false }
  }, [tab, q])

  const helpResults = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return { cmds: [], markets: [] }
    const cmds = COMMANDS.filter((c) =>
      c.code.toLowerCase().includes(s) || (c.aliases || []).some((a) => a.toLowerCase().includes(s)) || c.desc.toLowerCase().includes(s)
    ).slice(0, 8)
    const markets = []
    for (const ev of ctx.events) {
      const evHit = ev.title?.toLowerCase().includes(s) || ev.event_ticker?.toLowerCase().includes(s) || ev.series_ticker?.toLowerCase().includes(s)
      for (const m of ev.markets || []) {
        if (evHit || m.ticker?.toLowerCase().includes(s) || m.yes_sub_title?.toLowerCase().includes(s)) {
          markets.push({ ev, m })
          if (markets.length >= 25) break
        }
      }
      if (markets.length >= 25) break
    }
    return { cmds, markets }
  }, [q, ctx.events])

  const run = (code) => { onClose(); setTimeout(() => findCommand(code)?.run(ctx, []), 0) }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">
            {tab === 'main' ? 'MAIN MENU' : tab === 'help' ? 'HELP · SEARCH EVERYTHING' : tab === 'easy' ? 'EASY · TIPS & SHORTCUTS' : tab === 'docs' ? 'DOCS' : 'TRAIN · WALKTHROUGH'}
          </span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="tabs">
          {[['main', 'MAIN'], ['help', 'HELP'], ['easy', 'EASY'], ['docs', 'DOCS'], ['train', 'TRAIN']].map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>

        {tab === 'main' && (
          <div className="menu-grid">
            {GROUP_ORDER.map((g) => (
              <div key={g} className="menu-group">
                <div className="panel-title">{g}</div>
                {COMMANDS.filter((c) => c.group === g).map((c) => (
                  <button key={c.code} className="menu-row" onClick={() => run(c.code)} title={c.usage || c.code}>
                    <span className="cmd-code">{c.code}</span>
                    <span className="menu-desc">{c.desc}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}

        {tab === 'help' && (
          <div className="help-body">
            <input
              className="pf-search"
              style={{ width: '100%', marginBottom: 8 }}
              placeholder="A market · a ticker · a subject (Volatility) · a function…"
              value={q}
              autoFocus
              onChange={(e) => setQ(e.target.value)}
              spellCheck={false}
            />
            {!q.trim() && <div className="dim small">type anything — results span function codes, Kalshi markets and news</div>}
            {helpResults.cmds.length > 0 && (
              <>
                <div className="panel-title">FUNCTIONS</div>
                {helpResults.cmds.map((c) => (
                  <button key={c.code} className="menu-row" onClick={() => run(c.code)}>
                    <span className="cmd-code">{c.code}</span><span className="menu-desc">{c.desc}</span>
                  </button>
                ))}
              </>
            )}
            {helpResults.markets.length > 0 && (
              <>
                <div className="panel-title">MARKETS ({helpResults.markets.length}{helpResults.markets.length >= 25 ? '+' : ''})</div>
                <table className="mini-table">
                  <tbody>
                    {helpResults.markets.map(({ ev, m }) => (
                      <tr key={m.ticker} className="pf-row" onClick={() => { ctx.selectTicker(m.ticker); onClose() }}>
                        <td className="pf-name">{ev.title}</td>
                        <td>{m.yes_sub_title || m.ticker}</td>
                        <td className="dim">{m.ticker}</td>
                        <td className="yes">{m.yes_ask_dollars ? Math.round(parseFloat(m.yes_ask_dollars) * 100) + '¢' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            {(news.loading || news.items.length > 0) && (
              <>
                <div className="panel-title">NEWS</div>
                {news.loading && <div className="dim small">searching wires…</div>}
                <div className="news-list">
                  {news.items.map((a, i) => (
                    <a key={i} className="news-item" href={a.link} target="_blank" rel="noreferrer">
                      <span className="news-title">{a.title}</span>
                      <span className="news-meta dim">{a.source || ''}</span>
                    </a>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'easy' && (
          <table className="mini-table" style={{ margin: '8px 0 14px' }}>
            <tbody>
              {TIPS.map(([k, v]) => (
                <tr key={k}><td className="cmd-code" style={{ whiteSpace: 'nowrap' }}>{k}</td><td>{v}</td></tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'docs' && (
          <div className="help-body">
            <input className="pf-search" style={{ width: '100%', marginBottom: 8 }} placeholder="DOCS <topic>" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
            {DOCS.filter((d) => !q.trim() || (d.title + d.body + d.key).toLowerCase().includes(q.toLowerCase())).map((d) => (
              <div key={d.key} className="doc-block">
                <div className="panel-title">{d.title}</div>
                <div className="doc-body">{d.body}</div>
              </div>
            ))}
          </div>
        )}

        {tab === 'train' && (
          <ol className="train-list">
            <li>Type <b>WEI</b> — world indices. Then <b>NRG</b> — the energy desk with WTI/Brent/NatGas and the related Kalshi ladders.</li>
            <li>Click any market row. Type <b>DES</b> (rules), <b>YAS</b> (yield to settlement), <b>ANR</b> (what the models think).</li>
            <li><b>GPO</b> for candles, <b>GIP</b> intraday, <b>GY</b> for the yield history. <b>ALLQ</b> for the whole book.</li>
            <li><b>RV</b> compares the strike with its peers; <b>EM</b> is the EV matrix; <b>CRPR</b> shows how this series has actually settled.</li>
            <li><b>ET</b> opens the ticket — every order shows the dollars at risk before CONFIRM. <b>OMS</b> for resting orders, <b>FUND</b> for positions.</li>
            <li><b>SPDL</b> puts the market on your watchlist; <b>BLP</b> shows the Launchpad; <b>WECO</b> is the settlement calendar.</li>
            <li><b>TOP NRG</b>, <b>NI OIL</b>, <b>NRR</b> for news; <b>BBSQ</b> reads it to you.</li>
            <li><b>DATA</b> exports; <b>GRAB</b> copies; <b>PDFQ</b> sets your defaults. Esc closes anything.</li>
          </ol>
        )}
      </div>
    </div>
  )
}
