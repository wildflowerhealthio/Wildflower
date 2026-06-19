import { useSyncExternalStore } from 'react'

function subscribe(callback: () => void) {
  window.addEventListener('popstate', callback)
  // Optional: link to your pushState wrapper here if you use programmatic routing
  return () => window.removeEventListener('popstate', callback)
}

export function useHref(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.href, // Client snapshot
    () => '' // Server snapshot (for SSR/Next.js support)
  )
}
