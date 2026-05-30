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

/**
 * Resolve once the bearer token is available, or reject with a tagged
 * reason. Injected per entry (web vs. embedded) and threaded into the
 * router context so the `beforeLoad` auth gate can `await` it without
 * knowing which environment it runs in.
 *
 * Rejections are {@link AuthReadyError} instances so the gate can
 * branch on `_tag`: a missing standalone token redirects into the
 * device-login flow, an embedded timeout throws to a web-side retry
 * screen.
 */
type AwaitAuthReady = () => Promise<void>

interface RouterContext {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
  /**
   * Environment-specific auth-readiness wait, injected at `renderApp`
   * and consulted by the gated layouts' `beforeLoad`. Resolves when a
   * bearer token is present; rejects with a tagged {@link AuthReadyError}
   * otherwise. The gate — not the loaders — owns this, so an authed
   * loader that runs is guaranteed a token (no more first-paint skip).
   */
  readonly awaitAuthReady: AwaitAuthReady
}

export type { AwaitAuthReady, RouterContext, RunAuthed, RuntimeLayer }
