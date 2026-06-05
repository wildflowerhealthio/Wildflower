import type { QueryClient } from '@tanstack/react-query'
import type { Layer, Subscribable } from 'effect'
import type { WebApiOrigin } from 'shared-structures-react'
import { webHttpClientLayer } from 'telemetry-react'

import {
  buildQueryClient,
  buildRunAuthed,
  type RunAuthed,
  type RuntimeLayer,
} from '../router-context.ts'

/**
 * Build the shared `QueryClient` + authed runner threaded into the
 * router context. Page-lifetime; one HTTP layer for every entry (the
 * embedded bridge carries only messages, not HTTP).
 *
 * @param tokenSubscribable - The entry's `AuthTokenStore.subscribable`,
 *   used by the `BearerToken` Layer at request time. Rotation surfaces
 *   on the next request (the `Subscribable.get` read happens inside
 *   `HttpClient.mapRequestEffect`) without rebuilding the runtime.
 * @param webApiOriginLayer - The entry's `WebApiOrigin` source: the live
 *   `window.location.origin` layer for standalone web, or the
 *   host-fed bridge-store layer for embedded. Read per request (same
 *   `mapRequestEffect` seam as the token) so a host re-point surfaces on
 *   the next call.
 */
const buildAppQueryRuntime = (
  tokenSubscribable: Subscribable.Subscribable<string | null>,
  webApiOriginLayer: Layer.Layer<WebApiOrigin>
): {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
} => {
  const queryClient = buildQueryClient()
  const { runAuthed, runtimeLayer } = buildRunAuthed(
    tokenSubscribable,
    webHttpClientLayer,
    webApiOriginLayer
  )
  return { queryClient, runAuthed, runtimeLayer }
}

export { buildAppQueryRuntime }
