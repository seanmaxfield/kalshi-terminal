import React, { useEffect, useState } from 'react'
import { api, fmtMoney } from '../api.js'
import { loadPrefs, savePrefs } from '../lib/prefs.js'

export default function SettingsModal({ onClose, onConfigChange, onPrefsChange }) {
  const [prefs, setPrefsState] = useState(loadPrefs)
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState(null)
  const [saved, setSaved] = useState(null)
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [confirmReset, setConfirmReset] = useState(false)

  const [env, setEnv] = useState('prod')
  const [keyId, setKeyId] = useState('')
  const [keyPath, setKeyPath] = useState('')
  const [pem, setPem] = useState('')
  const [keyStatus, setKeyStatus] = useState({ ok: false, error: null, auth: false })

  const refresh = () =>
    api('/_settings')
      .then((d) => {
        setEnv(d.env)
        setKeyId(d.keyId)
        setKeyPath(d.privateKeyPath)
        setKeyStatus({ ok: d.keyFileOk, error: d.keyError, auth: d.authConfigured })
        setLoaded(true)
      })
      .catch((e) => {
        setErr(
          e.message.includes('404') || e.status === 404
            ? 'Settings endpoint not found — restart the dev server (npm run dev) to pick up the new proxy code.'
            : e.message
        )
        setLoaded(true)
      })

  useEffect(() => { refresh() }, [])

  const save = async () => {
    setBusy(true)
    setErr(null)
    setSaved(null)
    setTestResult(null)
    try {
      const body = { env, keyId, privateKeyPath: keyPath }
      if (pem.trim()) body.privateKeyPem = pem.trim() + '\n'
      savePrefs(prefs)
      onPrefsChange?.(prefs)
      const d = await api('/_settings', { method: 'POST', body })
      setPem('')
      setKeyPath(d.privateKeyPath)
      setKeyStatus({ ok: d.keyFileOk, error: d.keyError, auth: d.authConfigured })
      setSaved('saved — settings apply immediately, no restart needed')
      onConfigChange?.({ env: d.env, authConfigured: d.authConfigured })
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    setBusy(true)
    setErr(null)
    try {
      await api('/_settings', { method: 'POST', body: { reset: true } })
      setKeyId('')
      setKeyPath('')
      setPem('')
      setKeyStatus({ ok: false, error: null, auth: false })
      setSaved('credentials cleared — terminal is now view-only')
      setConfirmReset(false)
      onConfigChange?.({ env, authConfigured: false })
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    setTestResult(null)
    try {
      const d = await api('/portfolio/balance')
      setTestResult({ ok: true, msg: `CONNECTED — balance ${fmtMoney(d.balance)}` })
    } catch (e) {
      setTestResult({ ok: false, msg: e.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">⚙ SETUP · API & CONNECTION</span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        {!loaded && <div className="dim" style={{ padding: 16 }}>loading settings…</div>}
        {err && <div className="err-text" style={{ padding: '8px 14px' }}>{err}</div>}

        {loaded && (
          <div className="settings-body">
            <div className="settings-row">
              <span className="settings-label">EXCHANGE</span>
              <div className="seg" style={{ maxWidth: 260 }}>
                <button className={`seg-btn ${env === 'prod' ? 'on no' : ''}`} onClick={() => setEnv('prod')}>
                  PROD (REAL $)
                </button>
                <button className={`seg-btn ${env === 'demo' ? 'on yes' : ''}`} onClick={() => setEnv('demo')}>
                  DEMO (PAPER)
                </button>
              </div>
              <span className="dim small">demo needs its own API key from demo.kalshi.co</span>
            </div>

            <div className="settings-row">
              <span className="settings-label">API KEY ID</span>
              <input
                className="settings-input"
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
                placeholder="from kalshi.com → Account → API Keys"
                spellCheck={false}
              />
            </div>

            <div className="settings-row">
              <span className="settings-label">PRIVATE KEY FILE</span>
              <input
                className="settings-input"
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder="/absolute/path/to/private-key.pem"
                spellCheck={false}
              />
              <span className={keyStatus.ok ? 'ok-text' : 'dim small'}>
                {keyStatus.ok
                  ? '✓ key file loads and signs correctly'
                  : keyStatus.error
                    ? `✗ ${keyStatus.error}`
                    : 'no key configured — market data only'}
              </span>
            </div>

            <div className="settings-row">
              <span className="settings-label">OR PASTE A NEW PRIVATE KEY</span>
              <textarea
                className="settings-input settings-pem"
                value={pem}
                onChange={(e) => setPem(e.target.value)}
                placeholder={'-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----\n\nStored locally as kalshi-terminal/.kalshi-key.pem (gitignored, chmod 600). Never displayed back or sent anywhere except as request signatures to Kalshi.'}
                spellCheck={false}
                rows={5}
              />
            </div>

            <div className="settings-row">
              <span className="settings-label">PERSONAL DEFAULTS (PDF / PDFQ)</span>
              <div className="prefs-grid">
                <label className="field"><span>DEFAULT CATEGORY</span>
                  <select className="settings-input" value={prefs.defaultCategory} onChange={(e) => setPrefsState({ ...prefs, defaultCategory: e.target.value })}>
                    {['All', 'Commodities', 'Economics', 'Financials', 'Politics', 'Elections', 'Crypto', 'Sports', 'Companies', 'Climate and Weather', 'Science and Technology', 'World', 'Entertainment'].map((c) => <option key={c}>{c}</option>)}
                  </select>
                </label>
                <label className="field"><span>BOARD REFRESH (SEC)</span>
                  <input type="number" min="30" max="900" value={prefs.refreshSeconds} onChange={(e) => setPrefsState({ ...prefs, refreshSeconds: Math.max(30, Number(e.target.value) || 120) })} />
                </label>
                <label className="field"><span>DEFAULT CHART RANGE</span>
                  <select className="settings-input" value={prefs.chartRange} onChange={(e) => setPrefsState({ ...prefs, chartRange: e.target.value })}>
                    {['1D', '1W', '1M', '3M'].map((r) => <option key={r}>{r}</option>)}
                  </select>
                </label>
                <label className="field"><span>SQUAWK HEADLINES</span>
                  <input type="number" min="1" max="20" value={prefs.squawkCount} onChange={(e) => setPrefsState({ ...prefs, squawkCount: Math.max(1, Number(e.target.value) || 5) })} />
                </label>
              </div>
              <span className="dim small">applied on SAVE · stored in this browser</span>
            </div>

            <div className="settings-actions">
              <button className="submit yes" style={{ maxWidth: 160 }} disabled={busy} onClick={save}>
                {busy ? 'WORKING…' : 'SAVE'}
              </button>
              <button className="submit" style={{ maxWidth: 190 }} disabled={busy || !keyStatus.auth} onClick={test}>
                TEST CONNECTION
              </button>
              {!confirmReset ? (
                <button className="submit cancel" style={{ maxWidth: 160 }} disabled={busy} onClick={() => setConfirmReset(true)}>
                  RESET / CLEAR
                </button>
              ) : (
                <button className="submit no" style={{ maxWidth: 220 }} disabled={busy} onClick={reset}>
                  CONFIRM CLEAR CREDENTIALS
                </button>
              )}
            </div>
            {saved && <div className="ok-text" style={{ padding: '0 2px' }}>{saved}</div>}
            {testResult && (
              <div className={testResult.ok ? 'ok-text' : 'err-text'} style={{ padding: '0 2px' }}>
                {testResult.msg}
              </div>
            )}

            <div className="dim small settings-note">
              stored in kalshi-terminal/.env on this machine only · the key ID identifies you; the private key
              signs requests and never leaves this computer · RESET wipes both from .env and deletes the managed
              .kalshi-key.pem if one was pasted here
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
