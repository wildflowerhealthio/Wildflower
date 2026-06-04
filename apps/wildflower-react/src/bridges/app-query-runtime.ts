import type { QueryClient } from '@tanstack/react-query'
import type { Subscribable } from 'effect'
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
 */
const buildAppQueryRuntime = (
  tokenSubscribable: Subscribable.Subscribable<string | null>
): {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
} => {
  const queryClient = buildQueryClient()
  const { runAuthed, runtimeLayer } = buildRunAuthed(tokenSubscribable, webHttpClientLayer)
  return { queryClient, runAuthed, runtimeLayer }
}

export { buildAppQueryRuntime }
