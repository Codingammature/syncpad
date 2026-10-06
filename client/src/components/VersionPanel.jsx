import { useEffect, useState } from 'react'
import { api, timeAgo } from '../api.js'

export default function VersionPanel({ docId, canEdit, onClose }) {
  const [versions, setVersions] = useState(null)
  const [label, setLabel] = useState('')
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => api(`/docs/${docId}/versions`).then((r) => setVersions(r.versions)).catch((e) => setError(e.message))
  useEffect(() => { load() }, [docId])

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api(`/docs/${docId}/versions`, { method: 'POST', body: { label } })
      setLabel('')
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function show(v) {
    setError('')
    try {
      setPreview({ id: v.id, ...(await api(`/docs/${docId}/versions/${v.id}`)) })
    } catch (err) {
      setError(err.message)
    }
  }

  async function restore(v) {
    if (!confirm(`Restore “${v.label}”? Everyone currently editing will see the document change.`)) return
    setError('')
    try {
      await api(`/docs/${docId}/versions/${v.id}/restore`, { method: 'POST' })
      setPreview(null)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <aside className="history" aria-label="Version history">
      <header>
        <h2>Version history</h2>
        <button className="ghost" onClick={onClose} aria-label="Close history">Close</button>
      </header>
      {canEdit && (
        <form className="row" onSubmit={save}>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name this version" maxLength={80} aria-label="Version name" />
          <button className="primary" disabled={busy}>Save</button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {versions?.length === 0 && <p className="muted">No saved versions yet. Save one before making big changes.</p>}
      <ul>
        {versions?.map((v) => (
          <li key={v.id} className={preview?.id === v.id ? 'active' : ''}>
            <div>
              <strong>{v.label}</strong>
              <span className="muted">{v.createdByName} · {timeAgo(v.createdAt)}</span>
            </div>
            <div className="row">
              <button className="ghost" onClick={() => show(v)}>Preview</button>
              {canEdit && <button className="ghost" onClick={() => restore(v)}>Restore</button>}
            </div>
          </li>
        ))}
      </ul>
      {preview && <pre className="preview" aria-label={`Preview of ${preview.label}`}>{preview.text || '(empty document)'}</pre>}
    </aside>
  )
}
