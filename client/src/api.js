const KEY = 'syncpad.session'

export const getSession = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY))
  } catch {
    return null
  }
}
export const setSession = (s) => (s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY))

export async function api(path, { method = 'GET', body } = {}) {
  const s = getSession()
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(s && { authorization: `Bearer ${s.token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && s && !path.startsWith('/auth')) {
    setSession(null)
    window.location.assign('/login') // token expired
  }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed. Try again.'), { status: res.status })
  return data
}

export const wsBase = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`

// Presence colours. Chosen to stay legible as caret + name flag on white.
const PALETTE = ['#e4572e', '#0f9d8a', '#c98a00', '#7b5ea7', '#2e86ab', '#d1478f', '#4c9f38', '#b5541c']
export const colorFor = (id) => {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export const timeAgo = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
