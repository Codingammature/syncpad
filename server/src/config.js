import os from 'node:os'
import crypto from 'node:crypto'

/** All runtime configuration lives here. Env vars in production, overrides in tests. */
export function loadConfig(overrides = {}) {
  const env = process.env
  return {
    port: Number(env.PORT ?? 4000),
    mongoUri: env.MONGO_URI ?? '', // empty -> in-memory store (dev/tests)
    mongoDb: env.MONGO_DB ?? 'syncpad',
    redisUrl: env.REDIS_URL ?? '', // empty -> single-instance mode
    jwtSecret: env.JWT_SECRET ?? 'dev-secret-change-me',
    instanceId: env.INSTANCE_ID ?? `${os.hostname()}-${crypto.randomBytes(3).toString('hex')}`,

    // Persistence tuning
    flushMs: Number(env.FLUSH_MS ?? 250), // batch window before writing ops to the DB
    compactEvery: Number(env.COMPACT_EVERY ?? 100), // ops before folding them into a snapshot
    docIdleMs: Number(env.DOC_IDLE_MS ?? 30_000), // unload a doc this long after the last client leaves

    // Per-connection abuse protection
    wsMsgsPerSec: Number(env.WS_MSGS_PER_SEC ?? 200),
    wsBurst: Number(env.WS_BURST ?? 400),
    wsMaxBytes: Number(env.WS_MAX_BYTES ?? 1024 * 1024),

    // Auth endpoint limiter (per IP)
    authPerMin: Number(env.AUTH_PER_MIN ?? 20),

    silent: false,
    ...overrides,
  }
}
