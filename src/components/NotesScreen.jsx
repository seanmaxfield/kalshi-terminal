import React, { useState } from 'react'

// MSGM / IB re-expressed: a local trading journal (notes tied to markets).
const LS = 'kalshi-notes'
const load = () => { try { return JSON.parse(localStorage.getItem(LS)) || [] } catch { return [] } }

export default function NotesScreen({ selected, onClose }) {
  const [notes, setNotes] = useState(load)
  const [text, setText] = useState('')
  const [onlySel, setOnlySel] = useState(Boolean(selected))
  const ticker = selected?.market?.ticker || null

  const save = (n) => { setNotes(n); localStorage.setItem(LS, JSON.stringify(n)) }
  const add = () => {
    if (!text.trim()) return
    save([{ ts: Date.now(), ticker, title: selected?.event?.title || null, text: text.trim() }, ...notes])
    setText('')
  }
  const shown = notes.filter((n) => !onlySel || !ticker || n.ticker === ticker)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">MSGM · TRADING JOURNAL</span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="notes-body">
          <div className="dim small">
            {ticker ? <>note will be tagged to <b className="amber-text">{ticker}</b></> : 'no market selected — general note'}
          </div>
          <textarea className="settings-input" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="thesis, entry reason, what to watch…" />
          <div className="settings-actions">
            <button className="submit yes" style={{ maxWidth: 140 }} onClick={add}>SAVE NOTE</button>
            {ticker && (
              <button className="table-toggle" onClick={() => setOnlySel((v) => !v)}>{onlySel ? 'SHOW ALL' : 'ONLY THIS MARKET'}</button>
            )}
            <span className="dim small">{notes.length} notes · stored in this browser</span>
          </div>
          <div className="news-list news-list-tall">
            {shown.map((n) => (
              <div key={n.ts} className="note-item">
                <div className="news-meta dim">
                  {new Date(n.ts).toLocaleString()} {n.ticker ? `· ${n.ticker}` : ''} {n.title ? `· ${n.title}` : ''}
                  <button className="link-btn" style={{ marginLeft: 8 }} onClick={() => save(notes.filter((x) => x.ts !== n.ts))}>DEL</button>
                </div>
                <div className="note-text">{n.text}</div>
              </div>
            ))}
            {shown.length === 0 && <div className="dim" style={{ padding: 10 }}>no notes yet</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
