import { modeHeaders } from './mode'

export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/v1'

export function getAccessToken() {
  try {
    const tokens = JSON.parse(localStorage.getItem('cloudship_tokens') || 'null')
    return tokens?.access?.token || null
  } catch {
    return null
  }
}

export function isLiveSession() {
  const token = getAccessToken()
  return Boolean(token && token !== 'demo-operator')
}

export async function apiFetch(path, options = {}) {
  const token = getAccessToken()
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...modeHeaders(),
      ...(options.headers || {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.message || 'Request failed')
  }
  return data
}
