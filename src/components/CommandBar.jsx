import React, { useEffect, useRef, useState } from 'react'
import { suggest, runCommand } from '../lib/commands.js'

// Bloomberg-style command line: type a function code (+ args) and press Enter.
// "/" or Ctrl+K focuses it from anywhere; Esc = MENU (close top window).
export default function CommandBar({ ctx, toast }) {
  const [value, setValue] = useState('')
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const [history, setHistory] = useState([])
  const [histIdx, setHistIdx] = useState(-1)
  const inputRef = useRef(null)

  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA'
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
      if (e.key === 'Escape') {
        if (document.activeElement === inputRef.current) inputRef.current.blur()
        ctx.closeAll()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ctx])

  const sugg = open ? suggest(value) : []

  const submit = (text) => {
    const t = (text ?? value).trim()
    if (!t) return
    runCommand(t, ctx)
    setHistory((h) => [t, ...h.filter((x) => x !== t)].slice(0, 50))
    setHistIdx(-1)
    setValue('')
    setOpen(false)
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (open && sugg[hi] && !value.includes(' ') && value.trim().toUpperCase() !== sugg[hi].code) {
        // complete to highlighted suggestion, keep typing args if it takes any
        if (sugg[hi].usage) { setValue(sugg[hi].code + ' '); return }
        submit(sugg[hi].code)
      } else submit()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (open && sugg.length) setHi((h) => (h + 1) % sugg.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (open && sugg.length && value) setHi((h) => (h - 1 + sugg.length) % sugg.length)
      else if (history.length) {
        const i = Math.min(history.length - 1, histIdx + 1)
        setHistIdx(i); setValue(history[i])
      }
    } else if (e.key === 'Tab' && open && sugg[hi]) {
      e.preventDefault()
      setValue(sugg[hi].code + (sugg[hi].usage ? ' ' : ''))
    }
  }

  return (
    <div className="cmdbar">
      <span className="cmd-prompt">&gt;</span>
      <input
        ref={inputRef}
        className="cmd-input"
        placeholder="COMMAND  (MAIN · HELP · WEI · NRG · YAS · GPO … · / to focus)"
        value={value}
        spellCheck={false}
        onChange={(e) => { setValue(e.target.value.toUpperCase()); setOpen(true); setHi(0) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      <button className="cmd-go" onMouseDown={(e) => e.preventDefault()} onClick={() => submit()}>GO</button>
      {open && sugg.length > 0 && (
        <div className="cmd-sugg">
          {sugg.map((c, i) => (
            <div
              key={c.code}
              className={`cmd-sugg-row ${i === hi ? 'on' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); if (c.usage) { setValue(c.code + ' '); inputRef.current?.focus() } else submit(c.code) }}
              onMouseEnter={() => setHi(i)}
            >
              <span className="cmd-code">{c.code}</span>
              <span className="cmd-usage dim">{c.usage || ''}</span>
              <span className="cmd-desc">{c.desc}</span>
              <span className="cmd-group dim">{c.group}</span>
            </div>
          ))}
          <div className="cmd-sugg-foot dim">↑↓ select · Tab complete · Enter run · unknown text = HELP search</div>
        </div>
      )}
    </div>
  )
}
