import { type QueryClient } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { type Effect, type Layer } from 'effect'
import { type GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { type BaseRouterContext } from 'shared-structures-react'

import { buildGatekeeperClientLayer } from './client/gatekeeper-client.ts'

type RuntimeLayer = Layer.Layer<
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer> | GatekeeperHttpApiClient,
  never,
  never
>

/**
 * Slice-local router-context shape — structurally a subset of the host
 * app's, but declared here so the slice doesn't import from the app.
 */
type RunAuthed = <A, E>(
  effect: Effect.Effect<A, E, Layer.Layer.Success<RuntimeLayer>>
) => Promise<A>

interface RouterContext {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
  /**
   * Environment-specific auth-readiness wait the app injects onto
   * {@link BaseRouterContext.RouterContext} and consults from the gated
   * layouts' `beforeLoad`. Declared here only to keep this structural
   * context a faithful subset of the app's `RouterContext`; gatekeeper
   * loaders don't read it — the gate guarantees the token before the
   * loader runs, so loaders are plain `ensureQueryData` calls.
   */
  readonly awaitAuthReady: BaseRouterContext.AwaitAuthReady
}

/**
 * The gatekeeper slice's client layer, ready for the app to merge into
 * its composed `runtimeLayer` over `BaseRouterContext.RuntimeLayer`
 * (`BearerToken | HttpClient`). Bearer-attaching per request — see
 * {@link buildGatekeeperClientLayer}.
 */
const sliceRuntimeLayer: Layer.Layer<
  GatekeeperHttpApiClient,
  never,
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
> = buildGatekeeperClientLayer()

/**
 * The fully-composed `runtimeLayer` from router context, for the two
 * gatekeeper call sites that aren't one-shot Promises and so can't go
 * through `runAuthed`/`useSuspenseQuery`:
 *
 *   - `NeedsAuthMessage` — the RFC 8628 device flow runs a long-lived
 *     fiber with retry + interrupt-on-unmount.
 *   - `oauth-polling` — `pollAuthorizationStatus` is a `Stream` that
 *     emits `pending` heartbeats until a terminal status.
 *
 * Both `Effect.provide` / `Stream.provideSomeLayer` this layer onto a
 * gatekeeper Effect/Stream and run it imperatively (via `react-kitchen-sink`'s
 * generic `useStream` / `Effect.runFork`). The annotated `select` re-narrows
 * the result when the slice's router isn't registered (standalone build),
 * where `useRouteContext()` would otherwise widen to `any` — no cast.
 */
const useGatekeeperRuntimeLayer = (): RuntimeLayer =>
  useRouteContext({ from: '__root__', select: (context: RouterContext) => context.runtimeLayer })

export { sliceRuntimeLayer, useGatekeeperRuntimeLayer }
export type { RouterContext, RunAuthed, RuntimeLayer }
