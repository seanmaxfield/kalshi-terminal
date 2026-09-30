// Markov chain over discretized price changes.
// States are σ-scaled buckets of per-bar returns; the transition matrix is
// estimated from history with light Laplace smoothing.

const FIVE = [
  { key: 'DD', name: '▼▼ BIG DOWN' },
  { key: 'D', name: '▼ DOWN' },
  { key: 'F', name: '■ FLAT' },
  { key: 'U', name: '▲ UP' },
  { key: 'UU', name: '▲▲ BIG UP' },
]
const THREE = [
  { key: 'D', name: '▼ DOWN' },
  { key: 'F', name: '■ FLAT' },
  { key: 'U', name: '▲ UP' },
]

export function buildMarkov(bars) {
  const closes = bars.map((b) => b.close).filter((c) => c > 0)
  if (closes.length < 12) return null
  const rets = []
  for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1)

  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const sigma = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1))
  if (!(sigma > 0)) return null

  // 5 states when we have enough data to fill a 5×5 matrix, else 3.
  const defs = rets.length >= 60 ? FIVE : THREE
  const n = defs.length
  const classify =
    n === 5
      ? (r) => (r < -1.25 * sigma ? 0 : r < -0.25 * sigma ? 1 : r <= 0.25 * sigma ? 2 : r <= 1.25 * sigma ? 3 : 4)
      : (r) => (r < -0.25 * sigma ? 0 : r <= 0.25 * sigma ? 1 : 2)

  const states = rets.map(classify)

  // per-state stats
  const stateStats = defs.map((d, i) => {
    const rs = rets.filter((_, k) => states[k] === i)
    return {
      ...d,
      count: rs.length,
      meanRet: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
    }
  })

  // transition counts with Laplace smoothing (0.5)
  const counts = Array.from({ length: n }, () => Array(n).fill(0))
  for (let k = 0; k + 1 < states.length; k++) counts[states[k]][states[k + 1]]++
  const matrix = counts.map((row) => {
    const total = row.reduce((a, b) => a + b, 0) + 0.5 * n
    return row.map((c) => (c + 0.5) / total)
  })

  const current = states[states.length - 1]

  // k-step distributions from the current state (row vector × matrixᵏ)
  const steps = []
  let dist = matrix[current]
  for (let k = 0; k < 5; k++) {
    steps.push(dist)
    const next = Array(n).fill(0)
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) next[j] += dist[i] * matrix[i][j]
    dist = next
  }

  return {
    stateStats,
    matrix,
    counts,
    current,
    steps,
    sigma,
    nRets: rets.length,
    lastClose: closes[closes.length - 1],
    lastRet: rets[rets.length - 1],
  }
}
