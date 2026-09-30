import React, { useMemo, useRef, useState } from 'react'

// Minimal terminal-styled SVG bar chart with per-bar hover tooltip.
// points: [{x, y, label?}] — x numeric (strike), y magnitude (volume).
const W = 720
const H = 200
const PAD = { l: 52, r: 20, t: 14, b: 30 }

function niceTicks(min, max, n = 3) {
  if (min === max) { min -= 1; max += 1 }
  const span = max - min
  const step0 = Math.pow(10, Math.floor(Math.log10(span / n)))
  const err = span / n / step0
  const step = step0 * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1)
  const ticks = []
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(v)
  return ticks
}

const compact = (v) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v)

// bands: [{x1, x2, fill}] — translucent vertical regions drawn behind the bars.
export default function BarChart({ points, bands = [], color = 'var(--amber)', xFmt = compact, yFmt = compact, xLabel }) {
  const svgRef = useRef(null)
  const [hover, setHover] = useState(null)

  const { xMin, xMax, yMax, xTicks, yTicks, barW } = useMemo(() => {
    const xs = points.map((p) => p.x)
    const xMin = Math.min(...xs), xMax = Math.max(...xs)
    const yMax = Math.max(...points.map((p) => p.y), 1)
    // narrowest gap between adjacent strikes sets the bar width
    const sorted = [...xs].sort((a, b) => a - b)
    let minGap = Infinity
    for (let i = 1; i < sorted.length; i++) minGap = Math.min(minGap, sorted[i] - sorted[i - 1])
    const plotW = W - PAD.l - PAD.r
    const gapPx = minGap === Infinity ? plotW : (minGap / (xMax - xMin || 1)) * plotW
    return {
      xMin, xMax, yMax,
      xTicks: niceTicks(xMin, xMax, 5),
      yTicks: niceTicks(0, yMax, 3).filter((t) => t >= 0),
      barW: Math.max(2, Math.min(24, gapPx - 2)),
    }
  }, [points])

  const sx = (x) => PAD.l + ((x - xMin) / (xMax - xMin || 1)) * (W - PAD.l - PAD.r)
  const sy = (y) => H - PAD.b - (y / yMax) * (H - PAD.t - PAD.b)

  const onMove = (e) => {
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    let best = null
    for (const p of points) {
      if (best === null || Math.abs(sx(p.x) - px) < Math.abs(sx(best.x) - px)) best = p
    }
    setHover(best)
  }

  const tipLeft = hover !== null && sx(hover.x) > W / 2

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', display: 'block' }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      {bands.map((b, i) => {
        const x1 = Math.max(PAD.l, sx(Math.max(b.x1, xMin)))
        const x2 = Math.min(W - PAD.r, sx(Math.min(b.x2, xMax)))
        if (x2 <= x1) return null
        return <rect key={`band${i}`} x={x1} y={PAD.t} width={x2 - x1} height={H - PAD.t - PAD.b} fill={b.fill} />
      })}
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} stroke="var(--border)" strokeWidth="1" />
          <text x={PAD.l - 6} y={sy(t) + 3} textAnchor="end" fill="var(--dim)" fontSize="9">{yFmt(t)}</text>
        </g>
      ))}
      {xTicks.map((t) => (
        <g key={`x${t}`}>
          <line x1={sx(t)} x2={sx(t)} y1={H - PAD.b} y2={H - PAD.b + 3} stroke="var(--dim)" strokeWidth="1" />
          <text x={sx(t)} y={H - PAD.b + 14} textAnchor="middle" fill="var(--dim)" fontSize="9">{xFmt(t)}</text>
        </g>
      ))}
      {xLabel && <text x={(PAD.l + W - PAD.r) / 2} y={H - 2} textAnchor="middle" fill="var(--dim)" fontSize="9" letterSpacing="1">{xLabel}</text>}

      {points.map((p) => (
        <rect
          key={p.x}
          x={sx(p.x) - barW / 2}
          y={sy(p.y)}
          width={barW}
          height={Math.max(0, H - PAD.b - sy(p.y))}
          rx="1.5"
          fill={color}
          opacity={hover === null || hover === p ? 0.9 : 0.35}
        />
      ))}

      {hover && (
        <g pointerEvents="none">
          <g transform={`translate(${tipLeft ? sx(hover.x) - 158 : sx(hover.x) + 10},${PAD.t + 4})`}>
            <rect width="148" height={hover.label ? 42 : 30} fill="#000" stroke="var(--border)" />
            <text x="6" y="12" fill="var(--dim)" fontSize="9">{xFmt(hover.x)}</text>
            <text x="6" y="24" fill="var(--text)" fontSize="9">VOL {yFmt(hover.y)}</text>
            {hover.label && <text x="6" y="36" fill="var(--dim)" fontSize="9">{hover.label}</text>}
          </g>
        </g>
      )}
    </svg>
  )
}
