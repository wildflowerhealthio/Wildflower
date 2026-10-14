import { HttpApiError, HttpClientError } from '@effect/platform'
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { unwrapFiberFailure } from '@wildflowerhealthio/kitchen-sink'
import { Duration, pipe } from 'effect'

/** TanStack Query's own default, kept for every failure but a 401. */
const DEFAULT_QUERY_RETRIES = 3

/**
 * True when a rejected `runAuthed` (a query or mutation) failed with a 401, in
 * either shape it reaches us as: an `HttpClientError.ResponseError` at 401
 * (an undeclared status), or the typed `HttpApiError.Unauthorized` an endpoint
 * declaring 401 decodes into.
 */
const isUnauthorizedFailure = (failure: unknown): boolean => {
  const error = unwrapFiberFailure(failure)
  return (
    (error instanceof HttpClientError.ResponseError && error.response.status === 401) ||
    error instanceof HttpApiError.Unauthorized
  )
}

/**
 * The signed-in app's query client. The bearer is short-lived and the app holds
 * no refresh token, so a 401 means the session is over: any query or mutation
 * that ends in one calls `onSessionExpired`, which signs in again. A 401 is not
 * retried, so the sign-in isn't held up behind TanStack's backoff. Otherwise
 * the client is `buildSmartQueryClient`'s: in memory only, no refetch on focus.
 */
const buildSessionQueryClient = (onSessionExpired: () => void): QueryClient => {
  const endSessionIfUnauthorized = (failure: unknown): void => {
    if (isUnauthorizedFailure(failure)) onSessionExpired()
  }
  return new QueryClient({
    queryCache: new QueryCache({ onError: endSessionIfUnauthorized }),
    mutationCache: new MutationCache({ onError: endSessionIfUnauthorized }),
    defaultOptions: {
      queries: {
        staleTime: pipe(5, Duration.minutes, Duration.toMillis),
        gcTime: pipe(30, Duration.minutes, Duration.toMillis),
        refetchOnWindowFocus: false,
        retry: (failureCount, error) =>
          !isUnauthorizedFailure(error) && failureCount < DEFAULT_QUERY_RETRIES,
      },
    },
  })
}

export { buildSessionQueryClient, isUnauthorizedFailure }
