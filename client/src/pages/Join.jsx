import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api.js'

export default function Join() {
  const { token } = useParams()
  const navigate = useNavigate()
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api(`/join/${token}`, { method: 'POST' })
      .then((r) => !cancelled && navigate(`/d/${r.docId}`, { replace: true }))
      .catch((e) => !cancelled && setError(e.message))
    return () => { cancelled = true }
  }, [token, navigate])

  return (
    <main className="center">
      {error ? (
        <>
          <p className="error" role="alert">{error}</p>
          <Link to="/">Go to your documents</Link>
        </>
      ) : <p className="muted">Opening shared document…</p>}
    </main>
  )
}
