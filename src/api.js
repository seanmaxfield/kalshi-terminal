// Thin client for the local proxy. All paths mirror Kalshi trade-api/v2.

export async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  if (!res.ok) {
    const msg = data?.message || data?.error?.message || data?.error || `HTTP ${res.status}`
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

// Kalshi now returns dollar-string fields ("0.1300"). Normalize to cents (int) or null.
export function cents(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'string' ? parseFloat(v) : v
  if (Number.isNaN(n)) return null
  return Math.round(n * 100)
}

export function num(v) {
  if (v === null || v === undefined || v === '') return 0
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isNaN(n) ? 0 : n
}

export function fmtCents(c) {
  return c === null ? '—' : `${c}¢`
}

export function fmtMoney(centsInt) {
  if (centsInt === null || centsInt === undefined) return '—'
  return (centsInt / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export function fmtCompact(n) {
  if (n === null || n === undefined) return '—'
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

// Pull every open event (with nested markets), page by page.
// onPage receives the accumulated event array after each page so the UI
// can render progressively.
export async function loadAllEvents(onPage, signal) {
  let cursor = ''
  const all = []
  do {
    const q = new URLSearchParams({ limit: '200', status: 'open', with_nested_markets: 'true' })
    if (cursor) q.set('cursor', cursor)
    const data = await api(`/events?${q.toString()}`)
    if (signal?.aborted) return all
    all.push(...(data.events || []))
    onPage([...all], Boolean(data.cursor))
    cursor = data.cursor || ''
  } while (cursor)
  return all
}
