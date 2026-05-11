/**
 * Bearer-token storage layer. The token lives in `localStorage` so it
 * survives reloads; reads + writes are routed through this module so
 * the storage key has a single source of truth and changes can be
 * observed reactively (see `subscribeToken`).
 */

const TOKEN_STORAGE_KEY = 'gatekeeper:token'
const TOKEN_CHANGE_EVENT = 'gatekeeper:token-changed'

const readToken = (): string | null => {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(TOKEN_STORAGE_KEY)
}

const writeToken = (token: string): void => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
  // Native `storage` events only fire in *other* tabs; dispatch a same-tab event for subscribers.
  window.dispatchEvent(new Event(TOKEN_CHANGE_EVENT))
}

/**
 * Subscribe to bearer-token changes. Fires when:
 *   - this tab calls `writeToken` (via the dispatched custom event),
 *   - another tab updates `localStorage` (via the native `storage` event).
 * Returns an unsubscribe function suitable for `useSyncExternalStore`.
 */
const subscribeToken = (notify: () => void): (() => void) => {
  if (typeof window === 'undefined') return (): void => undefined
  const onStorage = (e: StorageEvent): void => {
    if (e.key === TOKEN_STORAGE_KEY) notify()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(TOKEN_CHANGE_EVENT, notify)
  return (): void => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(TOKEN_CHANGE_EVENT, notify)
  }
}

export { TOKEN_STORAGE_KEY, readToken, subscribeToken, writeToken }
