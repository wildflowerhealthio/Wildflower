import { useSyncExternalStore } from 'react'

/** Call `onChange` whenever the webview goes online or offline, until unsubscribed. */
const subscribeToConnectivity = (onChange: () => void): (() => void) => {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

const onlineSnapshot = (): boolean => navigator.onLine

/**
 * Whether the webview has a network connection, as `navigator.onLine` says,
 * kept current by the window's `online` and `offline` events.
 *
 * @remarks
 * `navigator.onLine` is `false` only when the device has no network at all;
 * `true` doesn't mean a site can be reached.
 */
const useOnline = (): boolean => useSyncExternalStore(subscribeToConnectivity, onlineSnapshot)

export { useOnline }
