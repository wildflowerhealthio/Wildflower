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
 * Rejections are tagged so the gate can branch:
 *   - a TanStack `redirect(...)` (standalone web, no token) bubbles so
 *     the router follows the redirect into the device-login flow.
 *   - a `TokenTimeout` (embedded, host never delivered a token in the
 *     window) bubbles to the layout's `errorComponent`, which renders
 *     a web-side retry screen.
 */
type AwaitAuthReady = () => Promise<void>

interface RouterContext {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
  /**
   * Environment-specific auth-readiness wait, injected at `renderApp`
   * and consulted by the gated layouts' `beforeLoad`. Resolves when a
   * bearer token is present; rejects with a tagged reason otherwise
   * (TanStack `redirect(...)` for standalone web, `TokenTimeout` for
   * embedded). The gate — not the loaders — owns this, so an authed
   * loader that runs is guaranteed a token (no more first-paint skip).
   */
  readonly awaitAuthReady: AwaitAuthReady
}

export type { AwaitAuthReady, RouterContext, RunAuthed, RuntimeLayer }
