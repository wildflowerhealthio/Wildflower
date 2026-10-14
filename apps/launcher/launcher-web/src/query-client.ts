import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { Duration, pipe } from 'effect'

import { isInsufficientScopeFailure, isUnauthorizedFailure } from './auth-errors.ts'

/** TanStack Query's own default retry count, kept for every other failure. */
const DEFAULT_QUERY_RETRIES = 3

/**
 * The page-lifetime TanStack `QueryClient`, wired to the app's auth policy.
 *
 * In-memory only — no persister (PHI-adjacent). Warmed by route
 * preloading, not storage restore.
 *
 * `onUnauthorized` fires when an authed query or mutation ends in a 401 — the
 * session is gone, so the caller signs the user in again. The
 * QueryCache/MutationCache `onError` hooks fire once the query/mutation reaches
 * its error state (after TanStack's own retries), so the redirect isn't
 * re-fired per attempt. `retry` skips TanStack's backoff for a 401, which
 * re-sending can't fix and would only delay the redirect; other errors keep
 * the default count.
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
        // Skip re-sends for both auth failures: a 401 means the session is
        // over, and a 403 `InsufficientScope` is deterministic — the token's
        // scopes don't change mid-session, so retrying only delays the
        // in-place surface.
        retry: (failureCount, error) =>
          !isUnauthorizedFailure(error) &&
          !isInsufficientScopeFailure(error) &&
          failureCount < DEFAULT_QUERY_RETRIES,
      },
    },
  })
}

export { buildQueryClient }
