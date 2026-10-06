export const b64 = (u8) => Buffer.from(u8).toString('base64')
export const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))

/** Classic token bucket: `perSecond` refill, `burst` capacity. */
export class TokenBucket {
  constructor(perSecond, burst) {
    this.perSecond = perSecond
    this.burst = burst
    this.tokens = burst
    this.last = Date.now()
  }
  take(n = 1) {
    const now = Date.now()
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond)
    this.last = now
    if (this.tokens < n) return false
    this.tokens -= n
    return true
  }
}

export const makeLogger = (config) => ({
  info: (...a) => !config.silent && console.log(`[${config.instanceId}]`, ...a),
  warn: (...a) => !config.silent && console.warn(`[${config.instanceId}]`, ...a),
  error: (...a) => console.error(`[${config.instanceId}]`, ...a),
})
