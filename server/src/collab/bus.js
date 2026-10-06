import Redis from 'ioredis'

/**
 * Cross-instance message bus.
 *
 * Every server instance holds the docs its own clients are editing in memory.
 * When one instance sees an update it publishes it here, and every other
 * instance holding that doc applies it and fans it out to its local sockets.
 * That is what lets the load balancer route clients with NO sticky sessions.
 *
 * Redis pub/sub is at-most-once. Correctness does not depend on it being
 * perfect: Yjs updates are idempotent, and `hello` (see DocManager) lets an
 * instance re-sync a doc from its peers after loading it or reconnecting.
 */
export class RedisBus {
  kind = 'redis'

  constructor(config, log) {
    this.instanceId = config.instanceId
    this.log = log
    this.pub = new Redis(config.redisUrl, { maxRetriesPerRequest: null })
    this.sub = new Redis(config.redisUrl, { maxRetriesPerRequest: null })
    for (const c of [this.pub, this.sub]) c.on('error', (e) => this.log.warn('redis error:', e.message))
  }

  async start(onMessage, onReconnect) {
    let firstReady = true
    this.sub.on('ready', () => {
      if (firstReady) firstReady = false
      else onReconnect?.() // we may have missed messages while disconnected
    })
    this.sub.on('pmessage', (_pattern, channel, raw) => {
      try {
        const msg = JSON.parse(raw)
        if (msg.from === this.instanceId) return
        onMessage(channel.slice('syncpad:doc:'.length), msg)
      } catch (e) {
        this.log.warn('bad bus message:', e.message)
      }
    })
    await this.sub.psubscribe('syncpad:doc:*')
  }

  publish(docId, msg) {
    this.pub.publish(`syncpad:doc:${docId}`, JSON.stringify({ from: this.instanceId, ...msg })).catch(() => {})
  }

  async close() {
    this.pub.disconnect()
    this.sub.disconnect()
  }
}

/** Single-instance mode: nothing to coordinate with. */
export class NullBus {
  kind = 'none'
  async start() {}
  publish() {}
  async close() {}
}
