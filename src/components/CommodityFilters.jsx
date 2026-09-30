import React from 'react'
import { COMMODITIES } from '../lib/underlying.js'

export const DEFAULT_COM_FILTERS = { sym: 'all', expiry: 'all', minVol: 0, sort: 'vol' }

const EXPIRIES = [
  ['all', 'ALL'],
  ['24h', '≤ 24H'],
  ['7d', '≤ 7D'],
  ['later', '> 7D'],
]
const VOLS = [
  [0, 'ANY VOL'],
  [10_000, '≥ 10K'],
  [100_000, '≥ 100K'],
  [1_000_000, '≥ 1M'],
]

export default function CommodityFilters({ filters, setFilters, counts }) {
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }))
  return (
    <div className="com-filters">
      <div className="com-filter-row">
        <span className="dim small">UNDERLYING</span>
        <button className={`table-toggle ${filters.sym === 'all' ? 'on' : ''}`} onClick={() => set('sym', 'all')}>
          ALL{counts ? ` (${counts.total})` : ''}
        </button>
        {COMMODITIES.map((c) => (
          <button
            key={c.key}
            className={`table-toggle ${filters.sym === c.symbol ? 'on' : ''}`}
            onClick={() => set('sym', c.symbol)}
          >
            {c.label}{counts?.bySym[c.symbol] ? ` (${counts.bySym[c.symbol]})` : ''}
          </button>
        ))}
        <button className={`table-toggle ${filters.sym === 'other' ? 'on' : ''}`} onClick={() => set('sym', 'other')}>
          OTHER{counts?.other ? ` (${counts.other})` : ''}
        </button>
      </div>
      <div className="com-filter-row">
        <span className="dim small">EXPIRY</span>
        {EXPIRIES.map(([k, label]) => (
          <button key={k} className={`table-toggle ${filters.expiry === k ? 'on' : ''}`} onClick={() => set('expiry', k)}>
            {label}
          </button>
        ))}
        <span className="dim small" style={{ marginLeft: 10 }}>24H VOLUME</span>
        {VOLS.map(([v, label]) => (
          <button key={v} className={`table-toggle ${filters.minVol === v ? 'on' : ''}`} onClick={() => set('minVol', v)}>
            {label}
          </button>
        ))}
        <span className="dim small" style={{ marginLeft: 10 }}>SORT</span>
        <button className={`table-toggle ${filters.sort === 'vol' ? 'on' : ''}`} onClick={() => set('sort', 'vol')}>
          MOST ACTIVE
        </button>
        <button className={`table-toggle ${filters.sort === 'close' ? 'on' : ''}`} onClick={() => set('sort', 'close')}>
          CLOSING SOON
        </button>
      </div>
    </div>
  )
}
