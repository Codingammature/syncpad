import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { createStore } from '../src/store.js'
import { api, connect, until, sleep } from './helpers.js'

const REDIS_URL = process.env.REDIS_URL
const skip = !REDIS_URL && 'set REDIS_URL to run cross-instance tests'

// Two server instances, ONE shared store + ONE Redis: what docker-compose runs.
const shared = await createStore({})
const boot = (id, extra = {}) =>
  createApp({ port: 0, silent: true, redisUrl: REDIS_URL, instanceId: id, flushMs: 20, docIdleMs: 500, ...extra }, { store: shared })

const apps = []
after(async () => { for (const a of apps) await a.close() })

const twoInstances = async (extra) => {
  const a1 = await boot('inst-1', extra)
  const a2 = await boot('inst-2', extra)
  apps.push(a1, a2)
  const h1 = api(a1), h2 = api(a2)
  const alice = await h1.register('Alice')
  const bob = await h2.register('Bob') // same shared store, so either instance can auth him
  const { body } = await h1.call('POST', '/api/docs', { title: 'Shared' }, alice.token)
  const bobEmail = (await shared.findUserById(bob.user.id)).email
  await h1.call('PUT', `/api/docs/${body.doc.id}/members`, { email: bobEmail, role: 'editor' }, alice.token)
  return { a1, a2, alice, bob, docId: body.doc.id }
}

test('edits and presence cross instances via Redis', { skip }, async () => {
  const { a1, a2, alice, bob, docId } = await twoInstances()
  const ca = connect(a1, docId, alice.token)
  const cb = connect(a2, docId, bob.token)
  await Promise.all([ca.synced, cb.synced])

  ca.ydoc.getText('t').insert(0, 'written on instance 1')
  await until(() => cb.ydoc.getText('t').toString() === 'written on instance 1')
  cb.ydoc.getText('t').insert(0, '>> ')
  await until(() => ca.ydoc.getText('t').toString() === '>> written on instance 1')

  ca.provider.awareness.setLocalStateField('user', { name: 'Alice' })
  await until(() => [...cb.provider.awareness.getStates().values()].some((s) => s.user?.name === 'Alice'))

  ca.close() // socket closes on instance 1 -> Bob must see Alice disappear
  await until(() => ![...cb.provider.awareness.getStates().values()].some((s) => s.user?.name === 'Alice'), { timeout: 4000 })
  cb.close()
})

test('a peer that loads a doc late still gets edits the other instance has not flushed yet', { skip }, async () => {
  const { a1, a2, alice, bob, docId } = await twoInstances({ flushMs: 60_000 }) // nothing hits the DB
  const ca = connect(a1, docId, alice.token)
  await ca.synced
  ca.ydoc.getText('t').insert(0, 'only in instance-1 memory')
  await sleep(100)
  assert.equal((await shared.loadState(docId)).ops.length, 0, 'precondition: not persisted')

  const cb = connect(a2, docId, bob.token) // instance 2 loads from DB (empty) then must hello its way to the truth
  await cb.synced
  await until(() => cb.ydoc.getText('t').toString() === 'only in instance-1 memory')
  ca.close(); cb.close()
})

test('deleting a doc closes sockets on every instance', { skip }, async () => {
  const { a1, a2, alice, bob, docId } = await twoInstances()
  const cb = connect(a2, docId, bob.token)
  await cb.synced
  let code
  cb.provider.on('connection-close', (ev) => (code ??= ev.code))
  const res = await api(a1).call('DELETE', `/api/docs/${docId}`, null, alice.token)
  assert.equal(res.status, 200)
  await until(() => code === 4404)
  cb.close()
})
