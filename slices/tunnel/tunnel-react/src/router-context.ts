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
   * Whether the bearer token is available yet, so an authed route
   * `loader` can decide between prefetching now and deferring to the
   * post-gate in-component read.
   *
   * The `/settings` auth gate is a React component (not a `beforeLoad`),
   * so on embedded first paint the bridge hasn't delivered the token
   * when the loader runs — prefetching then would 401. Standalone web
   * has the token synchronously from localStorage, so this returns
   * `true` and the loader warms the cache for first paint. The app wires
   * the concrete reader (`gatekeeper-react`'s `authTokenRef`); the slice
   * stays decoupled from that package.
   */
  readonly isTokenReady: () => boolean
}

const sliceRuntimeLayer: Layer.Layer<
  TunnelAdminHttpApiClient,
  never,
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
> = buildTunnelAdminClientLayer()

export { sliceRuntimeLayer }
export type { RouterContext, RunAuthed, RuntimeLayer }
