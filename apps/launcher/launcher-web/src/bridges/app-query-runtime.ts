import { FetchHttpClient, type HttpClient } from '@effect/platform'
import type { QueryClient } from '@tanstack/react-query'
import type { BearerAuthStateStore } from '@wildflowerhealthio/gatekeeper-react'
import type { Layer } from 'effect'

import { buildQueryClient } from '../query-client.ts'
import type { RunAuthed, RuntimeLayer } from '../router-context.ts'
import { buildRunAuthed, type ApiTransport } from '../runtime-layer.ts'
import { attachBearer } from './attach-bearer.ts'
import { prependApiBaseUrl } from './prepend-api-base-url.ts'

/**
 * What the transport reads off the page's session, per request: the server
 * the page signed in to, which every request goes to, and the bearer that
 * server issued, which every request carries.
 */
type ApiSession = Pick<BearerAuthStateStore, 'serverUrl' | 'bearer'>

/**
 * The API server's transport, per mount path, over `transport`.
 *
 * @param transport - The underlying `HttpClient` layer (the real one is
 *   `FetchHttpClient.layer`; tests pass a stub).
 * @param session - The page's session, read lazily on every request: each
 *   relative request goes to `{serverUrl}{mountPath}` and carries
 *   `Authorization: Bearer <bearer>` while a bearer is held.
 *
 * @remarks
 * The mount path is joined onto the server into **one** prefix
 * (`{serverUrl}{mountPath}`), not stacked as a second wrapper.
 * `HttpClient.mapRequest` runs the wrapped client's rewrite before the
 * wrapper's own, so a `/fhir-r4` wrapper around an origin-prefixing layer
 * would only ever see the already-absolute URL and skip it — which is what
 * sent the launcher's FHIR reads to `{origin}/Patient`.
 *
 * The bearer wrapper is the inner one for the same reason: it must see a
 * still-relative URL, or its absolute-URL guard drops the `Authorization`
 * header from every request (pinned in `attach-bearer.test.ts`).
 */
const apiTransportAt =
  (transport: Layer.Layer<HttpClient.HttpClient>, session: ApiSession): ApiTransport =>
  (mountPath) =>
    prependApiBaseUrl(attachBearer(transport, session.bearer), session.serverUrl, mountPath)

/**
 * Build the shared `QueryClient` + authed runner threaded into the
 * router context. Page-lifetime; one HTTP layer for every request.
 * Clients are tokenless; the transport addresses each request to the
 * session's server and authenticates it with the session's bearer.
 *
 * @param session - The page's session, read lazily on every request (see
 *   {@link apiTransportAt}).
 * @param onUnauthorized - Invoked by the `QueryClient`'s cache when an
 *   authed query/mutation ends in a 401 that survived the boot-race
 *   retry — the app uses it to send the user to device login.
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
    apiTransportAt(FetchHttpClient.layer, session),
    effectTelemetryLayer
  )
  return { queryClient, runAuthed, runtimeLayer }
}

export { apiTransportAt, buildAppQueryRuntime }
export type { ApiSession }
