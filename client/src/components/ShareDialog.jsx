import { useEffect, useState } from 'react'
import { api } from '../api.js'

const ROLE_LABEL = { editor: 'Can edit', viewer: 'View only' }

export default function ShareDialog({ docId, onClose }) {
  const [doc, setDoc] = useState(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('editor')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const load = () => api(`/docs/${docId}`).then((r) => setDoc(r.doc)).catch((e) => setError(e.message))
  useEffect(() => { load() }, [docId])
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function run(fn) {
    setError('')
    try {
      await fn()
      await load()
    } catch (e) {
      setError(e.message)
    }
  }

  const link = doc?.share ? `${location.origin}/join/${doc.share.token}` : ''

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <header>
          <h2 id="share-title">Share this document</h2>
          <button className="ghost" onClick={onClose} aria-label="Close">Close</button>
        </header>

        <h3>Invite link</h3>
        <div className="row">
          <select
            value={doc?.share?.role ?? 'off'} aria-label="Link access"
            onChange={(e) => run(() => api(`/docs/${docId}/share`, { method: 'POST', body: { role: e.target.value === 'off' ? null : e.target.value } }))}
          >
            <option value="off">Link is off</option>
            <option value="viewer">Anyone with the link can view</option>
            <option value="editor">Anyone with the link can edit</option>
          </select>
        </div>
        {link && (
          <div className="row">
            <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invite link" />
            <button className="primary" onClick={() => navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        )}

        <h3>People</h3>
        <form
          className="row"
          onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/docs/${docId}/members`, { method: 'PUT', body: { email, role } }); setEmail('') }) }}
        >
          <input type="email" placeholder="Email of someone with an account" value={email} onChange={(e) => setEmail(e.target.value)} required aria-label="Email" />
          <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
            <option value="editor">Can edit</option>
            <option value="viewer">View only</option>
          </select>
          <button className="primary">Add</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        <ul className="members">
          {doc?.members?.length === 0 && <li className="muted">Only you have access so far.</li>}
          {doc?.members?.map((m) => (
            <li key={m.userId}>
              <span>{m.name} <span className="muted">{m.email}</span></span>
              <select value={m.role} aria-label={`Role for ${m.name}`} onChange={(e) => run(() => api(`/docs/${docId}/members`, { method: 'PUT', body: { email: m.email, role: e.target.value } }))}>
                {Object.entries(ROLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <button className="ghost danger" onClick={() => run(() => api(`/docs/${docId}/members`, { method: 'PUT', body: { email: m.email, role: null } }))}>Remove</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
