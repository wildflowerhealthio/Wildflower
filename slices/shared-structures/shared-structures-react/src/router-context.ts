import type { HttpClient } from '@effect/platform'
import { type QueryClient } from '@tanstack/react-query'
import { type Effect, type Layer } from 'effect'
import { type BearerToken } from 'kitchen-sink/auth-token'
import type { WebApiOrigin } from 'shared-structures-core/web-api-origin'

type RuntimeLayer = Layer.Layer<BearerToken | HttpClient.HttpClient | WebApiOrigin, never, never>

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
 * The optional `returnTo` is the originally-requested same-origin path
 * (the gate passes `location.href`). The web impl bakes it into the
 * device-login `redirect(...)` so sign-in lands the user back where
 * they were headed; the embedded impl ignores it (the host owns
 * navigation there).
 *
 * Rejections are tagged so the gate can branch:
 *   - a TanStack `redirect(...)` (standalone web, no token) bubbles so
 *     the router follows the redirect into the device-login flow.
 *   - a `TokenTimeout` (embedded, host never delivered a token in the
 *     window) bubbles to the layout's `errorComponent`, which renders
 *     a web-side retry screen.
 */
type AwaitAuthReady = (returnTo?: string) => Promise<void>

/**
 * Generic runtime-layer shape parameterised over the extra services a
 * particular slice or app adds on top of {@link RuntimeLayer}'s base
 * (`BearerToken | HttpClient`). A slice instantiates this with its own
 * client (e.g. `RuntimeLayerWith<CollectorHttpApiClient>`); the host
 * app instantiates with a union of every slice's client.
 */
type RuntimeLayerWith<Extra> = Layer.Layer<Layer.Layer.Success<RuntimeLayer> | Extra, never, never>

/**
 * Generic `runAuthed` shape over the extra services. See
 * {@link RuntimeLayerWith}.
 */
type RunAuthedWith<Extra> = <A, E>(
  effect: Effect.Effect<A, E, Layer.Layer.Success<RuntimeLayerWith<Extra>>>
) => Promise<A>

/**
 * Generic router-context shape over the extra services. Slices import
 * this and instantiate with their own client services so the per-slice
 * `router-context.ts` files don't redefine `RouterContext` /
 * `RunAuthed` / `RuntimeLayer` by hand. The host app `extends` it to
 * add app-only fields (e.g. `transport`).
 */
interface RouterContextWith<Extra> {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthedWith<Extra>
  readonly runtimeLayer: RuntimeLayerWith<Extra>
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

/**
 * Concrete base router-context — `RouterContextWith<never>`, i.e. no
 * slice services beyond the `BearerToken | HttpClient` floor. Kept as a
 * standalone interface so existing references (e.g.
 * `BaseRouterContext.RouterContext`) keep working without changing.
 */
interface RouterContext extends RouterContextWith<never> {}

export type {
  AwaitAuthReady,
  RouterContext,
  RouterContextWith,
  RunAuthed,
  RunAuthedWith,
  RuntimeLayer,
  RuntimeLayerWith,
}
