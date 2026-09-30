import React from 'react'

export default function Sidebar({ categories, total, active, onSelect }) {
  return (
    <nav className="sidebar">
      <div className="panel-title">CATEGORIES</div>
      <button
        className={`cat-row ${active === 'All' ? 'active' : ''}`}
        onClick={() => onSelect('All')}
      >
        <span>ALL</span>
        <span className="cat-count">{total.toLocaleString()}</span>
      </button>
      {categories.map(([name, count]) => (
        <button
          key={name}
          className={`cat-row ${active === name ? 'active' : ''}`}
          onClick={() => onSelect(name)}
        >
          <span>{name.toUpperCase()}</span>
          <span className="cat-count">{count.toLocaleString()}</span>
        </button>
      ))}
    </nav>
  )
}
