import { useSyncExternalStore } from 'react'

/**
 * Subscribes to both `popstate` and `hashchange` so components that gate
 * on `location.href` (e.g. the footer's About blurb) re-render when the
 * URL changes by any mechanism — history navigation or in-page anchor.
 */
function subscribe(callback: () => void): () => void {
  window.addEventListener('popstate', callback)
  window.addEventListener('hashchange', callback)
  return () => {
    window.removeEventListener('popstate', callback)
    window.removeEventListener('hashchange', callback)
  }
}

/** Returns the current `window.location.href`, re-rendering on `popstate` and `hashchange`. */
function useHref(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.href,
    () => ''
  )
}

export { useHref }
