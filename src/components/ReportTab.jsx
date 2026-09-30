import React, { useEffect, useMemo, useState } from 'react'
import { api, cents, fmtMoney, num } from '../api.js'

const dollars = (v) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`

function localDayBounds(dateStr) {
  const start = new Date(`${dateStr}T00:00:00`)
  const end = new Date(start.getTime() + 24 * 3600e3)
  return [start.getTime(), end.getTime()]
}

// Page through an endpoint until items get older than dayStart (newest-first).
async function fetchDay(path, listKey, timeKey, dayStart, dayEnd) {
  let cursor = ''
  const out = []
  for (let page = 0; page < 12; page++) {
    const q = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
    const d = await api(`${path}?limit=200${q}`)
    const items = d[listKey] || []
    let sawOlder = false
    for (const it of items) {
      const t = new Date(it[timeKey]).getTime()
      if (t >= dayStart && t < dayEnd) out.push(it)
      if (t < dayStart) sawOlder = true
    }
    cursor = d.cursor || ''
    if (!cursor || sawOlder) break
  }
  return out
}

function computeReport(fills, settlements) {
  const fillPx = (f) => cents(f.side === 'yes' ? f.yes_price_dollars ?? f.yes_price : f.no_price_dollars ?? f.no_price) ?? 0
  const ct = (f) => num(f.count_fp ?? f.count)

  let buyCost = 0, sellProceeds = 0, fillFees = 0, contracts = 0, takerN = 0
  const byMarket = new Map()
  const mk = (ticker) => {
    if (!byMarket.has(ticker))
      byMarket.set(ticker, { ticker, fills: 0, bought: 0, sold: 0, fees: 0, settledNet: null, result: null })
    return byMarket.get(ticker)
  }
  for (const f of fills) {
    const cost = (ct(f) * fillPx(f)) / 100 // dollars
    const m = mk(f.ticker)
    m.fills++
    m.fees += num(f.fee_cost)
    fillFees += num(f.fee_cost)
    contracts += ct(f)
    if (f.is_taker) takerN++
    if (f.action === 'buy') { buyCost += cost; m.bought += ct(f) }
    else { sellProceeds += cost; m.sold += ct(f) }
  }

  let settleNet = 0, settleFees = 0, payout = 0, wins = 0, losses = 0
  let bigWin = null, bigLoss = null
  for (const x of settlements) {
    const pay = num(x.revenue) / 100 // authoritative settlement credit (cents)
    const cost = num(x.yes_total_cost_dollars) + num(x.no_total_cost_dollars)
    const net = pay - cost - num(x.fee_cost)
    payout += pay
    settleFees += num(x.fee_cost)
    settleNet += net
    if (net >= 0) wins++
    else losses++
    if (bigWin === null || net > bigWin.net) bigWin = { ticker: x.ticker, net }
    if (bigLoss === null || net < bigLoss.net) bigLoss = { ticker: x.ticker, net }
    const m = mk(x.ticker)
    m.settledNet = (m.settledNet ?? 0) + net
    m.result = x.market_result
  }

  return {
    fills: fills.length,
    contracts,
    takerShare: fills.length ? takerN / fills.length : null,
    buyCost,
    sellProceeds,
    fillFees,
    settlements: settlements.length,
    wins,
    losses,
    payout,
    settleFees,
    settleNet,
    netCashFlow: payout + sellProceeds - buyCost - fillFees,
    byMarket: [...byMarket.values()].sort((a, b) => (b.settledNet ?? 0) - (a.settledNet ?? 0)),
    bigWin,
    bigLoss,
  }
}

// Everything still open: positions scored by CONTRACT OUTCOME —
// win = $1 × contracts − cost basis; lose = −cost basis.
function buildOpenPositions(positions) {
  const open = []
  for (const p of positions) {
    const posCt = p.position ?? num(p.position_fp)
    if (!posCt) continue
    // exposure may arrive as cents int (market_exposure) or dollar string
    const exposure =
      p.market_exposure_dollars !== undefined ? num(p.market_exposure_dollars) : num(p.market_exposure) / 100
    const maxPayout = Math.abs(posCt)
    open.push({
      ticker: p.ticker,
      posCt,
      exposure,
      ifWin: maxPayout - exposure,
      ifLose: -exposure,
      maxPayout,
    })
  }
  return open
}

function aggregatePending(open, orders) {
  let committed = 0
  for (const o of orders) {
    const rem = num(o.remaining_count_fp ?? o.remaining_count)
    const px = cents(o.yes_price_dollars ?? o.no_price_dollars) ?? o.yes_price ?? o.no_price ?? 0
    if (o.action === 'buy') committed += (rem * px) / 100
  }
  return {
    open,
    nOpen: open.length,
    atRisk: open.reduce((s, p) => s + p.exposure, 0),
    ifAllWin: open.reduce((s, p) => s + p.ifWin, 0),
    ifAllLose: open.reduce((s, p) => s + p.ifLose, 0),
    maxPayout: open.reduce((s, p) => s + p.maxPayout, 0),
    nResting: orders.length,
    committed,
  }
}

function reportText(dateStr, r, balance, pending) {
  const L = []
  L.push(`KALSHI DAILY TRADING REPORT — ${dateStr}`)
  L.push('='.repeat(46))
  L.push('')
  L.push(`REALIZED P&L (settled today):  ${dollars(r.settleNet)}   (${r.wins}W / ${r.losses}L)`)
  L.push(`NET CASH FLOW:                 ${dollars(r.netCashFlow)}`)
  L.push(`  settlement payouts           ${dollars(r.payout)}`)
  L.push(`  sell proceeds                ${dollars(r.sellProceeds)}`)
  L.push(`  buys                         ${dollars(-r.buyCost)}`)
  L.push(`  trading fees                 ${dollars(-r.fillFees)}`)
  L.push(`  settlement fees (in P&L)     ${dollars(-r.settleFees)}`)
  L.push('')
  L.push(`ACTIVITY: ${r.fills} fills · ${r.contracts.toFixed(2)} contracts · taker ${r.takerShare === null ? '—' : Math.round(r.takerShare * 100) + '%'}`)
  if (r.bigWin && r.bigWin.net > 0) L.push(`BEST:  ${r.bigWin.ticker}  ${dollars(r.bigWin.net)}`)
  if (r.bigLoss && r.bigLoss.net < 0) L.push(`WORST: ${r.bigLoss.ticker}  ${dollars(r.bigLoss.net)}`)
  if (balance !== null) L.push(`END-OF-REPORT CASH: ${fmtMoney(balance)}`)
  if (pending) {
    L.push('')
    L.push('PENDING (open as of report generation)')
    L.push('-'.repeat(46))
    L.push(`OPEN POSITIONS: ${pending.nOpen} · cost basis ${dollars(pending.atRisk)}`)
    L.push(`IF ALL WIN: +${dollars(pending.ifAllWin)} · IF ALL LOSE: ${dollars(pending.ifAllLose)}`)
    L.push(`RESTING ORDERS: ${pending.nResting} · committed if filled ${dollars(pending.committed)}`)
    for (const p of pending.open) {
      L.push(
        `  ${p.ticker}  ${p.posCt > 0 ? `${p.posCt} YES` : `${-p.posCt} NO`} · cost ${dollars(p.exposure)} · win +${dollars(p.ifWin)} / lose ${dollars(p.ifLose)}`
      )
    }
  }
  L.push('')
  L.push('PER MARKET')
  L.push('-'.repeat(46))
  for (const m of r.byMarket) {
    L.push(
      `${m.ticker}\n  fills ${m.fills} · bought ${m.bought.toFixed(2)} · sold ${m.sold.toFixed(2)} · fees ${dollars(m.fees)}` +
        (m.settledNet !== null ? ` · settled ${m.result?.toUpperCase()} → ${dollars(m.settledNet)}` : '')
    )
  }
  L.push('')
  L.push('generated by kalshi-terminal · settlement P&L = payout − cost basis − fees · cash flow is day-of cash movement')
  return L.join('\n')
}

export default function ReportTab({ marketIndex }) {
  const today = new Date().toISOString().slice(0, 10)
  const [date, setDate] = useState(today)
  const [state, setState] = useState({ loading: true, r: null, err: null })
  const [balance, setBalance] = useState(null)
  const [pending, setPending] = useState(null)

  useEffect(() => {
    api('/portfolio/balance').then((d) => setBalance(d.balance ?? null)).catch(() => {})
    Promise.all([
      api('/portfolio/positions?limit=200').then((d) => d.market_positions || []),
      api('/portfolio/orders?status=resting&limit=200').then((d) => d.orders || []),
    ])
      .then(([positions, orders]) => setPending(aggregatePending(buildOpenPositions(positions), orders)))
      .catch(() => setPending(null))
  }, [])

  useEffect(() => {
    let live = true
    setState({ loading: true, r: null, err: null })
    const [dayStart, dayEnd] = localDayBounds(date)
    Promise.all([
      fetchDay('/portfolio/fills', 'fills', 'created_time', dayStart, dayEnd),
      fetchDay('/portfolio/settlements', 'settlements', 'settled_time', dayStart, dayEnd),
    ])
      .then(([fills, settlements]) => live && setState({ loading: false, r: computeReport(fills, settlements), err: null }))
      .catch((e) => live && setState({ loading: false, r: null, err: e.message }))
    return () => { live = false }
  }, [date])

  const r = state.r

  const download = () => {
    const blob = new Blob([reportText(date, r, balance, pending)], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `kalshi-report-${date}.txt`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <>
      <div className="pf-filters" style={{ paddingBottom: 8 }}>
        <span className="dim small">REPORT DATE</span>
        <input
          type="date"
          className="pf-search"
          style={{ minWidth: 140 }}
          value={date}
          max={today}
          onChange={(e) => e.target.value && setDate(e.target.value)}
        />
        <button className="table-toggle" onClick={() => setDate(today)}>TODAY</button>
        {r && <button className="table-toggle" onClick={download}>⬇ DOWNLOAD .TXT</button>}
      </div>

      {state.loading && <div className="dim" style={{ padding: 14 }}>crunching fills + settlements…</div>}
      {state.err && <div className="err-text" style={{ padding: 14 }}>{state.err}</div>}

      {r && (
        <>
          <div className="pf-summary">
            <div className="pf-stat">
              <span>REALIZED P&L (SETTLED)</span>
              <b className={r.settleNet > 0 ? 'up' : r.settleNet < 0 ? 'down' : ''}>{dollars(r.settleNet)}</b>
            </div>
            <div className="pf-stat">
              <span>NET CASH FLOW</span>
              <b className={r.netCashFlow > 0 ? 'up' : r.netCashFlow < 0 ? 'down' : ''}>{dollars(r.netCashFlow)}</b>
            </div>
            <div className="pf-stat">
              <span>WIN / LOSS (SETTLED)</span>
              <b>{r.settlements ? `${r.wins}W / ${r.losses}L (${Math.round((r.wins / r.settlements) * 100)}%)` : '—'}</b>
            </div>
            <div className="pf-stat">
              <span>FEES PAID</span>
              <b className="down">{dollars(r.fillFees + r.settleFees)}</b>
            </div>
            <div className="pf-stat">
              <span>FILLS / CONTRACTS</span>
              <b>{r.fills} / {r.contracts.toFixed(1)}</b>
            </div>
            <div className="pf-stat">
              <span>TAKER SHARE</span>
              <b>{r.takerShare === null ? '—' : `${Math.round(r.takerShare * 100)}%`}</b>
            </div>
            <div className="pf-stat">
              <span>BOUGHT / SOLD</span>
              <b>{dollars(r.buyCost)} / {dollars(r.sellProceeds)}</b>
            </div>
            <div className="pf-stat">
              <span>BEST · WORST</span>
              <b>
                <span className="up">{r.bigWin && r.bigWin.net > 0 ? dollars(r.bigWin.net) : '—'}</span>
                {' · '}
                <span className="down">{r.bigLoss && r.bigLoss.net < 0 ? dollars(r.bigLoss.net) : '—'}</span>
              </b>
            </div>
          </div>

          {pending && (
            <div className="pf-summary whatif-bar">
              <div className="pf-stat">
                <span>PENDING · OPEN POSITIONS</span>
                <b>{pending.nOpen} · {dollars(pending.atRisk)} AT RISK</b>
              </div>
              <div className="pf-stat">
                <span>IF ALL CONTRACTS WIN</span>
                <b className="up">+{dollars(pending.ifAllWin)}</b>
              </div>
              <div className="pf-stat">
                <span>IF ALL CONTRACTS LOSE</span>
                <b className="down">{dollars(pending.ifAllLose)}</b>
              </div>
              <div className="pf-stat">
                <span>RESTING ORDERS</span>
                <b>{pending.nResting} · {dollars(pending.committed)} IF FILLED</b>
              </div>
            </div>
          )}

          {r.byMarket.length ? (
            <div className="scroll-x">
              <table className="mini-table pf-table">
                <thead>
                  <tr><th>MARKET</th><th>FILLS</th><th>BOUGHT</th><th>SOLD</th><th>FEES</th><th>SETTLED</th><th>NET</th></tr>
                </thead>
                <tbody>
                  {r.byMarket.map((m) => {
                    const open = pending?.open.find((p) => p.ticker === m.ticker)
                    return (
                      <tr key={m.ticker}>
                        <td className="pf-name">{m.ticker}</td>
                        <td>{m.fills || '—'}</td>
                        <td>{m.bought ? m.bought.toFixed(2) : '—'}</td>
                        <td>{m.sold ? m.sold.toFixed(2) : '—'}</td>
                        <td className="dim">{dollars(m.fees)}</td>
                        <td className={m.result === 'yes' ? 'yes' : m.result === 'no' ? 'no' : open ? 'amber-text' : 'dim'}>
                          {m.result ? m.result.toUpperCase() : open ? 'PENDING' : '—'}
                        </td>
                        <td className={m.settledNet > 0 ? 'up' : m.settledNet < 0 ? 'down' : 'dim'}>
                          {m.settledNet !== null ? (
                            dollars(m.settledNet)
                          ) : open ? (
                            <>
                              <span className="up">W +{dollars(open.ifWin)}</span>
                              {' / '}
                              <span className="down">L {dollars(open.ifLose)}</span>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  {(pending?.open || [])
                    .filter((p) => !r.byMarket.some((m) => m.ticker === p.ticker))
                    .map((p) => (
                      <tr key={`pend-${p.ticker}`}>
                        <td className="pf-name">{p.ticker}</td>
                        <td className="dim" colSpan="3">held from earlier — {p.posCt > 0 ? `${p.posCt} YES` : `${-p.posCt} NO`}</td>
                        <td className="dim">—</td>
                        <td className="amber-text">PENDING</td>
                        <td>
                          <span className="up">W +{dollars(p.ifWin)}</span>
                          {' / '}
                          <span className="down">L {dollars(p.ifLose)}</span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="dim" style={{ padding: 14 }}>no fills or settlements on {date}</div>
          )}
          <div className="dim small" style={{ padding: '6px 14px 12px' }}>
            realized P&L counts markets that SETTLED this day (settlement credit − cost basis − fees) — if you sold
            out before settlement, those sale proceeds counted as cash flow on the day you sold, so a settled
            market's NET here can look worse than your true lifetime result on it · net cash flow is the day's
            actual cash movement: payouts + sells − buys − fees ·
            PENDING = open contracts scored by outcome: W = $1 × contracts − cost basis if the contract hits,
            L = −cost basis if it misses (no mark-to-market) · resting orders counted at committed cost
          </div>
        </>
      )}
    </>
  )
}
