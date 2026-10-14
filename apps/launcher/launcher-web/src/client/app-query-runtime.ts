import { FetchHttpClient, type HttpClient } from '@effect/platform'
import type { QueryClient } from '@tanstack/react-query'
import type { BearerAuthStateStore } from '@wildflowerhealthio/authorization-react'
import type { Layer } from 'effect'

import { buildQueryClient } from '../query-client.ts'
import type { RunAuthed, RuntimeLayer } from '../router-context.ts'
import { buildRunAuthed } from '../runtime-layer.ts'
import { attachBearer } from './attach-bearer.ts'
import { prependApiBaseUrl } from './prepend-api-base-url.ts'

/**
 * What the transport reads off the page's session, per request: the server
 * the page signed in to, which every request goes to, and the bearer that
 * server issued, which every request carries.
 */
type ApiSession = Pick<BearerAuthStateStore, 'serverUrl' | 'bearer'>

/**
 * The API server's transport over `transport`.
 *
 * @param transport - The underlying `HttpClient` layer (the real one is
 *   `FetchHttpClient.layer`; tests pass a stub).
 * @param session - The page's session, read lazily on every request: each
 *   relative request goes to `serverUrl` and carries
 *   `Authorization: Bearer <bearer>` while a bearer is held.
 *
 * @remarks
 * The bearer wrapper is the inner one: `HttpClient.mapRequest` runs the
 * wrapped client's rewrite first, so it must see a still-relative URL, or its
 * absolute-URL guard drops the `Authorization` header from every request
 * (pinned in `attach-bearer.test.ts`).
 */
const apiTransport = (
  transport: Layer.Layer<HttpClient.HttpClient>,
  session: ApiSession
): Layer.Layer<HttpClient.HttpClient> =>
  prependApiBaseUrl(attachBearer(transport, session.bearer), session.serverUrl)

/**
 * Build the shared `QueryClient` + authed runner threaded into the
 * router context. Page-lifetime; one HTTP layer for every request.
 * Clients are tokenless; the transport addresses each request to the
 * session's server and authenticates it with the session's bearer.
 *
 * @param session - The page's session, read lazily on every request (see
 *   {@link apiTransport}).
 * @param onUnauthorized - Invoked by the `QueryClient`'s cache when an
 *   authed query/mutation ends in a 401 — the app uses it to sign the user
 *   in again.
 * @param effectTelemetryLayer - The Effect telemetry layer every authed
 *   request runs under (see `buildRunAuthed`).
 */
const buildAppQueryRuntime = (
  session: ApiSession,
  onUnauthorized: () => void,
  effectTelemetryLayer: Layer.Layer<never>
): {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
} => {
  const queryClient = buildQueryClient(onUnauthorized)
  const { runAuthed, runtimeLayer } = buildRunAuthed(
    apiTransport(FetchHttpClient.layer, session),
    effectTelemetryLayer
  )
  return { queryClient, runAuthed, runtimeLayer }
}

export { apiTransport, buildAppQueryRuntime }
export type { ApiSession }
