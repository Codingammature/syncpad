import { useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../App.jsx'

export default function Auth({ mode }) {
  const isRegister = mode === 'register'
  const { session, signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const next = location.state?.from ?? '/'

  if (session) return <Navigate to={next} replace />

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const data = await api(`/auth/${mode}`, { method: 'POST', body: form })
      signIn(data)
      navigate(next, { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth">
      <section className="auth-intro">
        <h1>SyncPad</h1>
        <p>Write together in real time. Edits merge automatically, even when someone is offline.</p>
      </section>
      <form className="auth-form" onSubmit={submit}>
        <h2>{isRegister ? 'Create your account' : 'Sign in'}</h2>
        {isRegister && (
          <label>
            Name
            <input value={form.name} onChange={set('name')} autoComplete="name" required maxLength={60} />
          </label>
        )}
        <label>
          Email
          <input type="email" value={form.email} onChange={set('email')} autoComplete="email" required />
        </label>
        <label>
          Password
          <input
            type="password" value={form.password} onChange={set('password')} required minLength={isRegister ? 8 : 1}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
          />
          {isRegister && <small>At least 8 characters.</small>}
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Working…' : isRegister ? 'Create account' : 'Sign in'}</button>
        <p className="alt">
          {isRegister ? 'Already have an account?' : 'New here?'}{' '}
          <Link to={isRegister ? '/login' : '/register'} state={location.state}>{isRegister ? 'Sign in' : 'Create an account'}</Link>
        </p>
      </form>
    </main>
  )
}
