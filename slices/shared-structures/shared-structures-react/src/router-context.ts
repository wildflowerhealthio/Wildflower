import type { HttpClient } from '@effect/platform'
import { type QueryClient } from '@tanstack/react-query'
import { type Effect, type Layer } from 'effect'
import { type BearerToken } from 'kitchen-sink/auth-token'

type RuntimeLayer = Layer.Layer<BearerToken | HttpClient.HttpClient, never, never>

/**
 * Run an authed Effect from a non-React call site (route loaders).
 * Supplies `BearerToken | HttpClient`; the caller still provides its
 * own slice client layer.
 */
type RunAuthed = <A, E>(
  effect: Effect.Effect<A, E, Layer.Layer.Success<RuntimeLayer>>
) => Promise<A>

interface RouterContext {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
  /**
   * Whether the bearer token is available yet. Authed route `loader`s
   * consult this to decide between prefetching now and deferring to the
   * post-gate in-component read.
   *
   * The `/settings` and `_auth` gates are React *component* gates
   * (`RequireAuth`), not `beforeLoad`, so on embedded first paint the
   * bridge hasn't delivered the token when a loader runs — prefetching
   * then would 401. Standalone web has the token synchronously from
   * localStorage, so this returns `true` and the loader warms the cache
   * for first paint. The app wires the concrete reader (`gatekeeper-react`'s
   * `authTokenRef`); slices stay decoupled from that package by reading
   * through this context field — the single source of truth for "is the
   * bearer ready" across every slice loader and the app's prefetch.
   */
  readonly isTokenReady: () => boolean
}

export type { RouterContext, RunAuthed, RuntimeLayer }
