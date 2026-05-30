import { type QueryClient } from '@tanstack/react-query'
import { type Effect, type Layer } from 'effect'
import { type BaseRouterContext } from 'shared-structures-react'
import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import { buildTunnelAdminClientLayer } from './client/tunnel-client'

type RuntimeLayer = Layer.Layer<
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer> | TunnelAdminHttpApiClient,
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
   * `/settings` layout's `beforeLoad`. The tunnel settings loader no
   * longer reads it — the gate guarantees the token before the loader
   * runs — but the field stays so this structural context remains a
   * faithful subset of the app's `RouterContext`.
   */
  readonly awaitAuthReady: BaseRouterContext.AwaitAuthReady
}

const sliceRuntimeLayer: Layer.Layer<
  TunnelAdminHttpApiClient,
  never,
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
> = buildTunnelAdminClientLayer()

export { sliceRuntimeLayer }
export type { RouterContext, RunAuthed, RuntimeLayer }
