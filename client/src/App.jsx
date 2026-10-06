import { createContext, useContext, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { getSession, setSession } from './api.js'
import Auth from './pages/Auth.jsx'
import Docs from './pages/Docs.jsx'
import EditorPage from './pages/Editor.jsx'
import Join from './pages/Join.jsx'

const AuthCtx = createContext(null)
export const useAuth = () => useContext(AuthCtx)

function RequireAuth({ children }) {
  const { session } = useAuth()
  const location = useLocation()
  if (!session) return <Navigate to="/login" state={{ from: location.pathname }} replace />
  return children
}

export default function App() {
  const [session, setSess] = useState(getSession)
  const value = {
    session,
    signIn(s) {
      setSession(s)
      setSess(s)
    },
    signOut() {
      setSession(null)
      setSess(null)
    },
  }
  return (
    <AuthCtx.Provider value={value}>
      <Routes>
        <Route path="/login" element={<Auth mode="login" />} />
        <Route path="/register" element={<Auth mode="register" />} />
        <Route path="/" element={<RequireAuth><Docs /></RequireAuth>} />
        <Route path="/d/:id" element={<RequireAuth><EditorPage /></RequireAuth>} />
        <Route path="/join/:token" element={<RequireAuth><Join /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthCtx.Provider>
  )
}
