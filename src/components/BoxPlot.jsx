import React, { useMemo, useRef, useState } from 'react'

// Terminal-styled box plot: one box per strike showing the distribution of
// per-bar price changes (whiskers p5–p95, box q1–q3, median line).
const W = 720
const H = 220
const PAD = { l: 52, r: 20, t: 14, b: 30 }

function niceTicks(min, max, n = 4) {
  if (min === max) { min -= 1; max += 1 }
  const span = max - min
  const step0 = Math.pow(10, Math.floor(Math.log10(span / n)))
  const err = span / n / step0
  const step = step0 * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1)
  const ticks = []
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(v)
  return ticks
}

export default function BoxPlot({ points, xFmt = (v) => v, yFmt = (v) => v, xLabel }) {
  const svgRef = useRef(null)
  const [hover, setHover] = useState(null)

  const { xMin, xMax, yMin, yMax, xTicks, yTicks, boxW } = useMemo(() => {
    const xs = points.map((p) => p.x)
    const xMin = Math.min(...xs), xMax = Math.max(...xs)
    let yMin = Math.min(...points.map((p) => p.lo), 0)
    let yMax = Math.max(...points.map((p) => p.hi), 0)
    const pad = (yMax - yMin || 1) * 0.1
    yMin -= pad; yMax += pad
    const sorted = [...xs].sort((a, b) => a - b)
    let minGap = Infinity
    for (let i = 1; i < sorted.length; i++) minGap = Math.min(minGap, sorted[i] - sorted[i - 1])
    const plotW = W - PAD.l - PAD.r
    const gapPx = minGap === Infinity ? plotW : (minGap / (xMax - xMin || 1)) * plotW
    return {
      xMin, xMax, yMin, yMax,
      xTicks: niceTicks(xMin, xMax, 5),
      yTicks: niceTicks(yMin, yMax, 4),
      boxW: Math.max(3, Math.min(18, gapPx - 3)),
    }
  }, [points])

  const sx = (x) => PAD.l + ((x - xMin) / (xMax - xMin || 1)) * (W - PAD.l - PAD.r)
  const sy = (y) => H - PAD.b - ((y - yMin) / (yMax - yMin || 1)) * (H - PAD.t - PAD.b)

  const onMove = (e) => {
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    let best = null
    for (const p of points) if (best === null || Math.abs(sx(p.x) - px) < Math.abs(sx(best.x) - px)) best = p
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
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} stroke="var(--border)" strokeWidth="1" />
          <text x={PAD.l - 6} y={sy(t) + 3} textAnchor="end" fill="var(--dim)" fontSize="9">{yFmt(t)}</text>
        </g>
      ))}
      {/* zero line emphasized */}
      <line x1={PAD.l} x2={W - PAD.r} y1={sy(0)} y2={sy(0)} stroke="var(--dim)" strokeWidth="1" strokeDasharray="4 3" />
      {xTicks.map((t) => (
        <g key={`x${t}`}>
          <line x1={sx(t)} x2={sx(t)} y1={H - PAD.b} y2={H - PAD.b + 3} stroke="var(--dim)" strokeWidth="1" />
          <text x={sx(t)} y={H - PAD.b + 14} textAnchor="middle" fill="var(--dim)" fontSize="9">{xFmt(t)}</text>
        </g>
      ))}
      {xLabel && <text x={(PAD.l + W - PAD.r) / 2} y={H - 2} textAnchor="middle" fill="var(--dim)" fontSize="9" letterSpacing="1">{xLabel}</text>}

      {points.map((p) => {
        const cx = sx(p.x)
        const dim = hover !== null && hover !== p
        return (
          <g key={p.x} opacity={dim ? 0.4 : 1}>
            <line x1={cx} x2={cx} y1={sy(p.lo)} y2={sy(p.hi)} stroke="var(--amber)" strokeWidth="1" />
            <line x1={cx - boxW / 3} x2={cx + boxW / 3} y1={sy(p.lo)} y2={sy(p.lo)} stroke="var(--amber)" strokeWidth="1" />
            <line x1={cx - boxW / 3} x2={cx + boxW / 3} y1={sy(p.hi)} y2={sy(p.hi)} stroke="var(--amber)" strokeWidth="1" />
            <rect
              x={cx - boxW / 2}
              y={sy(p.q3)}
              width={boxW}
              height={Math.max(1, sy(p.q1) - sy(p.q3))}
              fill="rgba(255, 157, 0, 0.25)"
              stroke="var(--amber)"
              strokeWidth="1"
            />
            <line x1={cx - boxW / 2} x2={cx + boxW / 2} y1={sy(p.med)} y2={sy(p.med)} stroke="#fff" strokeWidth="1.5" />
          </g>
        )
      })}

      {hover && (
        <g pointerEvents="none">
          <g transform={`translate(${tipLeft ? sx(hover.x) - 168 : sx(hover.x) + 12},${PAD.t + 2})`}>
            <rect width="156" height="76" fill="#000" stroke="var(--border)" />
            <text x="6" y="12" fill="var(--dim)" fontSize="9">{xFmt(hover.x)} · n={hover.n}</text>
            <text x="6" y="25" fill="var(--text)" fontSize="9">p95 {yFmt(hover.hi)} · p5 {yFmt(hover.lo)}</text>
            <text x="6" y="38" fill="var(--text)" fontSize="9">q3 {yFmt(hover.q3)} · q1 {yFmt(hover.q1)}</text>
            <text x="6" y="51" fill="#fff" fontSize="9">median {yFmt(hover.med)}</text>
            <text x="6" y="64" fill="var(--dim)" fontSize="9">Δ yes ¢ per bar</text>
          </g>
        </g>
      )}
    </svg>
  )
}
