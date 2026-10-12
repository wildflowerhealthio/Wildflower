import type { HttpClient } from '@effect/platform'
import { type QueryClient } from '@tanstack/react-query'
import { type Effect, type Layer } from 'effect'

type RuntimeLayer = Layer.Layer<HttpClient.HttpClient, never, never>

/**
 * Optional knobs for a `runAuthed` call. `signal` mirrors
 * `Effect.runPromise`'s own `{ signal }` option: aborting it interrupts
 * the running Effect (its release/finalizers run) and rejects the
 * promise. Long-lived authed Effects thread a per-run
 * `AbortController` through here for explicit cancellation.
 */
interface RunAuthedOptions {
  readonly signal?: AbortSignal
}

/**
 * Run an authed Effect from a non-React call site (route loaders).
 * Supplies `HttpClient`; the caller still provides its own slice
 * client layer.
 */
type RunAuthed = <A, E>(
  effect: Effect.Effect<A, E, Layer.Layer.Success<RuntimeLayer>>,
  options?: RunAuthedOptions
) => Promise<A>

/**
 * Resolve once the bearer token is available, or reject. Injected at
 * `buildAppTree` and threaded into the router context so the `beforeLoad`
 * auth gate can `await` it.
 *
 * The optional `returnTo` is the originally-requested same-origin path
 * (the gate passes `location.href`). The implementation bakes it into its
 * sign-in `redirect(...)` so sign-in lands the user back where they were
 * headed.
 *
 * A TanStack `redirect(...)` rejection (no token) bubbles so the router
 * follows the redirect into sign-in; any other rejection bubbles to the
 * layout's `errorComponent`, which renders a retry screen.
 */
type AwaitAuthReady = (returnTo?: string) => Promise<void>

/**
 * Generic runtime-layer shape parameterised over the extra services a
 * particular slice or app adds on top of {@link RuntimeLayer}'s base
 * (`HttpClient`). A slice instantiates this with its own client (e.g.
 * `RuntimeLayerWith<DatabasesHttpApiClient>`); the host app instantiates
 * with a union of every slice's client.
 */
type RuntimeLayerWith<Extra> = Layer.Layer<Layer.Layer.Success<RuntimeLayer> | Extra, never, never>

/**
 * Generic `runAuthed` shape over the extra services. See
 * {@link RuntimeLayerWith}.
 */
type RunAuthedWith<Extra> = <A, E>(
  effect: Effect.Effect<A, E, Layer.Layer.Success<RuntimeLayerWith<Extra>>>,
  options?: RunAuthedOptions
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
   * The auth-readiness wait, injected at `buildAppTree` and consulted by
   * the gated layouts' `beforeLoad`. Resolves when a bearer token is
   * present; rejects with a TanStack `redirect(...)` otherwise. The gate —
   * not the loaders — owns this, so an authed loader that runs is
   * guaranteed a token (no more first-paint skip).
   */
  readonly awaitAuthReady: AwaitAuthReady
}

/**
 * Concrete base router-context — `RouterContextWith<never>`, i.e. no
 * slice services beyond the `HttpClient` floor. Kept as a standalone
 * interface so existing references (e.g.
 * `BaseRouterContext.RouterContext`) keep working without changing.
 */
interface RouterContext extends RouterContextWith<never> {}

export type {
  AwaitAuthReady,
  RouterContext,
  RouterContextWith,
  RunAuthed,
  RunAuthedOptions,
  RunAuthedWith,
  RuntimeLayer,
  RuntimeLayerWith,
}
