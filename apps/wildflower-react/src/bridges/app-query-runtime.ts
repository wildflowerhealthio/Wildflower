import type { QueryClient } from '@tanstack/react-query'
import { webHttpClientLayer } from 'telemetry-react'

import { buildQueryClient } from '../query-client.ts'
import type { RunAuthed, RuntimeLayer } from '../router-context.ts'
import { buildRunAuthed } from '../runtime-layer.ts'
import { attachBearer } from './attach-bearer.ts'
import { prependApiBaseUrl } from './prepend-api-base-url.ts'

/**
 * Build the shared `QueryClient` + authed runner threaded into the
 * router context. Page-lifetime; one HTTP layer for every entry (the
 * embedded bridge carries only messages, not HTTP). Clients are
 * tokenless — auth rides the `HttpOnly` `wf_auth` cookie (sent in
 * credentialed mode so it also rides the Tauri webview's cross-origin
 * loopback fetches).
 *
 * @param apiBaseUrl - Absolute API origin for entries whose page isn't
 *   served by the API server (see {@link prependApiBaseUrl}). Omitted,
 *   requests stay relative to the page origin.
 * @param onUnauthorized - Invoked by the `QueryClient`'s cache when an
 *   authed query/mutation ends in a 401 that survived the boot-race
 *   retry — the entry uses it to send the user to device login.
 * @param readBearer - Lazy bearer reader for the hosted entry. When
 *   provided, every relative request carries `Authorization: Bearer
 *   <token>`. Omitted for cookie-authed entries.
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
  // Order is load-bearing: `HttpClient.mapRequest` chains preprocessing
  // inside-out, so the bearer wrapper has to be the *inner* one to see a
  // still-relative URL. Swapped, its absolute-URL guard would drop the
  // `Authorization` header from every request. Pinned by a test in
  // `attach-bearer.test.ts`.
  let httpClientLayer = webHttpClientLayer
  if (readBearer !== undefined) httpClientLayer = attachBearer(httpClientLayer, readBearer)
  if (apiBaseUrl !== undefined) httpClientLayer = prependApiBaseUrl(httpClientLayer, apiBaseUrl)
  const { runAuthed, runtimeLayer } = buildRunAuthed(httpClientLayer)
  return { queryClient, runAuthed, runtimeLayer }
}

export { buildAppQueryRuntime }
