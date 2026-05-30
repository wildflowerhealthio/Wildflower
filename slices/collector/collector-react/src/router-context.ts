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
   * Whether the bearer token is ready — the single readiness reader the
   * app wires onto {@link BaseRouterContext.RouterContext}. Collector's
   * {@link ensureAuthedQuery} loader consults this (rather than reading
   * `authTokenRef` directly) so there's one source of truth for "is the
   * bearer ready" shared with the app's `prefetchKeyRoutes`.
   */
  readonly isTokenReady: () => boolean
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
