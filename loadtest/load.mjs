/**
 * Load test: N websocket clients spread across one or more server instances all
 * editing ONE document. Measures edit propagation latency (writer -> every other
 * client) and verifies every client converges to identical content.
 *
 *   # against a running stack (docker compose up):
 *   node load.mjs --api http://localhost:4001 \
 *                 --ws ws://localhost:4001,ws://localhost:4002 \
 *                 --clients 100 --writers 10 --rate 5 --seconds 20
 *
 *   # zero-infra: boots N instances in this process (shared in-memory store),
 *   # with real Redis between them if REDIS_URL is set:
 *   REDIS_URL=redis://localhost:6379 node load.mjs --inproc --instances 2 --clients 100
 *
 * Latency uses one machine's clock (writer + readers share it), so run the
 * clients from a single host. Each writer does `rate` edits/second.
 */
import * as Y from 'yjs'
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : def
}
process.setMaxListeners(0) // y-websocket adds an exit listener per client
const INPROC = process.argv.includes('--inproc')
let API = arg('api', 'http://localhost:4001')
let WS_URLS = arg('ws', 'ws://localhost:4001').split(',')
const booted = []
if (INPROC) {
  const { createApp } = await import('../server/src/app.js')
  const { createStore } = await import('../server/src/store.js')
  const store = await createStore({})
  for (let i = 0; i < Number(arg('instances', 2)); i++) {
    booted.push(await createApp({ port: 0, silent: true, redisUrl: process.env.REDIS_URL ?? '', instanceId: `inproc-${i + 1}` }, { store }))
  }
  API = `http://127.0.0.1:${booted[0].port}`
  WS_URLS = booted.map((a) => `ws://127.0.0.1:${a.port}`)
}
const CLIENTS = Number(arg('clients', 50))
const WRITERS = Math.min(Number(arg('writers', 5)), CLIENTS)
const RATE = Number(arg('rate', 5))
const SECONDS = Number(arg('seconds', 15))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN)

async function call(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`)
  return json
}

const { token } = await call('POST', '/api/auth/register', {
  name: 'Load Test',
  email: `load-${Date.now()}@test.dev`,
  password: 'password123',
})
const { doc } = await call('POST', '/api/docs', { title: `load ${new Date().toISOString()}` }, token)

console.log(`doc ${doc.id}: ${CLIENTS} clients (${WRITERS} writers @ ${RATE}/s) across ${WS_URLS.length} instance(s) for ${SECONDS}s`)

const clients = []
for (let i = 0; i < CLIENTS; i++) {
  const ydoc = new Y.Doc()
  const provider = new WebsocketProvider(`${WS_URLS[i % WS_URLS.length]}/collab`, doc.id, ydoc, {
    params: { token },
    WebSocketPolyfill: WebSocket,
    disableBc: true,
  })
  clients.push({ i, ydoc, provider, latencies: [], seen: 0 })
}

await Promise.all(clients.map((c) => new Promise((r) => (c.provider.synced ? r() : c.provider.once('sync', r)))))
console.log('all clients synced, starting edits')

// Latency probe: each writer stamps {t, n} into a per-writer Y.Map key; readers diff against now.
for (const c of clients) {
  c.ydoc.getMap('ping').observe((event, tr) => {
    if (tr.local) return
    for (const key of event.keysChanged) {
      const v = c.ydoc.getMap('ping').get(key)
      if (v) {
        c.latencies.push(Date.now() - v.t)
        c.seen++
      }
    }
  })
}

let inserts = 0
const t0 = Date.now()
const timers = clients.slice(0, WRITERS).map((c) =>
  setInterval(() => {
    c.ydoc.transact(() => {
      c.ydoc.getMap('ping').set(`w${c.i}`, { t: Date.now() })
      c.ydoc.getText('body').insert(c.ydoc.getText('body').length, 'x') // for the convergence check
    })
    inserts++
  }, 1000 / RATE),
)

await sleep(SECONDS * 1000)
timers.forEach(clearInterval)
await sleep(2000) // let in-flight updates land

const all = clients.flatMap((c) => c.latencies).sort((a, b) => a - b)
const texts = new Set(clients.map((c) => c.ydoc.getText('body').toString().length))
const connected = clients.filter((c) => c.provider.wsconnected).length
const result = {
  clients: CLIENTS, writers: WRITERS, instances: WS_URLS.length, seconds: SECONDS,
  editsSent: inserts,
  deliveries: all.length,
  deliveriesPerSec: Math.round(all.length / SECONDS),
  latencyMs: { p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99), max: all.at(-1) },
  stillConnected: `${connected}/${CLIENTS}`,
  converged: texts.size === 1 && [...texts][0] === inserts,
  finalLength: [...texts],
  wallSeconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
}
console.log(JSON.stringify(result, null, 2))

clients.forEach((c) => (c.provider.destroy(), c.ydoc.destroy()))
for (const a of booted) await a.close()
process.exit(result.converged ? 0 : 1)
