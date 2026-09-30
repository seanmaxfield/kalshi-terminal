import React, { useMemo, useRef, useState } from 'react'

// GPO: OHLC candlesticks (mid of yes bid/ask candles), 0–100¢ scale.
const W = 720
const H = 260
const PAD = { l: 48, r: 20, t: 14, b: 30 }

export default function CandleChart({ candles, xFmt = (v) => v }) {
  const svgRef = useRef(null)
  const [hover, setHover] = useState(null)
  const pts = candles.filter((c) => c.open !== null && c.high !== null && c.low !== null && c.mid !== null)
  const { xMin, xMax, cw } = useMemo(() => {
    const xs = pts.map((p) => p.t)
    const xMin = Math.min(...xs), xMax = Math.max(...xs)
    const plotW = W - PAD.l - PAD.r
    return { xMin, xMax, cw: Math.max(2, Math.min(14, (plotW / Math.max(1, pts.length)) * 0.7)) }
  }, [pts])
  const sx = (x) => PAD.l + ((x - xMin) / (xMax - xMin || 1)) * (W - PAD.l - PAD.r)
  const sy = (y) => H - PAD.b - (y / 100) * (H - PAD.t - PAD.b)
  const onMove = (e) => {
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    let best = null
    for (const p of pts) if (best === null || Math.abs(sx(p.t) - px) < Math.abs(sx(best.t) - px)) best = p
    setHover(best)
  }
  if (pts.length < 2) return <div className="dim" style={{ padding: 14 }}>no OHLC data in this range</div>
  const ticks = [0, 20, 40, 60, 80, 100]
  const nx = 5
  const xt = Array.from({ length: nx + 1 }, (_, i) => xMin + ((xMax - xMin) * i) / nx)
  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} stroke="var(--border)" />
          <text x={PAD.l - 6} y={sy(t) + 3} textAnchor="end" fill="var(--dim)" fontSize="9">{t}¢</text>
        </g>
      ))}
      {xt.map((t) => <text key={t} x={sx(t)} y={H - PAD.b + 14} textAnchor="middle" fill="var(--dim)" fontSize="9">{xFmt(t)}</text>)}
      {pts.map((p) => {
        const up = p.mid >= p.open
        const col = up ? 'var(--yes)' : 'var(--no)'
        const x = sx(p.t)
        const top = sy(Math.max(p.open, p.mid)), bot = sy(Math.min(p.open, p.mid))
        return (
          <g key={p.t} opacity={hover && hover !== p ? 0.55 : 1}>
            <line x1={x} x2={x} y1={sy(p.high)} y2={sy(p.low)} stroke={col} strokeWidth="1" />
            <rect x={x - cw / 2} y={top} width={cw} height={Math.max(1, bot - top)} fill={up ? col : col} stroke={col} />
          </g>
        )
      })}
      {hover && (
        <g pointerEvents="none" transform={`translate(${sx(hover.t) > W / 2 ? sx(hover.t) - 150 : sx(hover.t) + 10},${PAD.t + 4})`}>
          <rect width="140" height="62" fill="#000" stroke="var(--border)" />
          <text x="6" y="12" fill="var(--dim)" fontSize="9">{xFmt(hover.t)}</text>
          <text x="6" y="25" fill="var(--text)" fontSize="9">O {hover.open.toFixed(1)}  H {hover.high.toFixed(1)}</text>
          <text x="6" y="38" fill="var(--text)" fontSize="9">L {hover.low.toFixed(1)}  C {hover.mid.toFixed(1)}</text>
          <text x="6" y="51" fill="var(--dim)" fontSize="9">vol {Math.round(hover.volume)}</text>
        </g>
      )}
    </svg>
  )
}
