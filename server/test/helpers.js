import * as Y from 'yjs'
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import { createApp } from '../src/app.js'

export const startApp = (overrides = {}) =>
  createApp({ port: 0, silent: true, flushMs: 20, docIdleMs: 200, ...overrides })

export function api(app) {
  const base = `http://127.0.0.1:${app.port}`
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }
  return {
    base,
    call,
    async register(name) {
      const r = await call('POST', '/api/auth/register', { name, email: `${name.toLowerCase()}-${Math.random().toString(36).slice(2)}@test.dev`, password: 'password123' })
      return { token: r.body.token, user: r.body.user }
    },
  }
}

export function connect(app, docId, token, { ydoc = new Y.Doc(), params = {} } = {}) {
  const provider = new WebsocketProvider(`ws://127.0.0.1:${app.port}/collab`, docId, ydoc, {
    params: { token, ...params },
    WebSocketPolyfill: WebSocket,
    disableBc: true,
  })
  const synced = new Promise((resolve) => provider.once('sync', resolve))
  return { ydoc, provider, synced, close: () => (provider.destroy(), ydoc.destroy()) }
}

export const until = async (fn, { timeout = 3000, every = 15 } = {}) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, every))
  }
  throw new Error('timed out waiting for condition')
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
