// Bloomberg-style function-code registry. Every code from the "Getting
// Started" cheat-sheet maps to a Kalshi-terminal action; keyboard-only
// functions (Page Fwd/Back, Panel rotation, etc.) are re-expressed as commands.
//
// ctx is built by App and exposes: events, marketIndex, selected,
// setCategory, setSearch, selectTicker, open(kind, props), closeAll,
// marketTab(tab), openNews(opts), openPortfolio(tab), openSettings(quick),
// openChart(mode, range), openStrike, openField, openSpread, print, grab,
// squawk, watch(ticker, remove)

const CATEGORY_ALIASES = {
  NRG: 'Commodities', ENERGY: 'Commodities', COMMODITIES: 'Commodities',
  POL: 'Politics', POLITICS: 'Politics', ELECTIONS: 'Elections',
  ECON: 'Economics', ECONOMICS: 'Economics', FIN: 'Financials', FINANCIALS: 'Financials',
  CRYPTO: 'Crypto', SPORTS: 'Sports', ENT: 'Entertainment', ENTERTAINMENT: 'Entertainment',
  WEATHER: 'Climate and Weather', CLIMATE: 'Climate and Weather', SCI: 'Science and Technology',
  TECH: 'Science and Technology', COMPANIES: 'Companies', WORLD: 'World', HEALTH: 'Health',
}

export function resolveCategory(word, events) {
  if (!word) return null
  const up = word.toUpperCase()
  if (CATEGORY_ALIASES[up]) return CATEGORY_ALIASES[up]
  const cats = [...new Set(events.map((e) => e.category || 'Other'))]
  return cats.find((c) => c.toUpperCase().startsWith(up)) || null
}

const needSel = (ctx) => {
  if (!ctx.selected) {
    ctx.toast('select a market first (click a row, or type its ticker before the code)')
    return false
  }
  return true
}

export const COMMANDS = [
  // ---------- navigation / keyboard equivalents ----------
  { code: 'MAIN', group: 'NAVIGATION', desc: 'Main menu of all functions', run: (c) => c.open('main') },
  { code: 'HELP', group: 'NAVIGATION', usage: 'HELP <word or phrase>', desc: 'Search everything: markets, events, functions, news', run: (c, a) => c.open('help', { query: a.join(' ') }) },
  { code: 'MENU', aliases: ['BACK', 'ESC'], group: 'NAVIGATION', desc: 'Return to previous screen (close top window)', run: (c) => c.closeAll() },
  { code: 'PANEL', group: 'NAVIGATION', desc: 'Rotate among Launchpad panels', run: (c) => c.open('launchpad', { rotate: true }) },
  { code: 'PRINT', group: 'NAVIGATION', usage: 'PRINT', desc: 'Print the current screen', run: (c) => c.print() },
  { code: 'GRAB', group: 'NAVIGATION', desc: 'Copy a text snapshot of the current screen to the clipboard', run: (c) => c.grab() },
  { code: 'EASY', group: 'NAVIGATION', desc: 'Essential tips & shortcuts', run: (c) => c.open('main', { tab: 'easy' }) },
  { code: 'DOCS', group: 'NAVIGATION', usage: 'DOCS <topic>', desc: 'Search & read terminal documentation', run: (c, a) => c.open('main', { tab: 'docs', query: a.join(' ') }) },
  { code: 'TRAIN', aliases: ['CERT'], group: 'NAVIGATION', desc: 'Training walkthrough of every function', run: (c) => c.open('main', { tab: 'train' }) },
  { code: 'EXIT', aliases: ['LOGOFF', 'LOGOUT'], group: 'NAVIGATION', desc: 'Clear credentials (view-only mode)', run: (c) => c.openSettings(false) },

  // ---------- main menus (market sectors) ----------
  { code: 'NRG', group: 'SECTORS', desc: 'Energy: WTI/Brent/NatGas ladders + underlying desk', run: (c) => c.open('monitor', { kind: 'NRG' }) },
  { code: 'FXIP', group: 'SECTORS', desc: 'Foreign exchange: currency values + FX markets', run: (c) => c.open('monitor', { kind: 'WCV' }) },
  { code: 'IRSM', group: 'SECTORS', desc: 'Rates: treasury yields + Fed/rate markets', run: (c) => c.open('monitor', { kind: 'WB' }) },
  { code: 'BLAW', group: 'SECTORS', desc: 'Law & courts markets', run: (c) => { c.setCategory('All'); c.setSearch('court OR supreme OR law OR ruling') } },
  { code: 'BINS', group: 'SECTORS', desc: 'Insurance-relevant: climate & weather markets', run: (c) => c.setCategory('Climate and Weather') },
  { code: 'BEE', group: 'SECTORS', desc: 'Company earnings & corporate markets', run: (c) => c.setCategory('Companies') },
  { code: 'HYM', aliases: ['LOAN'], group: 'SECTORS', desc: 'Credit / financials markets', run: (c) => c.setCategory('Financials') },
  { code: 'MA', group: 'SECTORS', desc: 'Mergers & acquisitions markets', run: (c) => { c.setCategory('All'); c.setSearch('acqui OR merger OR buyout OR takeover') } },
  { code: 'FUND', group: 'SECTORS', desc: 'Funds & holdings: your positions', run: (c) => c.openPortfolio('positions') },
  { code: 'EMKT', group: 'SECTORS', desc: 'Emerging & world markets', run: (c) => c.setCategory('World') },
  { code: 'ET', aliases: ['TICKET', 'TRADE'], group: 'SECTORS', desc: 'Electronic trading: open the trade ticket on the selected market', run: (c) => needSel(c) && c.marketTab('ticket') },
  { code: 'OMS', group: 'SECTORS', desc: 'Order management: resting/executed orders', run: (c) => c.openPortfolio('orders') },
  { code: 'DATA', group: 'SECTORS', desc: 'Data services: export markets, history, portfolio as CSV/JSON', run: (c) => c.open('data') },
  { code: 'SPD', aliases: ['PING', 'LAT', 'DIAG', 'SPEED'], group: 'SECTORS', desc: 'Speed test: API, internet & price-feed latency + data staleness', run: (c) => c.open('diag') },

  // ---------- news ----------
  { code: 'N', aliases: ['NEWS'], group: 'NEWS', desc: 'Main news menu', run: (c) => c.openNews({}) },
  { code: 'TOP', group: 'NEWS', usage: 'TOP [category]', desc: "Today's top headlines (TOP DEAL, TOP NRG, TOP POL …)", run: (c, a) => c.openNews({ mode: 'top', category: a[0] }) },
  { code: 'READ', aliases: ['NRR'], group: 'NEWS', desc: 'Most popular: stories covered by the most sources', run: (c) => c.openNews({ mode: 'nrr' }) },
  { code: 'NI', group: 'NEWS', usage: 'NI <category words>', desc: 'News category search (NI OIL, NI HOT, NI US …)', run: (c, a) => c.openNews({ mode: 'ni', query: a.join(' ') }) },
  { code: 'TNI', group: 'NEWS', usage: 'TNI <cat1> <cat2>', desc: 'Dual news category search (both must match)', run: (c, a) => c.openNews({ mode: 'tni', query: a.join(' ') }) },
  { code: 'MNI', group: 'NEWS', usage: 'MNI <category>', desc: 'Most read stories within a category', run: (c, a) => c.openNews({ mode: 'mni', query: a.join(' ') }) },
  { code: 'NRC', group: 'NEWS', usage: 'NRC <name>', desc: 'Find/add a news wire by name (RSS)', run: (c, a) => c.openNews({ mode: 'nrc', query: a.join(' ') }) },
  { code: 'AV', aliases: ['LIVE', 'BBSQ', 'SQUAWK'], group: 'NEWS', desc: 'Squawk: read the top headlines aloud', run: (c) => c.squawk() },

  // ---------- broad market monitors & calendars ----------
  { code: 'WEI', group: 'MONITORS', desc: 'World equity indices', run: (c) => c.open('monitor', { kind: 'WEI' }) },
  { code: 'STK', aliases: ['EQTY', 'MEGA'], group: 'MONITORS', desc: 'US mega-cap equities: live quotes (AAPL, NVDA, TSLA …)', run: (c) => c.open('monitor', { kind: 'STK' }) },
  { code: 'SECT', aliases: ['ETF', 'SECM'], group: 'MONITORS', desc: 'US sector & broad-market ETFs (SPY, QQQ, XLK …)', run: (c) => c.open('monitor', { kind: 'SECT' }) },
  { code: 'WB', aliases: ['WS', 'IM'], group: 'MONITORS', desc: 'World govt bonds / rates / money-market', run: (c) => c.open('monitor', { kind: 'WB' }) },
  { code: 'WCV', group: 'MONITORS', desc: 'World currency values', run: (c) => c.open('monitor', { kind: 'WCV' }) },
  { code: 'CBQ', group: 'MONITORS', desc: 'Country/market overview across Kalshi categories', run: (c) => c.open('monitor', { kind: 'CBQ' }) },
  { code: 'IBQ', group: 'MONITORS', usage: 'IBQ <category>', desc: 'Industry (category) overview: movers, volume, expiries', run: (c, a) => c.open('monitor', { kind: 'IBQ', category: resolveCategory(a[0], c.events) || 'Commodities' }) },
  { code: 'ECST', group: 'MONITORS', desc: 'Economist statistics: market-implied economic numbers', run: (c) => c.open('monitor', { kind: 'ECST' }) },
  { code: 'WECO', group: 'MONITORS', usage: 'WECO [category]', desc: 'Economic/settlement calendar by day', run: (c, a) => c.open('monitor', { kind: 'WECO', category: resolveCategory(a[0], c.events) }) },

  // ---------- communication tools (re-expressed) ----------
  { code: 'MSGM', aliases: ['IB', 'MSG', 'NOTES'], group: 'COMMUNICATION', desc: 'Trading journal / notes (per market or general)', run: (c) => c.open('notes') },
  { code: 'SPDL', aliases: ['WATCH', 'WL'], group: 'COMMUNICATION', usage: 'SPDL [ticker]', desc: 'Watchlist: add the selected/given ticker', run: (c, a) => c.watch(a[0] || c.selected?.market?.ticker) },
  { code: 'UNWATCH', group: 'COMMUNICATION', usage: 'UNWATCH <ticker>', desc: 'Remove from watchlist', run: (c, a) => c.watch(a[0] || c.selected?.market?.ticker, true) },
  { code: 'ANY', aliases: ['BERRY', 'BBFO'], group: 'COMMUNICATION', desc: 'Remote access notes (how to run on a VPS / phone)', run: (c) => c.open('main', { tab: 'docs', query: 'remote' }) },

  // ---------- security analysis (selected market) ----------
  { code: 'DES', group: 'SECURITY', desc: 'Description: rules, adjudication, settlement sources', run: (c) => needSel(c) && c.open('security', { tab: 'DES' }) },
  { code: 'CN', group: 'SECURITY', desc: 'News for the selected market', run: (c) => needSel(c) && c.openNews({ mode: 'ni', query: c.marketKeywords() }) },
  { code: 'MCN', group: 'SECURITY', desc: 'Most popular news for the selected market', run: (c) => needSel(c) && c.openNews({ mode: 'mni', query: c.marketKeywords() }) },
  { code: 'MGMT', aliases: ['ISSD'], group: 'SECURITY', desc: 'Issuer info: series, event structure, expiries', run: (c) => needSel(c) && c.open('security', { tab: 'ISSD' }) },
  { code: 'GPO', aliases: ['GP'], group: 'SECURITY', desc: 'Price graph with open/high/low (candles)', run: (c) => needSel(c) && c.openChart('ohlc', '1W') },
  { code: 'GIP', group: 'SECURITY', desc: 'Intraday price graph', run: (c) => needSel(c) && c.openChart('line', '1D') },
  { code: 'GY', group: 'SECURITY', desc: 'Yield graph: annualized hold-to-settle return over time', run: (c) => needSel(c) && c.open('security', { tab: 'GY' }) },
  { code: 'PHDC', group: 'SECURITY', desc: 'Holders: open interest, tape, taker flow', run: (c) => needSel(c) && c.open('security', { tab: 'PHDC' }) },
  { code: 'ANR', group: 'SECURITY', desc: 'Model recommendations: consensus of the terminal\'s models', run: (c) => needSel(c) && c.open('security', { tab: 'ANR' }) },
  { code: 'EM', group: 'SECURITY', desc: 'Expected-value matrix across the event ladder', run: (c) => needSel(c) && c.open('security', { tab: 'EM' }) },
  { code: 'RV', aliases: ['CRVD'], group: 'SECURITY', desc: 'Relative value vs peer strikes', run: (c) => needSel(c) && c.open('security', { tab: 'RV' }) },
  { code: 'FA', group: 'SECURITY', desc: 'Financial analysis: Kelly, breakeven, P&L scenarios', run: (c) => needSel(c) && c.open('security', { tab: 'FA' }) },
  { code: 'YAS', group: 'SECURITY', desc: 'Yield & spread calculator', run: (c) => needSel(c) && c.open('security', { tab: 'YAS' }) },
  { code: 'ALLQ', group: 'SECURITY', desc: 'All quotes: full order book depth + last trades', run: (c) => needSel(c) && c.open('security', { tab: 'ALLQ' }) },
  { code: 'DDIS', group: 'SECURITY', desc: 'Distribution: volume & open interest across strikes', run: (c) => needSel(c) && c.open('security', { tab: 'DDIS' }) },
  { code: 'CRPR', group: 'SECURITY', desc: 'Credit profile: settlement history & base rates for this series', run: (c) => needSel(c) && c.open('security', { tab: 'CRPR' }) },

  // ---------- terminal-native tools ----------
  { code: 'ANALYZE', aliases: ['STRIKE', 'SMILE'], group: 'ANALYSIS', desc: 'Strike analysis: probability curve, IV smile, Kelly shading', run: (c) => needSel(c) && c.openStrike() },
  { code: 'FIELD', group: 'ANALYSIS', desc: 'Field analysis: joint distribution, correlations', run: (c) => needSel(c) && c.openField() },
  { code: 'SPREAD', group: 'ANALYSIS', desc: 'Spread tool: pick YES + NO legs', run: (c) => needSel(c) && c.openSpread() },
  { code: 'CHART', group: 'ANALYSIS', desc: 'Price chart of the selected market', run: (c) => needSel(c) && c.openChart('line', '1W') },
  { code: 'MARKOV', group: 'ANALYSIS', desc: 'Markov chain move probabilities (commodity desk)', run: (c) => { c.setCategory('Commodities'); c.toast('open ⛓ MARKOV in the commodity desk') } },
  { code: 'PORT', aliases: ['PORTFOLIO', 'POS'], group: 'ANALYSIS', desc: 'Portfolio', run: (c) => c.openPortfolio('summary') },
  { code: 'REPORT', group: 'ANALYSIS', desc: 'Daily trading performance report', run: (c) => c.openPortfolio('report') },

  // ---------- customization ----------
  { code: 'PDFQ', group: 'SETUP', desc: 'Personal defaults — quick setup', run: (c) => c.openSettings(true) },
  { code: 'PDF', aliases: ['SET', 'SETUP'], group: 'SETUP', desc: 'Personal defaults — full setup (API, exchange, preferences)', run: (c) => c.openSettings(false) },
  { code: 'BLP', aliases: ['LAUNCHPAD'], group: 'SETUP', desc: 'Launchpad: customizable multi-panel monitor of your watchlist', run: (c) => c.open('launchpad') },

  // ---------- category jump ----------
  { code: 'CAT', aliases: ['SECTOR'], group: 'NAVIGATION', usage: 'CAT <category>', desc: 'Jump to a market category', run: (c, a) => { const cat = resolveCategory(a[0], c.events); if (cat) c.setCategory(cat); else c.toast('unknown category') } },
]

const INDEX = new Map()
for (const cmd of COMMANDS) {
  INDEX.set(cmd.code, cmd)
  for (const a of cmd.aliases || []) INDEX.set(a, cmd)
}

export function findCommand(code) {
  return INDEX.get(String(code || '').toUpperCase()) || null
}

export function suggest(input, limit = 8) {
  const q = input.trim().toUpperCase().split(/\s+/)[0] || ''
  if (!q) return COMMANDS.slice(0, limit)
  const scored = COMMANDS.map((cmd) => {
    const names = [cmd.code, ...(cmd.aliases || [])]
    let s = 0
    if (names.some((n) => n === q)) s = 3
    else if (names.some((n) => n.startsWith(q))) s = 2
    else if (cmd.desc.toUpperCase().includes(q)) s = 1
    return [s, cmd]
  }).filter(([s]) => s > 0)
  scored.sort((a, b) => b[0] - a[0])
  return scored.slice(0, limit).map(([, c]) => c)
}

// Parse "CODE args…" or Bloomberg-style "TICKER CODE args…"; unknown text
// becomes a HELP search.
export function runCommand(input, ctx) {
  const tokens = input.trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return
  let t = tokens
  // ticker-first syntax: "KXWTI-26AUG0414-T77.49 GPO"
  if (ctx.marketIndex?.has(t[0].toUpperCase())) {
    ctx.selectTicker(t[0].toUpperCase())
    t = t.slice(1)
    if (!t.length) return
  }
  const cmd = findCommand(t[0])
  if (!cmd) {
    ctx.open('help', { query: input.trim() })
    return
  }
  cmd.run(ctx, t.slice(1))
}
