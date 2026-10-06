import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import { verifyToken } from '../auth.js'
import { roleFor, canWrite } from '../roles.js'
import { TokenBucket } from '../util.js'
import { MSG_SYNC, MSG_AWARENESS, MSG_INSTANCE } from './docManager.js'

const OPEN = 1
const reject = (socket, code, text) => {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

/**
 * WebSocket endpoint: ws(s)://host/collab/:docId?token=<jwt>
 * Speaks the y-websocket wire protocol, so the stock y-websocket client works.
 *
 * Security is enforced here, on the server:
 *   - the JWT is verified and the user's role on the doc is checked at upgrade time
 *   - viewers' document writes are dropped (only sync-step-1 reads and awareness pass)
 *   - each socket has a token-bucket rate limit and a max payload size
 */
export function attachCollab(server, { store, manager, config, log }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.wsMaxBytes })

  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://placeholder')
      const match = url.pathname.match(/^\/collab\/([\w-]+)$/)
      if (!match) return reject(socket, 404, 'Not Found')
      let user
      try {
        user = verifyToken(url.searchParams.get('token'), config.jwtSecret)
      } catch {
        return reject(socket, 401, 'Unauthorized')
      }
      const meta = await store.getDoc(match[1])
      if (!meta) return reject(socket, 404, 'Not Found')
      const role = roleFor(meta, user.id)
      if (!role) return reject(socket, 403, 'Forbidden')
      const wantsInstance = url.searchParams.get('instance') === '1' // opt-in: stock y-websocket clients don't know this message
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, { docId: meta._id, role, user, wantsInstance }))
    } catch (err) {
      log.error('upgrade failed:', err.message)
      reject(socket, 500, 'Internal Server Error')
    }
  })

  function onConnection(ws, { docId, role, wantsInstance }) {
    const bucket = new TokenBucket(config.wsMsgsPerSec, config.wsBurst)
    ws.isAlive = true
    ws.on('pong', () => (ws.isAlive = true))

    // Messages can arrive before the doc has loaded from the DB. Chaining every
    // handler on the same promise queues them and preserves their order.
    const docReady = manager.get(docId)

    docReady
      .then((doc) => {
        if (ws.readyState !== OPEN) return
        manager.connect(doc, ws)
        if (wantsInstance) {
          const hello = encoding.createEncoder()
          encoding.writeVarUint(hello, MSG_INSTANCE)
          encoding.writeVarString(hello, config.instanceId)
          ws.send(encoding.toUint8Array(hello))
        }

        const step1 = encoding.createEncoder()
        encoding.writeVarUint(step1, MSG_SYNC)
        syncProtocol.writeSyncStep1(step1, doc.ydoc)
        ws.send(encoding.toUint8Array(step1))

        const states = doc.awareness.getStates()
        if (states.size) {
          const aw = encoding.createEncoder()
          encoding.writeVarUint(aw, MSG_AWARENESS)
          encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(states.keys())))
          ws.send(encoding.toUint8Array(aw))
        }
      })
      .catch((err) => {
        log.error(`failed to load doc ${docId}:`, err.message)
        ws.close(1011, 'load failed')
      })

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return ws.close(1003, 'binary only')
      if (!bucket.take()) return ws.close(4429, 'rate limited')
      docReady.then((doc) => handleMessage(doc, ws, role, data)).catch(() => {})
    })

    ws.on('close', () => {
      docReady.then((doc) => manager.disconnect(doc, ws)).catch(() => {})
    })
    ws.on('error', () => ws.terminate())
  }

  function handleMessage(doc, ws, role, data) {
    if (ws.readyState !== OPEN) return
    try {
      const decoder = decoding.createDecoder(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      const type = decoding.readVarUint(decoder)
      if (type === MSG_SYNC) {
        const reply = encoding.createEncoder()
        encoding.writeVarUint(reply, MSG_SYNC)
        const syncType = decoding.readVarUint(decoder)
        if (syncType === syncProtocol.messageYjsSyncStep1) {
          syncProtocol.readSyncStep1(decoder, reply, doc.ydoc) // everyone may read
        } else if (!canWrite(role)) {
          return // viewer tried to write: silently ignored server-side
        } else if (syncType === syncProtocol.messageYjsSyncStep2) {
          syncProtocol.readSyncStep2(decoder, doc.ydoc, ws)
        } else if (syncType === syncProtocol.messageYjsUpdate) {
          syncProtocol.readUpdate(decoder, doc.ydoc, ws)
        }
        if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply))
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), ws)
      }
    } catch (err) {
      log.warn('malformed message, closing socket:', err.message)
      ws.close(1003, 'malformed message')
    }
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate()
        continue
      }
      ws.isAlive = false
      ws.ping()
    }
  }, 30_000)
  heartbeat.unref()

  wss.on('close', () => clearInterval(heartbeat))
  return wss
}
