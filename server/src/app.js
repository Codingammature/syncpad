import http from 'node:http'
import express from 'express'
import cors from 'cors'
import { loadConfig } from './config.js'
import { makeLogger } from './util.js'
import { createStore } from './store.js'
import { RedisBus, NullBus } from './collab/bus.js'
import { DocManager } from './collab/docManager.js'
import { attachCollab } from './collab/wsServer.js'
import { authRoutes } from './routes/auth.js'
import { docRoutes } from './routes/docs.js'

export async function createApp(overrides = {}, deps = {}) {
  const config = loadConfig(overrides)
  const log = makeLogger(config)
  if (/^(dev-secret|change-me)/.test(config.jwtSecret)) log.warn('JWT_SECRET is a placeholder. Set a long random value before exposing this anywhere.')
  const store = deps.store ?? (await createStore(config)) // injectable so tests can share one store across instances
  const bus = config.redisUrl ? new RedisBus(config, log) : new NullBus()
  const manager = new DocManager({ store, bus, config, log })
  await bus.start((docId, msg) => manager.onBus(docId, msg), () => manager.helloAll())

  const app = express()
  app.set('trust proxy', 1) // behind nginx: use X-Forwarded-For for per-IP limits
  app.use(cors())
  app.use(express.json({ limit: '100kb' }))
  app.use((_req, res, next) => {
    res.setHeader('X-Instance-Id', config.instanceId)
    next()
  })

  app.get('/health', (_req, res) =>
    res.json({ ok: true, instance: config.instanceId, store: store.kind, bus: bus.kind, ...manager.stats }),
  )
  app.use('/api/auth', authRoutes({ store, config }))
  app.use('/api', docRoutes({ store, manager, config }))
  app.use((err, _req, res, _next) => {
    log.error(err.stack ?? err)
    res.status(500).json({ error: 'Something went wrong on our side. Try again.' })
  })

  const server = http.createServer(app)
  const wss = attachCollab(server, { store, manager, config, log })
  await new Promise((resolve) => server.listen(config.port, resolve))
  const port = server.address().port
  log.info(`listening on :${port} (store=${store.kind}, bus=${bus.kind})`)

  async function close() {
    for (const ws of wss.clients) ws.close(1001, 'server shutting down')
    await manager.shutdown() // persist anything still batched
    await new Promise((r) => server.close(r))
    server.closeAllConnections?.()
    await bus.close()
    await store.close()
  }

  return { server, config, port, store, manager, close }
}
