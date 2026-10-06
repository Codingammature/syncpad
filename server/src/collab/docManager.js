import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import { b64, unb64 } from '../util.js'

export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
export const MSG_INSTANCE = 4 // custom: server -> client, tells the UI which instance it landed on

const OPEN = 1
const safeSend = (ws, data) => {
  if (ws.readyState === OPEN) ws.send(data, (err) => err && ws.terminate())
}

/** One in-memory collaborative document on this instance. */
class SharedDoc {
  constructor(id) {
    this.id = id
    this.ydoc = new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.ydoc)
    this.awareness.setLocalState(null) // the server is not a participant
    this.conns = new Map() // ws -> Set<awareness clientID> owned by that socket
    this.pending = [] // updates waiting for the next batched DB write
    this.flushTimer = null
    this.flushChain = Promise.resolve()
    this.opsSinceCompact = 0
    this.compacting = false
    this.idleTimer = null
  }
}

/**
 * Owns all documents loaded on this instance:
 *   load  = snapshot + op log -> Y.Doc
 *   write = batched append to the op log, periodic compaction
 *   sync  = local fan-out to websockets + Redis fan-out to peer instances
 */
export class DocManager {
  constructor({ store, bus, config, log }) {
    this.store = store
    this.bus = bus
    this.config = config
    this.log = log
    this.docs = new Map()
    this.loading = new Map()
  }

  get stats() {
    let connections = 0
    for (const d of this.docs.values()) connections += d.conns.size
    return { docsLoaded: this.docs.size, connections }
  }

  // ---------------------------------------------------------------- load ---

  async get(docId) {
    const existing = this.docs.get(docId)
    if (existing) {
      clearTimeout(existing.idleTimer)
      return existing
    }
    let p = this.loading.get(docId)
    if (!p) {
      p = this.#load(docId).finally(() => this.loading.delete(docId))
      this.loading.set(docId, p)
    }
    return p
  }

  /** Run `fn` against a doc from REST handlers (no websocket attached). */
  async withDoc(docId, fn) {
    const doc = await this.get(docId)
    try {
      return await fn(doc)
    } finally {
      if (doc.conns.size === 0) this.#scheduleIdle(doc)
    }
  }

  async #load(docId) {
    const doc = new SharedDoc(docId)
    const { snapshot, ops } = await this.store.loadState(docId)
    doc.ydoc.transact(() => {
      if (snapshot) Y.applyUpdate(doc.ydoc, snapshot.state)
      for (const o of ops) Y.applyUpdate(doc.ydoc, o.update)
    }, 'load')
    doc.opsSinceCompact = ops.length
    doc.ydoc.on('update', (update, origin) => this.#onUpdate(doc, update, origin))
    doc.awareness.on('update', (changes, origin) => this.#onAwareness(doc, changes, origin))
    this.docs.set(docId, doc)
    this.#hello(doc)
    return doc
  }

  // ------------------------------------------------------------- updates ---

  #onUpdate(doc, update, origin) {
    if (origin === 'load') return
    if (origin !== 'redis') {
      // Originated on this instance: tell peers and queue for persistence.
      this.bus.publish(doc.id, { t: 'update', u: b64(update) })
      doc.pending.push(update)
      if (!doc.flushTimer) doc.flushTimer = setTimeout(() => this.flush(doc), this.config.flushMs)
    }
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeUpdate(enc, update)
    this.#broadcast(doc, encoding.toUint8Array(enc))
  }

  #onAwareness(doc, { added, updated, removed }, origin) {
    const changed = added.concat(updated, removed)
    if (origin !== 'redis' && doc.conns.has(origin)) {
      const owned = doc.conns.get(origin)
      added.forEach((id) => owned.add(id))
      removed.forEach((id) => owned.delete(id))
    }
    const update = awarenessProtocol.encodeAwarenessUpdate(doc.awareness, changed)
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_AWARENESS)
    encoding.writeVarUint8Array(enc, update)
    this.#broadcast(doc, encoding.toUint8Array(enc))
    if (origin !== 'redis') this.bus.publish(doc.id, { t: 'awareness', u: b64(update) })
  }

  #broadcast(doc, msg) {
    for (const ws of doc.conns.keys()) safeSend(ws, msg)
  }

  // ------------------------------------------------- peer-instance traffic ---

  /** Ask peers for anything we might have missed while (re)loading this doc. */
  #hello(doc) {
    this.bus.publish(doc.id, { t: 'hello', sv: b64(Y.encodeStateVector(doc.ydoc)) })
  }

  helloAll() {
    for (const doc of this.docs.values()) this.#hello(doc)
  }

  onBus(docId, msg) {
    if (msg.t === 'evict') return this.evict(docId, false)
    const doc = this.docs.get(docId)
    if (!doc) return // nobody here cares about this doc
    switch (msg.t) {
      case 'update':
        Y.applyUpdate(doc.ydoc, unb64(msg.u), 'redis')
        break
      case 'awareness':
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, unb64(msg.u), 'redis')
        break
      case 'hello': {
        const diff = Y.encodeStateAsUpdate(doc.ydoc, unb64(msg.sv))
        if (diff.length > 2) this.bus.publish(docId, { t: 'update', u: b64(diff) })
        const ids = Array.from(doc.awareness.getStates().keys())
        if (ids.length) {
          const aw = awarenessProtocol.encodeAwarenessUpdate(doc.awareness, ids)
          this.bus.publish(docId, { t: 'awareness', u: b64(aw) })
        }
        break
      }
    }
  }

  // --------------------------------------------------------- connections ---

  connect(doc, ws) {
    doc.conns.set(ws, new Set())
    clearTimeout(doc.idleTimer)
  }

  disconnect(doc, ws) {
    const owned = doc.conns.get(ws)
    doc.conns.delete(ws)
    if (owned?.size) awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(owned), null)
    if (doc.conns.size === 0) this.#scheduleIdle(doc)
  }

  // --------------------------------------------------------- persistence ---

  flush(doc) {
    // Serialise flushes per doc so ops are appended in order.
    doc.flushChain = doc.flushChain.then(() => this.#doFlush(doc)).catch(() => {})
    return doc.flushChain
  }

  async #doFlush(doc) {
    clearTimeout(doc.flushTimer)
    doc.flushTimer = null
    if (!doc.pending.length) return
    const batch = doc.pending
    doc.pending = []
    const merged = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch)
    try {
      await this.store.appendOp(doc.id, merged)
      doc.opsSinceCompact++
      this.store.touchDoc(doc.id).catch(() => {})
    } catch (err) {
      this.log.error(`flush failed for ${doc.id}, will retry:`, err.message)
      doc.pending.unshift(merged)
      doc.flushTimer = setTimeout(() => this.flush(doc), 1000)
      return
    }
    if (doc.opsSinceCompact >= this.config.compactEvery) this.compact(doc)
  }

  /**
   * Fold snapshot + ops into a new snapshot. Works from what is in the DB (not
   * this instance's memory) so it can never drop another instance's ops, and uses
   * optimistic versioning so concurrent compactions cannot clobber each other.
   */
  async compact(doc) {
    if (doc.compacting) return
    doc.compacting = true
    try {
      const { snapshot, ops } = await this.store.loadState(doc.id)
      if (!ops.length) return void (doc.opsSinceCompact = 0)
      const tmp = new Y.Doc()
      if (snapshot) Y.applyUpdate(tmp, snapshot.state)
      for (const o of ops) Y.applyUpdate(tmp, o.update)
      const state = Buffer.from(Y.encodeStateAsUpdate(tmp))
      tmp.destroy()
      const ok = await this.store.compact(doc.id, snapshot?.version ?? 0, state, ops.map((o) => o.id))
      doc.opsSinceCompact = ok ? 0 : Math.floor(this.config.compactEvery / 2) // lost the race; retry later
    } catch (err) {
      this.log.error(`compaction failed for ${doc.id}:`, err.message)
    } finally {
      doc.compacting = false
    }
  }

  #scheduleIdle(doc) {
    clearTimeout(doc.idleTimer)
    doc.idleTimer = setTimeout(() => this.#unload(doc), this.config.docIdleMs)
  }

  async #unload(doc) {
    if (doc.conns.size) return
    await this.flush(doc)
    if (doc.opsSinceCompact > 0) await this.compact(doc)
    if (doc.conns.size || this.docs.get(doc.id) !== doc) return
    this.docs.delete(doc.id)
    doc.awareness.destroy()
    doc.ydoc.destroy()
  }

  /** Drop a doc from memory and close its sockets (doc deleted). */
  evict(docId, publish = true) {
    const doc = this.docs.get(docId)
    if (publish) this.bus.publish(docId, { t: 'evict' })
    if (!doc) return
    this.docs.delete(docId)
    clearTimeout(doc.flushTimer)
    clearTimeout(doc.idleTimer)
    for (const ws of doc.conns.keys()) ws.close(4404, 'document deleted')
    doc.awareness.destroy()
    doc.ydoc.destroy()
  }

  async shutdown() {
    await Promise.all([...this.docs.values()].map((d) => this.flush(d)))
    for (const d of this.docs.values()) {
      clearTimeout(d.idleTimer)
      d.awareness.destroy()
    }
  }

  // -------------------------------------------------------- doc utilities ---

  /** Replace the live document body with a saved version's content. */
  async restore(docId, versionState) {
    await this.withDoc(docId, (doc) => {
      const src = new Y.Doc()
      Y.applyUpdate(src, versionState)
      doc.ydoc.transact(() => {
        const target = doc.ydoc.getXmlFragment('default')
        target.delete(0, target.length)
        target.insert(0, src.getXmlFragment('default').toArray().map((n) => n.clone()))
      }, 'restore')
      src.destroy()
    })
  }
}

/** Plain-text rendering of a TipTap/ProseMirror fragment (for version previews). */
export function fragmentToText(node) {
  if (node instanceof Y.XmlText) {
    return node.toDelta().map((d) => (typeof d.insert === 'string' ? d.insert : '')).join('')
  }
  const kids = node.toArray()
  const parts = kids.map(fragmentToText)
  return parts.join(kids.every((k) => k instanceof Y.XmlText) ? '' : '\n')
}
