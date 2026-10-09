import { HttpApiError, HttpClientError } from '@effect/platform'
import { unwrapFiberFailure } from 'kitchen-sink'
import { isInsufficientScopeBody } from 'shared-structures-core/http-api-definition'

/**
 * Classification of the auth failures the router runtime reacts to — 401
 * (authentication: redirect to device login) and 403 `InsufficientScope`
 * (authorization: render in place). Pure predicates over the two shapes each
 * failure reaches us as (a raw error, and the `FiberFailure`-wrapped form a
 * rejected `runAuthed` surfaces), so both the `QueryClient` policy
 * (`query-client.ts`) and the scope-error surface (`scope-error-renderer.tsx`)
 * classify identically.
 */

/**
 * True for either shape a 401 reaches us as:
 *
 * - an `HttpClientError.ResponseError` at status 401 — what `HttpApiClient`'s
 *   `statusOrElse` (an *undeclared* status) or a raw `filterStatusOk` produce;
 *   and
 * - a typed `HttpApiError.Unauthorized` — what an endpoint that *declares* 401
 *   via `RequireAuthMiddleware` (gatekeeper's `/access` surface — grants,
 *   devices, consents) decodes its 401 into. `HttpApiClient` never surfaces
 *   these as a `ResponseError`.
 *
 * Matching only the `ResponseError` shape left the boot-race retry and the
 * device-login redirect silently blind to gatekeeper's own 401s. The status (or
 * the typed error), not the reason, is the reliable 401 signal.
 */
const isUnauthorizedError = (error: unknown): boolean =>
  (error instanceof HttpClientError.ResponseError && error.response.status === 401) ||
  error instanceof HttpApiError.Unauthorized

/**
 * The same test against the value a rejected `runAuthed` (i.e. a TanStack Query
 * `queryFn`/mutation) surfaces: `Effect.runPromise` rejects with a
 * `FiberFailure` wrapping the cause, so unwrap it to the underlying error
 * first. Used by both the QueryCache redirect and the skip-retry-on-401 policy.
 */
const isUnauthorizedFailure = (error: unknown): boolean =>
  isUnauthorizedError(unwrapFiberFailure(error))

/**
 * The scopes named by a `403 InsufficientScope` (the authorization — not
 * authentication — failure the scope-gated endpoints return), or `null` when
 * `error` is not one. Two shapes reach us, mirroring the 401 split above:
 *
 * - a **declared** 403 decodes onto the failure channel as the shared schema
 *   value (`{ error: 'InsufficientScope', missingScopes }`) — matched by
 *   {@link isInsufficientScopeBody}, so the surface can name the scopes; and
 * - an **undeclared** 403 arrives as a bare `HttpClientError.ResponseError` at
 *   status 403 whose body was never decoded — we still detect the authorization
 *   failure, but can't name the scopes, so `missingScopes` is empty.
 *
 * Unlike a 401, a 403 is not redirected to device login (the caller *is*
 * authenticated); the app renders it in place — so this returns the payload to
 * render rather than triggering a global side-effect.
 */
const insufficientScopeFromError = (
  error: unknown
): { readonly missingScopes: readonly string[] } | null => {
  if (isInsufficientScopeBody(error)) return { missingScopes: error.missingScopes }
  if (error instanceof HttpClientError.ResponseError && error.response.status === 403) {
    return { missingScopes: [] }
  }
  return null
}

/**
 * {@link insufficientScopeFromError} against the value a rejected `runAuthed`
 * (a TanStack Query `queryFn`/mutation) surfaces — the `FiberFailure` is
 * unwrapped to the underlying error first, exactly as {@link isUnauthorizedFailure} does.
 */
const insufficientScopeFromFailure = (
  error: unknown
): { readonly missingScopes: readonly string[] } | null =>
  insufficientScopeFromError(unwrapFiberFailure(error))

/** True when a raw (already-unwrapped) `error` is a 403 InsufficientScope in either shape. */
const isInsufficientScopeError = (error: unknown): boolean =>
  insufficientScopeFromError(error) !== null

/** Boolean form of {@link insufficientScopeFromFailure}, for the retry policy. */
const isInsufficientScopeFailure = (error: unknown): boolean =>
  insufficientScopeFromFailure(error) !== null

export {
  insufficientScopeFromError,
  insufficientScopeFromFailure,
  isInsufficientScopeError,
  isInsufficientScopeFailure,
  isUnauthorizedError,
  isUnauthorizedFailure,
}
