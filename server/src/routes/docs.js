import { Router } from 'express'
import crypto from 'node:crypto'
import * as Y from 'yjs'
import { requireAuth } from '../auth.js'
import { roleFor, canWrite } from '../roles.js'
import { fragmentToText } from '../collab/docManager.js'

const ROLES = new Set(['editor', 'viewer'])
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

export function docRoutes({ store, manager, config }) {
  const r = Router()
  r.use(requireAuth(config.jwtSecret))

  const summary = (d, userId) => ({
    id: d._id, title: d.title, role: roleFor(d, userId), ownerId: d.ownerId,
    updatedAt: d.updatedAt, createdAt: d.createdAt,
  })

  /** Loads the doc and the caller's role; sends 404/403 itself and returns null on failure. */
  async function access(req, res, { write = false, owner = false } = {}) {
    const doc = await store.getDoc(req.params.id)
    if (!doc) return void res.status(404).json({ error: 'Document not found.' })
    const role = roleFor(doc, req.user.id)
    if (!role) return void res.status(404).json({ error: 'Document not found.' }) // don't leak existence
    if (owner && role !== 'owner') return void res.status(403).json({ error: 'Only the owner can do that.' })
    if (write && !canWrite(role)) return void res.status(403).json({ error: 'You have view-only access.' })
    return { doc, role }
  }

  // ------------------------------------------------------------ documents ---

  r.get('/docs', asyncH(async (req, res) => {
    const docs = await store.listDocsForUser(req.user.id)
    res.json({ docs: docs.map((d) => summary(d, req.user.id)) })
  }))

  r.post('/docs', asyncH(async (req, res) => {
    const title = String(req.body?.title ?? '').trim().slice(0, 120) || 'Untitled'
    const doc = await store.createDoc({ title, ownerId: req.user.id })
    res.status(201).json({ doc: summary(doc, req.user.id) })
  }))

  r.get('/docs/:id', asyncH(async (req, res) => {
    const a = await access(req, res)
    if (!a) return
    const out = summary(a.doc, req.user.id)
    if (a.role === 'owner') {
      const users = await store.findUsersByIds(a.doc.members.map((m) => m.userId))
      out.members = a.doc.members.map((m) => {
        const u = users.find((x) => x._id === m.userId)
        return { userId: m.userId, role: m.role, name: u?.name, email: u?.email }
      })
      out.share = a.doc.share
    }
    res.json({ doc: out })
  }))

  r.patch('/docs/:id', asyncH(async (req, res) => {
    const a = await access(req, res, { write: true })
    if (!a) return
    const title = String(req.body?.title ?? '').trim().slice(0, 120)
    if (!title) return res.status(400).json({ error: 'Enter a title.' })
    await store.updateDoc(a.doc._id, { title })
    res.json({ ok: true })
  }))

  r.delete('/docs/:id', asyncH(async (req, res) => {
    const a = await access(req, res, { owner: true })
    if (!a) return
    manager.evict(a.doc._id) // closes sockets here and on peer instances
    await store.deleteDoc(a.doc._id)
    res.json({ ok: true })
  }))

  // -------------------------------------------------------------- sharing ---

  /** Owner grants access by email. role=null removes the member. */
  r.put('/docs/:id/members', asyncH(async (req, res) => {
    const a = await access(req, res, { owner: true })
    if (!a) return
    const email = String(req.body?.email ?? '').trim().toLowerCase()
    const role = req.body?.role ?? null
    if (role !== null && !ROLES.has(role)) return res.status(400).json({ error: 'Role must be editor or viewer.' })
    const user = await store.findUserByEmail(email)
    if (!user) return res.status(404).json({ error: 'No account uses that email yet. Ask them to sign up first.' })
    if (user._id === a.doc.ownerId) return res.status(400).json({ error: 'That person already owns this document.' })
    await store.setMember(a.doc._id, user._id, role)
    res.json({ ok: true })
  }))

  /** Owner enables/disables an invite link. role=null disables it. */
  r.post('/docs/:id/share', asyncH(async (req, res) => {
    const a = await access(req, res, { owner: true })
    if (!a) return
    const role = req.body?.role ?? null
    if (role !== null && !ROLES.has(role)) return res.status(400).json({ error: 'Role must be editor or viewer.' })
    const share = role ? { token: a.doc.share?.token ?? crypto.randomBytes(16).toString('hex'), role } : null
    await store.updateDoc(a.doc._id, { share })
    res.json({ share })
  }))

  r.post('/join/:token', asyncH(async (req, res) => {
    const doc = await store.findDocByShareToken(req.params.token)
    if (!doc?.share) return res.status(404).json({ error: 'This invite link is no longer valid.' })
    const current = roleFor(doc, req.user.id)
    // Never downgrade someone who already has equal or better access.
    if (current !== 'owner' && !(current === 'editor')) {
      if (current !== doc.share.role) await store.setMember(doc._id, req.user.id, doc.share.role)
    }
    res.json({ docId: doc._id })
  }))

  // ------------------------------------------------------------- versions ---

  r.get('/docs/:id/versions', asyncH(async (req, res) => {
    const a = await access(req, res)
    if (!a) return
    const versions = await store.listVersions(a.doc._id)
    res.json({ versions: versions.map((v) => ({ id: v._id, label: v.label, createdAt: v.createdAt, createdByName: v.createdByName })) })
  }))

  r.post('/docs/:id/versions', asyncH(async (req, res) => {
    const a = await access(req, res, { write: true })
    if (!a) return
    const label = String(req.body?.label ?? '').trim().slice(0, 80) || 'Saved version'
    const state = await manager.withDoc(a.doc._id, (d) => Buffer.from(Y.encodeStateAsUpdate(d.ydoc)))
    const v = await store.saveVersion({ docId: a.doc._id, label, state, createdBy: req.user.id, createdByName: req.user.name })
    res.status(201).json({ version: { id: v._id, label: v.label, createdAt: v.createdAt, createdByName: v.createdByName } })
  }))

  async function loadVersion(req, res) {
    const a = await access(req, res, { write: req.method === 'POST' })
    if (!a) return null
    const v = await store.getVersion(req.params.vid)
    if (!v || v.docId !== a.doc._id) return void res.status(404).json({ error: 'Version not found.' })
    return v
  }

  r.get('/docs/:id/versions/:vid', asyncH(async (req, res) => {
    const v = await loadVersion(req, res)
    if (!v) return
    const tmp = new Y.Doc()
    Y.applyUpdate(tmp, v.state)
    const text = fragmentToText(tmp.getXmlFragment('default'))
    tmp.destroy()
    res.json({ label: v.label, createdAt: v.createdAt, text })
  }))

  r.post('/docs/:id/versions/:vid/restore', asyncH(async (req, res) => {
    const v = await loadVersion(req, res)
    if (!v) return
    await manager.restore(v.docId, v.state)
    res.json({ ok: true })
  }))

  return r
}
