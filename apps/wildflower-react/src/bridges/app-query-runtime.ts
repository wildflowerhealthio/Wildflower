import type { HttpClient } from '@effect/platform'
import type { QueryClient } from '@tanstack/react-query'
import type { Layer } from 'effect'
import { webHttpClientLayer } from 'telemetry-react'

import { buildQueryClient } from '../query-client.ts'
import type { RunAuthed, RuntimeLayer } from '../router-context.ts'
import { buildRunAuthed, type ApiTransport } from '../runtime-layer.ts'
import { attachBearer } from './attach-bearer.ts'
import { prependApiBaseUrl } from './prepend-api-base-url.ts'

/**
 * The API server's transport, per mount path, over `transport`.
 *
 * @param transport - The underlying `HttpClient` layer (the real one is
 *   `telemetry-react`'s `webHttpClientLayer`; tests pass a stub).
 * @param apiBaseUrl - Absolute API origin for entries whose page isn't
 *   served by the API server. Omitted, requests stay relative to the page
 *   origin.
 * @param readBearer - Lazy bearer reader; when given, every relative request
 *   carries `Authorization: Bearer <token>`.
 *
 * @remarks
 * The mount path is joined onto the origin into **one** prefix
 * (`{apiBaseUrl}{mountPath}`), not stacked as a second wrapper.
 * `HttpClient.mapRequest` runs the wrapped client's rewrite before the
 * wrapper's own, so a `/fhir-r4` wrapper around an origin-prefixing layer
 * would only ever see the already-absolute URL and skip it — which is what
 * sent the owner UI's FHIR reads to `{origin}/Patient`.
 *
 * The bearer wrapper is the inner one for the same reason: it must see a
 * still-relative URL, or its absolute-URL guard drops the `Authorization`
 * header from every request (pinned in `attach-bearer.test.ts`).
 */
const apiTransportAt =
  (
    transport: Layer.Layer<HttpClient.HttpClient>,
    apiBaseUrl: string | undefined,
    readBearer: (() => string | undefined) | undefined
  ): ApiTransport =>
  (mountPath) => {
    const authenticated = readBearer === undefined ? transport : attachBearer(transport, readBearer)
    const prefix = `${apiBaseUrl ?? ''}${mountPath}`
    return prefix === '' ? authenticated : prependApiBaseUrl(authenticated, prefix)
  }

/**
 * Build the shared `QueryClient` + authed runner threaded into the
 * router context. Page-lifetime; one HTTP layer for every entry (the
 * host bridge carries only messages, not HTTP). Clients are tokenless;
 * the entry decides how a request authenticates — `main-web` supplies
 * `readBearer`, and `main-tauri` supplies none because the host stamps
 * its owner bearer onto direct-loopback requests by connection
 * provenance.
 *
 * @param apiBaseUrl - Absolute API origin for entries whose page isn't
 *   served by the API server (see {@link prependApiBaseUrl}). Omitted,
 *   requests stay relative to the page origin.
 * @param onUnauthorized - Invoked by the `QueryClient`'s cache when an
 *   authed query/mutation ends in a 401 that survived the boot-race
 *   retry — the entry uses it to send the user to device login.
 * @param readBearer - Lazy bearer reader for the hosted entry. When
 *   provided, every relative request carries `Authorization: Bearer
 *   <token>`. Omitted for `main-tauri`, which the host authenticates.
 */
const buildAppQueryRuntime = (
  apiBaseUrl: string | undefined,
  onUnauthorized: () => void,
  readBearer?: () => string | undefined
): {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
} => {
  const queryClient = buildQueryClient(onUnauthorized)
  const { runAuthed, runtimeLayer } = buildRunAuthed(
    apiTransportAt(webHttpClientLayer, apiBaseUrl, readBearer)
  )
  return { queryClient, runAuthed, runtimeLayer }
}

export { apiTransportAt, buildAppQueryRuntime }
