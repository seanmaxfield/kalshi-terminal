import React, { useMemo, useState } from 'react'
import { cents, fmtMoney } from '../api.js'
import PrecisionToggle, { makeStrikeFmt } from './PrecisionToggle.jsx'

const strikeOf = (m) => m.floor_strike ?? m.cap_strike ?? null
const fmtK = (v) =>
  Math.abs(v) >= 1000
    ? Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v)
    : +(+v).toFixed(2)
const pct = (v) => `${(v * 100).toFixed(1)}%`

function LegPicker({ title, markets, priceOf, disabled, selected, onPick, hint }) {
  return (
    <div className="leg-col">
      <div className="panel-title">{title}</div>
      {hint && <div className="dim small" style={{ padding: '4px 10px' }}>{hint}</div>}
      <div className="leg-list">
        {markets.map((m) => {
          const px = priceOf(m)
          const dis = disabled(m) || px === null
          return (
            <button
              key={m.ticker}
              className={`leg-row ${selected?.ticker === m.ticker ? 'on' : ''}`}
              disabled={dis}
              onClick={() => onPick(m)}
            >
              <span>{m.yes_sub_title || m.ticker}</span>
              <span className="px">{px === null ? '—' : `${px}¢`}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function SpreadTool({ event, onClose }) {
  const markets = useMemo(
    () =>
      (event.markets || [])
        .filter((m) => strikeOf(m) !== null)
        .sort((a, b) => strikeOf(a) - strikeOf(b)),
    [event]
  )
  const [yesLeg, setYesLeg] = useState(null)
  const [noLeg, setNoLeg] = useState(null)
  const [dp, setDp] = useState(null) // strike decimals: null = auto
  const fmtStrike = makeStrikeFmt(dp, fmtK)

  const yesAsk = (m) => cents(m.yes_ask_dollars ?? m.yes_ask)
  const noAsk = (m) =>
    cents(m.no_ask_dollars ?? m.no_ask) ??
    (cents(m.yes_bid_dollars ?? m.yes_bid) !== null ? 100 - cents(m.yes_bid_dollars ?? m.yes_bid) : null)

  const analysis = useMemo(() => {
    if (!yesLeg || !noLeg) return null
    const kA = strikeOf(yesLeg)
    const kB = strikeOf(noLeg)
    const costA = yesAsk(yesLeg)
    const costB = noAsk(noLeg)
    if (costA === null || costB === null) return null

    // -------- your custom calc, step by step --------
    const pA = costA / 100 // prob of yes leg from its price
    const pB = costB / 100 // prob of no leg from its price
    const both = (pBoth) => {
      const p = pA + pB - pBoth // P(A or B or both)
      const D = (pBoth * (1 - pA + (1 - pB)) + pB * (1 - pB) + pA * (1 - pA)) / 1
      const score = p - (1 - p) / D
      return { pBoth, p, D, score }
    }
    const indep = both(pA * pB)
    const ladder = both(Math.max(0, pA + pB - 1))

    // -------- standard spread analysis --------
    const cost = costA + costB // cents for one contract each
    // Zones (for "or above" ladders): S ≤ kA → only NO pays; kA < S ≤ kB → both pay; S > kB → only YES pays
    const zones = [
      { name: `BELOW ${fmtStrike(kA)}`, payout: 100, pnl: 100 - cost },
      { name: `${fmtStrike(kA)} – ${fmtStrike(kB)}`, payout: 200, pnl: 200 - cost },
      { name: `ABOVE ${fmtStrike(kB)}`, payout: 100, pnl: 100 - cost },
    ]
    return { kA, kB, costA, costB, pA, pB, indep, ladder, cost, zones }
  }, [yesLeg, noLeg])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{event.title} · SPREAD ANALYSIS</span>
          <PrecisionToggle dp={dp} setDp={setDp} />
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="spread-pickers">
          <LegPicker
            title="1 · YES LEG (BUY YES)"
            markets={markets}
            priceOf={yesAsk}
            disabled={() => false}
            selected={yesLeg}
            onPick={(m) => {
              setYesLeg(m)
              if (noLeg && strikeOf(noLeg) <= strikeOf(m)) setNoLeg(null)
            }}
          />
          <LegPicker
            title="2 · NO LEG (BUY NO)"
            markets={markets}
            priceOf={noAsk}
            disabled={(m) => !yesLeg || strikeOf(m) <= strikeOf(yesLeg)}
            selected={noLeg}
            onPick={setNoLeg}
            hint={yesLeg ? `only strikes above ${fmtStrike(strikeOf(yesLeg))} allowed (yes strike must be below no strike)` : 'pick the yes leg first'}
          />
        </div>

        {analysis && (
          <>
            <div className="modal-meta">
              <span>YES {'>'}{fmtStrike(analysis.kA)} @ <b className="yes">{analysis.costA}¢</b></span>
              <span>NO {'>'}{fmtStrike(analysis.kB)} @ <b className="no">{analysis.costB}¢</b></span>
              <span>COMBINED COST <b>{fmtMoney(analysis.cost)}</b> / SPREAD PAIR</span>
              <span>MAX PROFIT <b className="up">{fmtMoney(200 - analysis.cost)}</b></span>
              <span>MAX LOSS <b className={100 - analysis.cost < 0 ? 'down' : 'up'}>{fmtMoney(100 - analysis.cost)}</b></span>
            </div>

            <div className="spread-zones">
              <div className="panel-title">PAYOUT ZONES (at settlement)</div>
              <table className="mini-table">
                <thead><tr><th>UNDERLYING ENDS</th><th>LEGS PAYING</th><th>PAYOUT</th><th>P&L</th></tr></thead>
                <tbody>
                  {analysis.zones.map((z, i) => (
                    <tr key={z.name}>
                      <td>{z.name}</td>
                      <td>{i === 1 ? 'BOTH' : i === 0 ? 'NO LEG ONLY' : 'YES LEG ONLY'}</td>
                      <td>{fmtMoney(z.payout)}</td>
                      <td className={z.pnl > 0 ? 'up' : z.pnl < 0 ? 'down' : ''}>{fmtMoney(z.pnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="dim small" style={{ padding: '2px 10px 8px' }}>
                one leg always pays on an "or above" ladder, so worst case is {fmtMoney(100 - analysis.cost)} —
                a combined cost under $1.00 would be a pure arb
              </div>
            </div>

            <div className="spread-calc">
              <div className="panel-title">YOUR SCORE — STEP BY STEP</div>
              <table className="mini-table calc-table">
                <thead>
                  <tr>
                    <th>STEP</th>
                    <th>INDEPENDENT (P(A)×P(B))</th>
                    <th>SAME-UNDERLYING LADDER (P(A)+P(B)−1)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>1 · P(A) = P(YES leg wins) — the YES ask of leg A</td>
                    <td colSpan="2">yes ask {analysis.costA}¢ → <b>{pct(analysis.pA)}</b></td>
                  </tr>
                  <tr>
                    <td>2 · P(B) = P(NO leg wins) — the NO ask of leg B (not its yes price)</td>
                    <td colSpan="2">
                      no ask {analysis.costB}¢ → <b>{pct(analysis.pB)}</b>
                      <span className="dim"> (this market's yes side ≈ {100 - analysis.costB}¢)</span>
                    </td>
                  </tr>
                  <tr>
                    <td>3 · P(both)</td>
                    <td>{pct(analysis.pA)} × {pct(analysis.pB)} = <b>{pct(analysis.indep.pBoth)}</b></td>
                    <td>max(0, {pct(analysis.pA)} + {pct(analysis.pB)} − 100%) = <b>{pct(analysis.ladder.pBoth)}</b></td>
                  </tr>
                  <tr>
                    <td>4 · p = P(A) + P(B) − P(both)</td>
                    <td><b>{pct(analysis.indep.p)}</b></td>
                    <td><b>{pct(analysis.ladder.p)}</b></td>
                  </tr>
                  <tr>
                    <td>
                      5 · D = [P(both)×((1−P(A)) + (1−P(B))) + P(B)×(1−P(B)) + P(A)×(1−P(A))] ÷ 1
                    </td>
                    <td>
                      [{pct(analysis.indep.pBoth)}×({pct(1 - analysis.pA)}+{pct(1 - analysis.pB)}) +{' '}
                      {pct(analysis.pB)}×{pct(1 - analysis.pB)} + {pct(analysis.pA)}×{pct(1 - analysis.pA)}] ÷ 1 ={' '}
                      <b>{analysis.indep.D.toFixed(4)}</b>
                    </td>
                    <td>
                      [{pct(analysis.ladder.pBoth)}×({pct(1 - analysis.pA)}+{pct(1 - analysis.pB)}) +{' '}
                      {pct(analysis.pB)}×{pct(1 - analysis.pB)} + {pct(analysis.pA)}×{pct(1 - analysis.pA)}] ÷ 1 ={' '}
                      <b>{analysis.ladder.D.toFixed(4)}</b>
                    </td>
                  </tr>
                  <tr>
                    <td>6 · SCORE = p − (1−p)/D</td>
                    <td>
                      {pct(analysis.indep.p)} − {pct(1 - analysis.indep.p)}/{analysis.indep.D.toFixed(4)} ={' '}
                      <b className={analysis.indep.score > 0 ? 'up' : 'down'}>{analysis.indep.score.toFixed(4)}</b>
                    </td>
                    <td>
                      {pct(analysis.ladder.p)} − {pct(1 - analysis.ladder.p)}/{analysis.ladder.D.toFixed(4)} ={' '}
                      <b className={analysis.ladder.score > 0 ? 'up' : 'down'}>{analysis.ladder.score.toFixed(4)}</b>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="dim small" style={{ padding: '2px 10px 10px' }}>
                probabilities read from the ask you pay per leg · both legs settle off the SAME underlying, so
                "independent" overstates P(both) when the strikes are far apart and understates the overlap band —
                the ladder column is the structurally consistent one (with it, p = 100% because one leg always wins)
              </div>
            </div>
          </>
        )}
        {!analysis && (
          <div className="dim" style={{ padding: '14px 16px' }}>
            pick both legs to see the spread analysis and the step-by-step score
          </div>
        )}
      </div>
    </div>
  )
}
