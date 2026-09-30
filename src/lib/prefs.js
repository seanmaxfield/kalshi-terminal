// Personal defaults (PDF / PDFQ), stored in this browser.
const KEY = 'kalshi-prefs'
export const DEFAULT_PREFS = {
  defaultCategory: 'All',
  refreshSeconds: 120,
  chartRange: '1W',
  strikeDecimals: null, // null = auto
  squawkCount: 5,
}
export function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(KEY)) || {}) } } catch { return { ...DEFAULT_PREFS } }
}
export function savePrefs(p) {
  localStorage.setItem(KEY, JSON.stringify(p))
}
