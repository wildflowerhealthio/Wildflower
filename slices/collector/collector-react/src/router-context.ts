import { type QueryClient } from '@tanstack/react-query'
import { type CollectorHttpApiClient } from 'collector-core/clients'
import { type Effect, type Layer } from 'effect'
import { type BaseRouterContext } from 'shared-structures-react'

import { buildCollectorClientLayer } from './client/collector-client.ts'

type RuntimeLayer = Layer.Layer<
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer> | CollectorHttpApiClient,
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
   * context a faithful subset of the app's `RouterContext`; collector's
   * {@link ensureAuthedQuery} loader no longer reads it — the gate
   * guarantees the token before the loader runs.
   */
  readonly awaitAuthReady: BaseRouterContext.AwaitAuthReady
}

/**
 * The collector slice's client layer, ready for the app to merge into
 * its composed `runtimeLayer` over `BaseRouterContext.RuntimeLayer`
 * (`BearerToken | HttpClient`). Bearer-attaching per request — see
 * {@link buildCollectorClientLayer}.
 */
const sliceRuntimeLayer: Layer.Layer<
  CollectorHttpApiClient,
  never,
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
> = buildCollectorClientLayer()

export { sliceRuntimeLayer }
export type { RouterContext, RunAuthed, RuntimeLayer }
