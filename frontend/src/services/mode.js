// The dashboard's Test/Live switch. It is remembered per browser and sent with every API request
// as `x-cloudship-mode`; the backend then scopes all data, carriers and stores to that mode.
const KEY = 'cloudship_mode'

export function getMode() {
  try {
    return localStorage.getItem(KEY) === 'test' ? 'test' : 'live'
  } catch {
    return 'live'
  }
}

export function isTestMode() {
  return getMode() === 'test'
}

export function modeHeaders() {
  return isTestMode() ? { 'x-cloudship-mode': 'test' } : {}
}

// Reloading guarantees every screen refetches in the new mode instead of showing stale data.
export function setMode(mode) {
  try {
    localStorage.setItem(KEY, mode === 'test' ? 'test' : 'live')
  } catch {
    /* storage unavailable: stay in the current mode */
  }
  window.location.reload()
}
