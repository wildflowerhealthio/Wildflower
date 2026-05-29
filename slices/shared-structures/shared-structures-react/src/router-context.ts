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
}

export type { RouterContext, RunAuthed, RuntimeLayer }
