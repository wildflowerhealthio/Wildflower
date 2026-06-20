import { useSyncExternalStore } from 'react'

// Re-read the URL on both history navigation (`popstate`) and same-document
// hash changes (`hashchange`). Clicking an in-page anchor like
// `<a href="#about-the-company">` updates `location.hash` and fires
// `hashchange` — not `popstate` — so listening only for the latter would let
// the snapshot below go stale and hash-gated UI (e.g. the footer's About
// blurb) would never re-render on click.
function subscribe(callback: () => void): () => void {
  window.addEventListener('popstate', callback)
  window.addEventListener('hashchange', callback)
  return () => {
    window.removeEventListener('popstate', callback)
    window.removeEventListener('hashchange', callback)
  }
}

export function useHref(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.href, // Client snapshot
    () => '' // Server/prerender snapshot — no URL outside the browser
  )
}
