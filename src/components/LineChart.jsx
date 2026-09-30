import React, { useMemo, useRef, useState } from 'react'

// Minimal terminal-styled SVG line chart with crosshair + tooltip.
// series: [{ name, color, dashed, points: [{x, y}] }]
const W = 720
const H = 240
const PAD = { l: 48, r: 64, t: 14, b: 30 }

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

const defFmt = (v) => (Math.abs(v) >= 1000 ? Intl.NumberFormat('en-US', { notation: 'compact' }).format(v) : +v.toFixed(2))

// bands: [{x1, x2, fill}] — translucent vertical regions drawn behind the grid.
// rangeMarker: {x1, x2, label} — a bracket ruler drawn just above the x-axis.
// onPlotClick(dataX) — click anywhere in the plot to report the x value.
export default function LineChart({ series, bands = [], rangeMarker, onPlotClick, xFmt = defFmt, yFmt = defFmt, yDomain, xLabel, yLabel }) {
  const svgRef = useRef(null)
  const [hover, setHover] = useState(null)

  const { xMin, xMax, yMin, yMax, xTicks, yTicks } = useMemo(() => {
    const xs = series.flatMap((s) => s.points.map((p) => p.x))
    const ys = series.flatMap((s) => s.points.map((p) => p.y))
    let xMin = Math.min(...xs), xMax = Math.max(...xs)
    let yMin = yDomain ? yDomain[0] : Math.min(...ys)
    let yMax = yDomain ? yDomain[1] : Math.max(...ys)
    if (!yDomain) {
      const pad = (yMax - yMin || 1) * 0.08
      yMin -= pad; yMax += pad
    }
    return { xMin, xMax, yMin, yMax, xTicks: niceTicks(xMin, xMax, 5), yTicks: niceTicks(yMin, yMax, 4) }
  }, [series, yDomain])

  const sx = (x) => PAD.l + ((x - xMin) / (xMax - xMin || 1)) * (W - PAD.l - PAD.r)
  const sy = (y) => H - PAD.b - ((y - yMin) / (yMax - yMin || 1)) * (H - PAD.t - PAD.b)

  const toDataX = (e) => {
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    return xMin + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (xMax - xMin)
  }

  const onMove = (e) => {
    const dataX = toDataX(e)
    // nearest x among first series' points
    const pts = series[0].points
    let best = pts[0]
    for (const p of pts) if (Math.abs(p.x - dataX) < Math.abs(best.x - dataX)) best = p
    setHover(best.x)
  }

  const hoverVals = hover === null ? null : series.map((s) => {
    let best = null
    for (const p of s.points) if (best === null || Math.abs(p.x - hover) < Math.abs(best.x - hover)) best = p
    return { name: s.name, color: s.color, ...best }
  })
  const tipX = hover !== null ? sx(hover) : 0
  const tipLeft = tipX > W / 2

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      onClick={onPlotClick ? (e) => onPlotClick(toDataX(e)) : undefined}
      style={{ width: '100%', display: 'block', cursor: onPlotClick ? 'crosshair' : undefined }}
    >
      {/* edge-region shading (behind everything) */}
      {bands.map((b, i) => {
        const x1 = Math.max(PAD.l, sx(Math.max(b.x1, xMin)))
        const x2 = Math.min(W - PAD.r, sx(Math.min(b.x2, xMax)))
        if (x2 <= x1) return null
        return (
          <rect key={`band${i}`} x={x1} y={PAD.t} width={x2 - x1} height={H - PAD.t - PAD.b} fill={b.fill} />
        )
      })}

      {/* grid + y ticks */}
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} stroke="var(--border)" strokeWidth="1" />
          <text x={PAD.l - 6} y={sy(t) + 3} textAnchor="end" fill="var(--dim)" fontSize="9">{yFmt(t)}</text>
        </g>
      ))}
      {/* x ticks */}
      {xTicks.map((t) => (
        <g key={`x${t}`}>
          <line x1={sx(t)} x2={sx(t)} y1={H - PAD.b} y2={H - PAD.b + 3} stroke="var(--dim)" strokeWidth="1" />
          <text x={sx(t)} y={H - PAD.b + 14} textAnchor="middle" fill="var(--dim)" fontSize="9">{xFmt(t)}</text>
        </g>
      ))}
      {xLabel && <text x={(PAD.l + W - PAD.r) / 2} y={H - 2} textAnchor="middle" fill="var(--dim)" fontSize="9" letterSpacing="1">{xLabel}</text>}
      {yLabel && <text x={10} y={PAD.t + 2} fill="var(--dim)" fontSize="9" letterSpacing="1">{yLabel}</text>}

      {/* series */}
      {series.map((s) => (
        <g key={s.name}>
          <path
            d={s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('')}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeDasharray={s.dashed ? '5 4' : undefined}
            strokeLinejoin="round"
          />
          {s.points.map((p) => (
            <circle key={p.x} cx={sx(p.x)} cy={sy(p.y)} r="2.5" fill={s.color} />
          ))}
          {/* direct end label: colored swatch + text-token label */}
          <g transform={`translate(${sx(s.points[s.points.length - 1].x) + 6},${sy(s.points[s.points.length - 1].y)})`}>
            <rect x="0" y="-4" width="7" height="7" fill={s.color} />
            <text x="10" y="3" fill="var(--text)" fontSize="9" letterSpacing="1">{s.name}</text>
          </g>
        </g>
      ))}

      {/* ADR range ruler: faint band + bracket just above the x-axis */}
      {rangeMarker && (() => {
        const x1 = Math.max(PAD.l, sx(rangeMarker.x1))
        const x2 = Math.min(W - PAD.r, sx(rangeMarker.x2))
        if (x2 <= x1) return null
        const yBar = H - PAD.b - 8
        const mid = (x1 + x2) / 2
        return (
          <g pointerEvents="none">
            <rect x={x1} y={PAD.t} width={x2 - x1} height={H - PAD.t - PAD.b} fill="rgba(255, 157, 0, 0.07)" />
            <line x1={x1} x2={x2} y1={yBar} y2={yBar} stroke="var(--amber)" strokeWidth="2" />
            <line x1={x1} x2={x1} y1={yBar - 5} y2={yBar + 5} stroke="var(--amber)" strokeWidth="2" />
            <line x1={x2} x2={x2} y1={yBar - 5} y2={yBar + 5} stroke="var(--amber)" strokeWidth="2" />
            <rect x={mid - 60} y={yBar - 22} width="120" height="13" fill="#000" stroke="var(--amber)" strokeWidth="0.5" />
            <text x={mid} y={yBar - 12} textAnchor="middle" fill="var(--amber)" fontSize="9" letterSpacing="0.5">
              {rangeMarker.label}
            </text>
          </g>
        )
      })()}

      {/* crosshair + tooltip */}
      {hoverVals && (
        <g pointerEvents="none">
          <line x1={tipX} x2={tipX} y1={PAD.t} y2={H - PAD.b} stroke="var(--dim)" strokeWidth="1" strokeDasharray="3 3" />
          {hoverVals.map((v) => (
            <circle key={v.name} cx={sx(v.x)} cy={sy(v.y)} r="4" fill={v.color} stroke="var(--bg)" strokeWidth="2" />
          ))}
          <g transform={`translate(${tipLeft ? tipX - 148 : tipX + 8},${PAD.t + 4})`}>
            <rect width="140" height={16 + hoverVals.length * 13} fill="#000" stroke="var(--border)" />
            <text x="6" y="12" fill="var(--dim)" fontSize="9">{xFmt(hoverVals[0].x)}</text>
            {hoverVals.map((v, i) => (
              <g key={v.name} transform={`translate(6,${24 + i * 13})`}>
                <rect y="-7" width="7" height="7" fill={v.color} />
                <text x="11" y="0" fill="var(--text)" fontSize="9">{v.name} {yFmt(v.y)}</text>
              </g>
            ))}
          </g>
        </g>
      )}
    </svg>
  )
}
