import { type QueryClient } from '@tanstack/react-query'
import { type Effect, Layer } from 'effect'
import { type BaseRouterContext } from 'shared-structures-react'
import { type TunnelRouterContext } from 'tunnel-react'

import { AppsAdminHttpApiClient, AppsHttpApiClient } from 'apps-core/clients'

type RuntimeLayer = Layer.Layer<
  | Layer.Layer.Success<TunnelRouterContext.RuntimeLayer>
  | AppsHttpApiClient
  | AppsAdminHttpApiClient,
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
}

const sliceRuntimeLayer: Layer.Layer<
  AppsHttpApiClient | AppsAdminHttpApiClient,
  never,
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
> = Layer.mergeAll(AppsHttpApiClient.layer, AppsAdminHttpApiClient.layer)

export { sliceRuntimeLayer }
export type { RouterContext, RunAuthed, RuntimeLayer }
