import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, api, connect, until, sleep } from './helpers.js'

const app = await startApp({ compactEvery: 3 })
const http = api(app)
after(() => app.close())

const setup = async () => {
  const alice = await http.register('Alice')
  const bob = await http.register('Bob')
  const { body } = await http.call('POST', '/api/docs', { title: 'Spec' }, alice.token)
  return { alice, bob, docId: body.doc.id }
}

test('two editors converge on concurrent edits', async () => {
  const { alice, bob, docId } = await setup()
  await http.call('PUT', `/api/docs/${docId}/members`, { email: (await app.store.findUserById(bob.user.id)).email, role: 'editor' }, alice.token)
  const a = connect(app, docId, alice.token)
  const b = connect(app, docId, bob.token)
  await Promise.all([a.synced, b.synced])

  a.ydoc.getText('t').insert(0, 'hello ')
  b.ydoc.getText('t').insert(0, 'world ')
  await until(() => a.ydoc.getText('t').length === 12 && b.ydoc.getText('t').length === 12)
  assert.equal(a.ydoc.getText('t').toString(), b.ydoc.getText('t').toString())
  a.close(); b.close()
})

test('viewers can read but their writes are rejected server-side', async () => {
  const { alice, bob, docId } = await setup()
  await http.call('PUT', `/api/docs/${docId}/members`, { email: (await app.store.findUserById(bob.user.id)).email, role: 'viewer' }, alice.token)
  const a = connect(app, docId, alice.token)
  const v = connect(app, docId, bob.token)
  await Promise.all([a.synced, v.synced])

  a.ydoc.getText('t').insert(0, 'from alice')
  await until(() => v.ydoc.getText('t').toString() === 'from alice') // read works

  v.ydoc.getText('t').insert(0, 'HACK ') // local-only change on the viewer
  await sleep(150)
  assert.equal(a.ydoc.getText('t').toString(), 'from alice') // never reached the server
  a.close(); v.close()
})

test('websocket upgrade is refused without a valid token or access', async () => {
  const { alice, bob, docId } = await setup()
  for (const token of ['garbage', bob.token]) {
    const c = connect(app, docId, token)
    let opened = false
    c.provider.on('status', ({ status }) => status === 'connected' && (opened = true))
    await sleep(300)
    assert.equal(opened, false, `token ${token.slice(0, 6)} must not connect`)
    c.close()
  }
  const ok = connect(app, docId, alice.token)
  await ok.synced
  ok.close()
})

test('content survives all clients leaving (persisted + compacted)', async () => {
  const { alice, docId } = await setup()
  const a = connect(app, docId, alice.token)
  await a.synced
  for (let i = 0; i < 12; i++) {
    a.ydoc.getText('t').insert(a.ydoc.getText('t').length, `line ${i}\n`)
    await sleep(40) // > flushMs, so each edit becomes its own op
  }
  a.close()

  // idle unload flushes and compacts; ops should have been folded into a snapshot
  await until(() => app.manager.stats.docsLoaded === 0, { timeout: 5000 })
  const { snapshot, ops } = await app.store.loadState(docId)
  assert.ok(snapshot, 'a snapshot was written')
  assert.ok(ops.length < 3, `ops were compacted (left: ${ops.length})`)

  const b = connect(app, docId, alice.token)
  await b.synced
  assert.equal(b.ydoc.getText('t').toString().split('\n').filter(Boolean).length, 12)
  b.close()
})

test('server tells the client which instance it is connected to', async () => {
  const { alice, docId } = await setup()
  const a = connect(app, docId, alice.token, { params: { instance: '1' } })
  let seen
  const { readVarString } = await import('lib0/decoding')
  a.provider.messageHandlers[4] = (_enc, dec) => (seen = readVarString(dec))
  await a.synced
  await until(() => seen)
  assert.equal(seen, app.config.instanceId)
  a.close()
})

test('version restore replaces live content for connected clients', async () => {
  const { alice, docId } = await setup()
  const a = connect(app, docId, alice.token)
  await a.synced
  const frag = a.ydoc.getXmlFragment('default')
  const Y = await import('yjs')
  const para = (text) => {
    const p = new Y.XmlElement('paragraph')
    const t = new Y.XmlText(); t.insert(0, text); p.insert(0, [t])
    return p
  }
  frag.insert(0, [para('first draft')])
  await sleep(100)
  const saved = await http.call('POST', `/api/docs/${docId}/versions`, { label: 'v1' }, alice.token)
  assert.equal(saved.status, 201)

  frag.delete(0, frag.length)
  frag.insert(0, [para('something else entirely')])
  await sleep(100)

  const preview = await http.call('GET', `/api/docs/${docId}/versions/${saved.body.version.id}`, null, alice.token)
  assert.equal(preview.body.text, 'first draft')
  await http.call('POST', `/api/docs/${docId}/versions/${saved.body.version.id}/restore`, {}, alice.token)
  await until(() => a.ydoc.getXmlFragment('default').toArray().map((n) => n.toString()).join('').includes('first draft'))
  a.close()
})

test('rate limiter closes abusive sockets', async () => {
  const tight = await startApp({ wsMsgsPerSec: 5, wsBurst: 10 })
  const h = api(tight)
  const u = await h.register('Spammer')
  const { body } = await h.call('POST', '/api/docs', { title: 'x' }, u.token)
  const c = connect(tight, body.doc.id, u.token)
  await c.synced
  let code
  c.provider.on('connection-close', (ev) => (code ??= ev.code))
  for (let i = 0; i < 200; i++) c.ydoc.getText('t').insert(0, 'x') // 200 separate messages
  await until(() => code === 4429)
  c.close()
  await tight.close()
})
