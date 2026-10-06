import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import { WebsocketProvider } from 'y-websocket'
import { IndexeddbPersistence } from 'y-indexeddb'
import { api, colorFor, wsBase } from '../api.js'
import { useAuth } from '../App.jsx'
import Toolbar from '../components/Toolbar.jsx'
import ShareDialog from '../components/ShareDialog.jsx'
import VersionPanel from '../components/VersionPanel.jsx'

const MSG_INSTANCE = 4 // custom server message: which instance am I connected to?

export default function EditorPage() {
  const { id } = useParams()
  const { session } = useAuth()
  const [doc, setDoc] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setDoc(null)
    api(`/docs/${id}`).then((r) => setDoc(r.doc)).catch((e) => setError(e.message))
  }, [id])

  if (error) {
    return (
      <main className="center">
        <p className="error" role="alert">{error}</p>
        <Link to="/">Back to documents</Link>
      </main>
    )
  }
  if (!doc) return <main className="center"><p className="muted">Loading…</p></main>
  return <CollabSession key={doc.id} doc={doc} setDoc={setDoc} session={session} />
}

/** Owns the Yjs doc + network/offline providers for one open document. */
function CollabSession({ doc, setDoc, session }) {
  const navigate = useNavigate()
  const [collab, setCollab] = useState(null)
  const [status, setStatus] = useState('connecting')
  const [synced, setSynced] = useState(false)
  const [instance, setInstance] = useState('')
  const [notice, setNotice] = useState('')
  const [peers, setPeers] = useState([])
  const me = useMemo(() => ({ name: session.user.name, color: colorFor(session.user.id) }), [session.user])

  useEffect(() => {
    const ydoc = new Y.Doc()
    // Offline persistence: edits made without a connection live in IndexedDB and merge on reconnect.
    const local = new IndexeddbPersistence(`syncpad:${doc.id}`, ydoc)
    const provider = new WebsocketProvider(wsBase(), doc.id, ydoc, {
      params: { token: session.token, instance: '1' },
    })
    provider.messageHandlers[MSG_INSTANCE] = (_enc, dec) => setInstance(decoding.readVarString(dec))
    provider.awareness.setLocalStateField('user', me)

    const onStatus = ({ status }) => {
      setStatus(status)
      if (status === 'connected') setNotice('')
    }
    const onSync = (s) => setSynced(s)
    const onClose = (ev) => {
      if (ev.code === 4429) setNotice('You’re sending changes too fast. Reconnecting…')
      if (ev.code === 4404) navigate('/', { replace: true })
    }
    const onAwareness = () => {
      const seen = new Map()
      provider.awareness.getStates().forEach((s, clientId) => {
        if (clientId !== provider.awareness.clientID && s.user) seen.set(`${s.user.name}|${s.user.color}`, s.user)
      })
      setPeers([...seen.values()])
    }
    provider.on('status', onStatus)
    provider.on('sync', onSync)
    provider.on('connection-close', onClose)
    provider.awareness.on('change', onAwareness)
    setCollab({ ydoc, provider })

    return () => {
      provider.awareness.off('change', onAwareness)
      provider.destroy()
      local.destroy()
      ydoc.destroy()
      setCollab(null)
    }
  }, [doc.id, session.token, me, navigate])

  const canEdit = doc.role !== 'viewer'
  const [showShare, setShowShare] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [title, setTitle] = useState(doc.title)

  async function saveTitle() {
    const t = title.trim()
    if (!t || t === doc.title) return setTitle(doc.title)
    try {
      await api(`/docs/${doc.id}`, { method: 'PATCH', body: { title: t } })
      setDoc({ ...doc, title: t })
    } catch (e) {
      setNotice(e.message)
      setTitle(doc.title)
    }
  }

  const live = status === 'connected' && synced
  return (
    <div className="shell editor-shell">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Back to documents">SyncPad</Link>
        <input
          className="title-input" value={title} readOnly={!canEdit} aria-label="Document title"
          onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span className={`wire ${live ? 'wire-live' : status === 'connecting' ? 'wire-wait' : 'wire-off'}`} role="status">
          <span className="dot" />
          {live ? (instance ? `Live on ${instance}` : 'Live') : status === 'connecting' ? 'Connecting…' : 'Offline'}
        </span>
        <span className="spacer" />
        <ul className="avatars" aria-label="People here now">
          <li className="avatar" style={{ background: me.color }} title={`${me.name} (you)`}>{me.name[0]?.toUpperCase()}</li>
          {peers.map((p) => (
            <li key={p.name + p.color} className="avatar" style={{ background: p.color }} title={p.name}>{p.name[0]?.toUpperCase()}</li>
          ))}
        </ul>
        <button className="ghost" onClick={() => setShowHistory((v) => !v)} aria-pressed={showHistory}>History</button>
        {doc.role === 'owner' && <button className="primary" onClick={() => setShowShare(true)}>Share</button>}
        {!canEdit && <span className="role role-viewer">View only</span>}
      </header>

      {status === 'disconnected' && (
        <p className="banner">You’re offline. Keep typing: changes are saved on this device and sync when you reconnect.</p>
      )}
      {notice && <p className="banner">{notice}</p>}

      <div className="editor-body">
        {collab ? <Surface collab={collab} me={me} canEdit={canEdit} /> : <p className="muted center">Connecting…</p>}
        {showHistory && <VersionPanel docId={doc.id} canEdit={canEdit} onClose={() => setShowHistory(false)} />}
      </div>

      {showShare && <ShareDialog docId={doc.id} onClose={() => setShowShare(false)} />}
    </div>
  )
}

function Surface({ collab, me, canEdit }) {
  const editor = useEditor(
    {
      editable: canEdit,
      extensions: [
        StarterKit.configure({ history: false }), // Yjs provides collaborative undo/redo
        Collaboration.configure({ document: collab.ydoc }),
        CollaborationCursor.configure({ provider: collab.provider, user: me }),
      ],
      editorProps: { attributes: { class: 'prose', 'aria-label': 'Document body' } },
    },
    [collab],
  )
  return (
    <div className="desk">
      {canEdit && <Toolbar editor={editor} />}
      <article className="sheet"><EditorContent editor={editor} /></article>
    </div>
  )
}
