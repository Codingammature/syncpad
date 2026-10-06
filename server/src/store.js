import { randomUUID } from 'node:crypto'
import { MongoClient, Binary } from 'mongodb'

/**
 * Storage layer. Two interchangeable implementations behind one interface:
 *   - MongoStore  : production
 *   - MemoryStore : zero-dependency dev/test mode (MONGO_URI unset)
 *
 * CRDT persistence model (see docs/DESIGN.md):
 *   ops        append-only log of Yjs updates (cheap writes)
 *   snapshots  one compacted state per doc, guarded by an optimistic `version`
 */

// BSON Binary -> Buffer (respect `position`: the backing buffer can be larger than the payload)
const toBuf = (b) => (b instanceof Binary ? Buffer.from(b.buffer.subarray(0, b.position)) : Buffer.from(b))

export async function createStore(config) {
  return config.mongoUri ? MongoStore.connect(config) : new MemoryStore()
}

// ---------------------------------------------------------------- Memory ---

class MemoryStore {
  kind = 'memory'
  users = new Map()
  docs = new Map()
  ops = new Map() // docId -> [{id, update}]
  snapshots = new Map() // docId -> {state, version}
  versions = new Map() // id -> version record
  seq = 0

  async createUser(u) {
    const user = { _id: randomUUID(), createdAt: new Date(), ...u }
    this.users.set(user._id, user)
    return user
  }
  async findUserByEmail(email) {
    return [...this.users.values()].find((u) => u.email === email) ?? null
  }
  async findUserById(id) {
    return this.users.get(id) ?? null
  }
  async findUsersByIds(ids) {
    return ids.map((i) => this.users.get(i)).filter(Boolean)
  }

  async createDoc({ title, ownerId }) {
    const doc = {
      _id: randomUUID(), title, ownerId, members: [], share: null,
      createdAt: new Date(), updatedAt: new Date(),
    }
    this.docs.set(doc._id, doc)
    return doc
  }
  async getDoc(id) {
    return this.docs.get(id) ?? null
  }
  async listDocsForUser(userId) {
    return [...this.docs.values()]
      .filter((d) => d.ownerId === userId || d.members.some((m) => m.userId === userId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }
  async updateDoc(id, patch) {
    const d = this.docs.get(id)
    if (d) Object.assign(d, patch, { updatedAt: new Date() })
    return d ?? null
  }
  async touchDoc(id) {
    const d = this.docs.get(id)
    if (d) d.updatedAt = new Date()
  }
  async setMember(id, userId, role) {
    const d = this.docs.get(id)
    d.members = d.members.filter((m) => m.userId !== userId)
    if (role) d.members.push({ userId, role })
  }
  async findDocByShareToken(token) {
    return [...this.docs.values()].find((d) => d.share?.token === token) ?? null
  }
  async deleteDoc(id) {
    this.docs.delete(id)
    this.ops.delete(id)
    this.snapshots.delete(id)
    for (const [k, v] of this.versions) if (v.docId === id) this.versions.delete(k)
  }

  async appendOp(docId, update) {
    const id = ++this.seq
    if (!this.ops.has(docId)) this.ops.set(docId, [])
    this.ops.get(docId).push({ id, update: Buffer.from(update) })
    return id
  }
  async loadState(docId) {
    const snap = this.snapshots.get(docId)
    return {
      snapshot: snap ? { state: snap.state, version: snap.version } : null,
      ops: [...(this.ops.get(docId) ?? [])],
    }
  }
  async compact(docId, expectedVersion, newState, opIds) {
    const cur = this.snapshots.get(docId)?.version ?? 0
    if (cur !== expectedVersion) return false
    this.snapshots.set(docId, { state: Buffer.from(newState), version: cur + 1 })
    const drop = new Set(opIds)
    this.ops.set(docId, (this.ops.get(docId) ?? []).filter((o) => !drop.has(o.id)))
    return true
  }

  async saveVersion(rec) {
    const v = { _id: randomUUID(), createdAt: new Date(), ...rec, state: Buffer.from(rec.state) }
    this.versions.set(v._id, v)
    return v
  }
  async listVersions(docId) {
    return [...this.versions.values()]
      .filter((v) => v.docId === docId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ state, ...meta }) => meta)
  }
  async getVersion(id) {
    return this.versions.get(id) ?? null
  }
  async close() {}
}

// ----------------------------------------------------------------- Mongo ---

class MongoStore {
  kind = 'mongo'

  static async connect(config) {
    const client = new MongoClient(config.mongoUri)
    await client.connect()
    const s = new MongoStore(client, client.db(config.mongoDb))
    await s.ensureIndexes()
    return s
  }

  constructor(client, db) {
    this.client = client
    this.users = db.collection('users')
    this.docs = db.collection('docs')
    this.opsCol = db.collection('ops')
    this.snaps = db.collection('snapshots')
    this.versionsCol = db.collection('versions')
  }

  async ensureIndexes() {
    await Promise.all([
      this.users.createIndex({ email: 1 }, { unique: true }),
      this.docs.createIndex({ ownerId: 1, updatedAt: -1 }),
      this.docs.createIndex({ 'members.userId': 1 }),
      this.docs.createIndex({ 'share.token': 1 }, { sparse: true }),
      this.opsCol.createIndex({ docId: 1, _id: 1 }),
      this.versionsCol.createIndex({ docId: 1, createdAt: -1 }),
    ])
  }

  async createUser(u) {
    const user = { _id: randomUUID(), createdAt: new Date(), ...u }
    await this.users.insertOne(user)
    return user
  }
  findUserByEmail(email) { return this.users.findOne({ email }) }
  findUserById(id) { return this.users.findOne({ _id: id }) }
  findUsersByIds(ids) { return this.users.find({ _id: { $in: ids } }).toArray() }

  async createDoc({ title, ownerId }) {
    const doc = {
      _id: randomUUID(), title, ownerId, members: [], share: null,
      createdAt: new Date(), updatedAt: new Date(),
    }
    await this.docs.insertOne(doc)
    return doc
  }
  getDoc(id) { return this.docs.findOne({ _id: id }) }
  listDocsForUser(userId) {
    return this.docs
      .find({ $or: [{ ownerId: userId }, { 'members.userId': userId }] })
      .sort({ updatedAt: -1 })
      .toArray()
  }
  async updateDoc(id, patch) {
    return this.docs.findOneAndUpdate(
      { _id: id },
      { $set: { ...patch, updatedAt: new Date() } },
      { returnDocument: 'after' },
    )
  }
  async touchDoc(id) {
    await this.docs.updateOne({ _id: id }, { $set: { updatedAt: new Date() } })
  }
  async setMember(id, userId, role) {
    await this.docs.updateOne({ _id: id }, { $pull: { members: { userId } } })
    if (role) await this.docs.updateOne({ _id: id }, { $push: { members: { userId, role } } })
  }
  findDocByShareToken(token) { return this.docs.findOne({ 'share.token': token }) }
  async deleteDoc(id) {
    await Promise.all([
      this.docs.deleteOne({ _id: id }),
      this.opsCol.deleteMany({ docId: id }),
      this.snaps.deleteOne({ _id: id }),
      this.versionsCol.deleteMany({ docId: id }),
    ])
  }

  async appendOp(docId, update) {
    const r = await this.opsCol.insertOne({ docId, update: new Binary(update), ts: new Date() })
    return r.insertedId
  }
  async loadState(docId) {
    const [snap, ops] = await Promise.all([
      this.snaps.findOne({ _id: docId }),
      this.opsCol.find({ docId }).sort({ _id: 1 }).toArray(),
    ])
    return {
      snapshot: snap ? { state: toBuf(snap.state), version: snap.version } : null,
      ops: ops.map((o) => ({ id: o._id, update: toBuf(o.update) })),
    }
  }
  /**
   * Optimistic compaction: only succeeds if nobody else compacted since we read
   * `expectedVersion`. Deletes exactly the ops that were folded into the snapshot.
   */
  async compact(docId, expectedVersion, newState, opIds) {
    if (expectedVersion === 0) {
      try {
        await this.snaps.insertOne({ _id: docId, state: new Binary(newState), version: 1 })
      } catch (e) {
        if (e.code === 11000) return false
        throw e
      }
    } else {
      const r = await this.snaps.updateOne(
        { _id: docId, version: expectedVersion },
        { $set: { state: new Binary(newState) }, $inc: { version: 1 } },
      )
      if (!r.modifiedCount) return false
    }
    if (opIds.length) await this.opsCol.deleteMany({ _id: { $in: opIds } })
    return true
  }

  async saveVersion(rec) {
    const v = { _id: randomUUID(), createdAt: new Date(), ...rec, state: new Binary(rec.state) }
    await this.versionsCol.insertOne(v)
    return v
  }
  listVersions(docId) {
    return this.versionsCol
      .find({ docId }, { projection: { state: 0 } })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray()
  }
  async getVersion(id) {
    const v = await this.versionsCol.findOne({ _id: id })
    return v ? { ...v, state: toBuf(v.state) } : null
  }
  async close() { await this.client.close() }
}
