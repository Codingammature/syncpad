import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { signToken, ipLimiter } from '../auth.js'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const publicUser = (u) => ({ id: u._id, name: u.name, email: u.email })

export function authRoutes({ store, config }) {
  const r = Router()
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  r.use(ipLimiter(config.authPerMin))

  r.post('/register', wrap(async (req, res) => {
    const name = String(req.body?.name ?? '').trim()
    const email = String(req.body?.email ?? '').trim().toLowerCase()
    const password = String(req.body?.password ?? '')
    if (name.length < 1 || name.length > 60) return res.status(400).json({ error: 'Enter a name up to 60 characters.' })
    if (!EMAIL.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' })
    if (password.length < 8) return res.status(400).json({ error: 'Use a password with at least 8 characters.' })
    if (await store.findUserByEmail(email)) return res.status(409).json({ error: 'That email is already registered. Sign in instead.' })
    let user
    try {
      user = await store.createUser({ name, email, passwordHash: await bcrypt.hash(password, 10) })
    } catch (e) {
      if (e.code === 11000) return res.status(409).json({ error: 'That email is already registered. Sign in instead.' }) // lost a signup race
      throw e
    }
    res.status(201).json({ token: signToken(user, config.jwtSecret), user: publicUser(user) })
  }))

  r.post('/login', wrap(async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase()
    const user = await store.findUserByEmail(email)
    const ok = user && (await bcrypt.compare(String(req.body?.password ?? ''), user.passwordHash))
    if (!ok) return res.status(401).json({ error: 'Email or password is incorrect.' })
    res.json({ token: signToken(user, config.jwtSecret), user: publicUser(user) })
  }))

  return r
}
