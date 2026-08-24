import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { Duration, pipe } from 'effect'

import { isInsufficientScopeFailure, isUnauthorizedFailure } from './auth-errors.ts'
import { DEFAULT_QUERY_RETRIES } from './retry-policy.ts'

/**
 * The page-lifetime TanStack `QueryClient`, wired to the app's auth policy.
 *
 * In-memory only — no persister (PHI-adjacent). Warmed by route
 * preloading, not storage restore.
 *
 * `refetchOnWindowFocus: false` because the embedded WebView fires
 * spurious focus events on host bridge re-renders.
 *
 * `onUnauthorized` fires when an authed query or mutation ends in a 401 that
 * survived the boot-race retry (see `buildRunAuthed`) — i.e. the session is
 * genuinely gone, so the caller sends the user to device login. The
 * QueryCache/MutationCache `onError` hooks fire once the query/mutation reaches
 * its error state (after TanStack's own retries), so the redirect isn't
 * re-fired per attempt. `retry` then skips TanStack's own backoff for a 401 —
 * `runAuthed` already spent the boot-race budget, so piling exponential retries
 * on top would only delay the redirect; other errors keep the default count.
 */
const buildQueryClient = (onUnauthorized: () => void): QueryClient => {
  const redirectIfUnauthorized = (error: unknown): void => {
    if (isUnauthorizedFailure(error)) onUnauthorized()
  }
  return new QueryClient({
    queryCache: new QueryCache({ onError: redirectIfUnauthorized }),
    mutationCache: new MutationCache({ onError: redirectIfUnauthorized }),
    defaultOptions: {
      queries: {
        staleTime: pipe(5, Duration.minutes, Duration.toMillis),
        gcTime: pipe(30, Duration.minutes, Duration.toMillis),
        refetchOnWindowFocus: false,
        // Skip re-sends for both auth failures: a 401 already spent the
        // boot-race budget (see `buildRunAuthed`), and a 403 `InsufficientScope`
        // is deterministic — the token's scopes don't change mid-session, so
        // retrying only delays the in-place surface.
        retry: (failureCount, error) =>
          !isUnauthorizedFailure(error) &&
          !isInsufficientScopeFailure(error) &&
          failureCount < DEFAULT_QUERY_RETRIES,
      },
    },
  })
}

export { buildQueryClient }
