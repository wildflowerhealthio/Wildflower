import type { QueryClient } from '@tanstack/react-query'

import { authTokenRef } from 'gatekeeper-react'
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
 */
const buildAppQueryRuntime = (): {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
} => {
  const queryClient = buildQueryClient()
  const { runAuthed, runtimeLayer } = buildRunAuthed(authTokenRef, webHttpClientLayer)
  return { queryClient, runAuthed, runtimeLayer }
}

export { buildAppQueryRuntime }
