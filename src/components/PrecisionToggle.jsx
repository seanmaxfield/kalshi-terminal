import React from 'react'

// Strike-label precision: null = auto (compact), 0–4 = exact decimal places.
export function makeStrikeFmt(dp, autoFmt) {
  if (dp === null) return autoFmt
  return (v) =>
    Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

export default function PrecisionToggle({ dp, setDp }) {
  return (
    <span className="prec-toggle" title="strike decimal places">
      <button
        onClick={() => setDp(dp === 0 ? null : dp - 1)}
        disabled={dp === null}
      >
        −
      </button>
      <span className="prec-label">{dp === null ? 'AUTO' : dp === 0 ? '0 DP' : `${dp} DP`}</span>
      <button
        onClick={() => setDp(dp === null ? 0 : Math.min(4, dp + 1))}
        disabled={dp === 4}
      >
        +
      </button>
    </span>
  )
}
