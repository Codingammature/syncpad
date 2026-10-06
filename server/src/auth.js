import jwt from 'jsonwebtoken'
import { TokenBucket } from './util.js'

export const signToken = (user, secret) =>
  jwt.sign({ sub: user._id, name: user.name }, secret, { expiresIn: '7d' })

/** Throws on invalid/expired tokens. */
export function verifyToken(token, secret) {
  const p = jwt.verify(token, secret)
  return { id: p.sub, name: p.name }
}

export const requireAuth = (secret) => (req, res, next) => {
  const h = req.headers.authorization ?? ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : null
  try {
    req.user = verifyToken(token, secret)
    next()
  } catch {
    res.status(401).json({ error: 'Sign in again to continue.' })
  }
}

/** Per-IP token bucket for credential endpoints. */
export function ipLimiter(perMinute) {
  const buckets = new Map()
  return (req, res, next) => {
    const ip = req.ip
    let b = buckets.get(ip)
    if (!b) buckets.set(ip, (b = new TokenBucket(perMinute / 60, perMinute)))
    if (!b.take()) return res.status(429).json({ error: 'Too many attempts. Wait a minute and retry.' })
    next()
  }
}
