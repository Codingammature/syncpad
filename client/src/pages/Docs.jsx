import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, timeAgo } from '../api.js'
import { useAuth } from '../App.jsx'

const ROLE_LABEL = { owner: 'Owner', editor: 'Can edit', viewer: 'View only' }

export default function Docs() {
  const { session, signOut } = useAuth()
  const navigate = useNavigate()
  const [docs, setDocs] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api('/docs').then((r) => setDocs(r.docs)).catch((e) => setError(e.message))
  }, [])

  async function create() {
    try {
      const { doc } = await api('/docs', { method: 'POST', body: { title: 'Untitled' } })
      navigate(`/d/${doc.id}`)
    } catch (e) {
      setError(e.message)
    }
  }

  async function remove(doc) {
    if (!confirm(`Delete “${doc.title}” for everyone? This can’t be undone.`)) return
    try {
      await api(`/docs/${doc.id}`, { method: 'DELETE' })
      setDocs((d) => d.filter((x) => x.id !== doc.id))
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">SyncPad</span>
        <span className="spacer" />
        <span className="who">{session.user.name}</span>
        <button className="ghost" onClick={signOut}>Sign out</button>
      </header>
      <main className="docs">
        <div className="docs-head">
          <h1>Documents</h1>
          <button className="primary" onClick={create}>New document</button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {docs === null && !error && <p className="muted">Loading…</p>}
        {docs?.length === 0 && (
          <div className="empty">
            <p>No documents yet.</p>
            <button className="primary" onClick={create}>Create your first document</button>
          </div>
        )}
        {docs?.length > 0 && (
          <ul className="doc-list">
            {docs.map((d) => (
              <li key={d.id}>
                <Link to={`/d/${d.id}`} className="doc-title">{d.title}</Link>
                <span className={`role role-${d.role}`}>{ROLE_LABEL[d.role]}</span>
                <span className="muted">{timeAgo(d.updatedAt)}</span>
                {d.role === 'owner' ? (
                  <button className="ghost danger" onClick={() => remove(d)} aria-label={`Delete ${d.title}`}>Delete</button>
                ) : <span />}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
