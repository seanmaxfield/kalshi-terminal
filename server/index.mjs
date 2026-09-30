// Kalshi API proxy.
// - Forwards /api/* to the Kalshi trade API (prod or demo).
// - Signs requests with your RSA API key when one is configured, which
//   unlocks the authenticated endpoints (portfolio, orders).
// Keys are read from .env / environment and never leave this machine
// except in signed request headers to Kalshi itself.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '..', '.env') })

const PORT = process.env.KALSHI_PROXY_PORT || 8787
const API_PREFIX = '/trade-api/v2'
const ENV_FILE = path.join(__dirname, '..', '.env')
const MANAGED_KEY_FILE = path.join(__dirname, '..', '.kalshi-key.pem')

// Mutable config — editable at runtime via /api/_settings, persisted to .env.
const cfg = {
  env: (process.env.KALSHI_ENV || 'prod').toLowerCase(),
  keyId: process.env.KALSHI_API_KEY_ID || '',
  privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH || '',
  privateKey: '',
  keyError: null,
}

function loadPrivateKey() {
  cfg.privateKey = ''
  cfg.keyError = null
  if (!cfg.privateKeyPath) return
  try {
    const pem = fs.readFileSync(cfg.privateKeyPath, 'utf8')
    // validate by test-signing
    crypto.sign('sha256', Buffer.from('test'), {
      key: pem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    cfg.privateKey = pem
  } catch (e) {
    cfg.keyError = e.message
    console.error(`Private key problem (${cfg.privateKeyPath}): ${e.message}`)
  }
}
loadPrivateKey()

const baseUrl = () =>
  cfg.env === 'demo' ? 'https://demo-api.kalshi.co' : 'https://api.elections.kalshi.com'
const authReady = () => Boolean(cfg.keyId && cfg.privateKey)

function persistEnvFile() {
  const lines = [
    `KALSHI_ENV=${cfg.env}`,
    `KALSHI_API_KEY_ID=${cfg.keyId}`,
    `KALSHI_PRIVATE_KEY_PATH=${cfg.privateKeyPath}`,
    '',
  ]
  fs.writeFileSync(ENV_FILE, lines.join('\n'))
}

function signRequest(method, fullPath) {
  const ts = Date.now().toString()
  const message = ts + method + fullPath
  const signature = crypto
    .sign('sha256', Buffer.from(message, 'utf8'), {
      key: cfg.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString('base64')
  return {
    'KALSHI-ACCESS-KEY': cfg.keyId,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': ts,
  }
}

const app = express()
app.use(express.json())

// Lets the frontend show whether trading is enabled and which env is live.
app.get('/api/_config', (_req, res) => {
  res.json({ env: cfg.env, authConfigured: authReady() })
})

// ---------- settings: view / change / reset credentials ----------
// The private key CONTENTS are never returned — only its path and status.
app.get('/api/_settings', (_req, res) => {
  res.json({
    env: cfg.env,
    keyId: cfg.keyId,
    privateKeyPath: cfg.privateKeyPath,
    keyFileOk: Boolean(cfg.privateKey),
    keyError: cfg.keyError,
    authConfigured: authReady(),
    managedKeyFile: MANAGED_KEY_FILE,
  })
})

app.post('/api/_settings', (req, res) => {
  const { env, keyId, privateKeyPath, privateKeyPem, reset } = req.body || {}
  try {
    if (reset) {
      cfg.keyId = ''
      cfg.privateKeyPath = ''
      cfg.privateKey = ''
      cfg.keyError = null
      if (fs.existsSync(MANAGED_KEY_FILE)) fs.unlinkSync(MANAGED_KEY_FILE)
      persistEnvFile()
      return res.json({ ok: true, authConfigured: false, env: cfg.env })
    }
    if (env !== undefined) {
      const e = String(env).toLowerCase()
      if (!['prod', 'demo'].includes(e)) return res.status(400).json({ error: 'env must be prod or demo' })
      cfg.env = e
    }
    if (keyId !== undefined) cfg.keyId = String(keyId).trim()
    if (privateKeyPem) {
      // validate before saving
      crypto.sign('sha256', Buffer.from('test'), {
        key: privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      })
      fs.writeFileSync(MANAGED_KEY_FILE, privateKeyPem, { mode: 0o600 })
      cfg.privateKeyPath = MANAGED_KEY_FILE
    } else if (privateKeyPath !== undefined) {
      cfg.privateKeyPath = String(privateKeyPath).trim()
    }
    loadPrivateKey()
    persistEnvFile()
    res.json({
      ok: true,
      env: cfg.env,
      keyId: cfg.keyId,
      privateKeyPath: cfg.privateKeyPath,
      keyFileOk: Boolean(cfg.privateKey),
      keyError: cfg.keyError,
      authConfigured: authReady(),
    })
  } catch (e) {
    res.status(400).json({ error: 'invalid_settings', message: e.message })
  }
})

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }

// Underlying commodity prices via Yahoo Finance chart API (no key required).
app.get('/api/_underlying/chart', async (req, res) => {
  const { symbol, range = '1mo', interval = '1d' } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`
    const r = await fetch(url, { headers: UA })
    const j = await r.json()
    const result = j?.chart?.result?.[0]
    if (!result) return res.status(502).json({ error: 'no_data', detail: j?.chart?.error })
    const q = result.indicators?.quote?.[0] || {}
    const bars = (result.timestamp || [])
      .map((t, i) => ({
        t,
        open: q.open?.[i] ?? null,
        high: q.high?.[i] ?? null,
        low: q.low?.[i] ?? null,
        close: q.close?.[i] ?? null,
        volume: q.volume?.[i] ?? null,
      }))
      .filter((b) => b.close !== null)
    res.json({ meta: result.meta, bars })
  } catch (e) {
    res.status(502).json({ error: 'upstream_error', message: e.message })
  }
})

// Exchange reference quote via TradingView's public scanner (10-min delayed).
// These are the CME/NYMEX/COMEX/ICE symbols that commodity adjudication
// actually references — quotes only, no free history.
app.get('/api/_underlying/quote', async (req, res) => {
  const { symbol } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  try {
    const url = `https://scanner.tradingview.com/symbol?symbol=${encodeURIComponent(symbol)}&fields=close,change,description,update_mode`
    const r = await fetch(url, { headers: UA })
    const j = await r.json()
    if (j.close === null || j.close === undefined)
      return res.status(502).json({ error: 'no_quote', message: `no quote for ${symbol}` })
    res.json({
      symbol,
      price: j.close,
      changePct: j.change ?? null,
      description: j.description || symbol,
      delayed: /delayed/.test(j.update_mode || ''),
    })
  } catch (e) {
    res.status(502).json({ error: 'upstream_error', message: e.message })
  }
})

// Batch quotes for the market monitors (WEI / WB / WCV / NRG …): fans out to
// Yahoo's chart endpoint per symbol and returns last / previous close / name.
app.get('/api/_monitor/quotes', async (req, res) => {
  const symbols = String(req.query.symbols || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 40)
  if (!symbols.length) return res.status(400).json({ error: 'symbols required' })
  const one = async (symbol) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`
      const r = await fetch(url, { headers: UA })
      const j = await r.json()
      const meta = j?.chart?.result?.[0]?.meta
      if (!meta) return { symbol, error: 'no data' }
      const closes = (j.chart.result[0].indicators?.quote?.[0]?.close || []).filter((c) => c !== null)
      const price = meta.regularMarketPrice ?? closes[closes.length - 1] ?? null
      const prev = meta.chartPreviousClose ?? meta.previousClose ?? (closes.length > 1 ? closes[closes.length - 2] : null)
      return {
        symbol,
        name: meta.shortName || meta.longName || symbol,
        price,
        prevClose: prev,
        changePct: price !== null && prev ? ((price - prev) / prev) * 100 : null,
        currency: meta.currency,
        time: meta.regularMarketTime,
        hi52: meta.fiftyTwoWeekHigh ?? null,
        lo52: meta.fiftyTwoWeekLow ?? null,
      }
    } catch (e) {
      return { symbol, error: e.message }
    }
  }
  res.json({ quotes: await Promise.all(symbols.map(one)) })
})

// ---------- RSS / Atom parsing (shared by news endpoints) ----------
function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/<[^>]+>/g, '') // strip stray inner markup from titles
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .trim()
}

function parseFeedXml(xml) {
  const pick = (block, tag) => {
    const mm = block.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's'))
    return mm ? decodeXml(mm[1]) : null
  }
  // feed-level title = first <title> outside items
  const headXml = xml.split(/<item[\s>]|<entry[\s>]/)[0]
  const feedTitle = pick(headXml, 'title')

  const rssItems = [...xml.matchAll(/<item[\s>](.*?)<\/item>/gs)].map((m) => {
    const it = m[1]
    return {
      title: pick(it, 'title'),
      link: pick(it, 'link'),
      pubDate: pick(it, 'pubDate') || pick(it, 'dc:date'),
      source: pick(it, 'source'),
    }
  })
  const atomEntries = [...xml.matchAll(/<entry[\s>](.*?)<\/entry>/gs)].map((m) => {
    const it = m[1]
    const linkHref = it.match(/<link[^>]*href="([^"]+)"/)
    return {
      title: pick(it, 'title'),
      link: linkHref ? decodeXml(linkHref[1]) : pick(it, 'link'),
      pubDate: pick(it, 'published') || pick(it, 'updated'),
      source: null,
    }
  })
  return {
    feedTitle,
    articles: [...rssItems, ...atomEntries].filter((a) => a.title).slice(0, 40),
  }
}

// Commodity news scraper: Google News RSS -> JSON headlines.
app.get('/api/_underlying/news', async (req, res) => {
  const { q } = req.query
  if (!q) return res.status(400).json({ error: 'q required' })
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`
    const r = await fetch(url, { headers: UA })
    const { articles } = parseFeedXml(await r.text())
    res.json({ articles })
  } catch (e) {
    res.status(502).json({ error: 'upstream_error', message: e.message })
  }
})

// Generic feed fetcher for the central news hub — any RSS or Atom URL.
app.get('/api/_news/fetch', async (req, res) => {
  const { url } = req.query
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'valid http(s) url required' })
  try {
    const r = await fetch(url, { headers: { ...UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } })
    if (!r.ok) return res.status(502).json({ error: 'feed_error', message: `upstream HTTP ${r.status}` })
    const { feedTitle, articles } = parseFeedXml(await r.text())
    if (articles.length === 0) return res.status(422).json({ error: 'no_items', message: 'no RSS/Atom items found at that URL' })
    res.json({ feedTitle, articles })
  } catch (e) {
    res.status(502).json({ error: 'upstream_error', message: e.message })
  }
})

app.all(/^\/api\/(.*)/, async (req, res) => {
  const subPath = '/' + req.params[0]
  const apiPath = API_PREFIX + subPath
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  const url = baseUrl() + apiPath + qs

  const needsAuth = subPath.startsWith('/portfolio')
  if (needsAuth && !authReady()) {
    return res.status(401).json({
      error: 'no_api_key',
      message:
        'No Kalshi API key configured. Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH in kalshi-terminal/.env (see .env.example).',
    })
  }

  const headers = { Accept: 'application/json' }
  // Signature covers timestamp + method + path (no query string).
  if (authReady()) Object.assign(headers, signRequest(req.method, apiPath))

  const init = { method: req.method, headers }
  if (!['GET', 'HEAD'].includes(req.method)) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(req.body ?? {})
  }

  try {
    const upstream = await fetch(url, init)
    const text = await upstream.text()
    res.status(upstream.status)
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/json')
    res.send(text)
  } catch (e) {
    res.status(502).json({ error: 'upstream_error', message: e.message })
  }
})

app.listen(PORT, () => {
  console.log(`[kalshi-proxy] ${cfg.env} → ${baseUrl()}  (auth: ${authReady() ? 'configured' : 'not configured — market data only'})`)
  console.log(`[kalshi-proxy] listening on http://localhost:${PORT}`)
})
