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
  /**
   * Absolute API origin, set only when the page is not served by the API
   * server (the Tauri webview loads from the dev server / asset protocol,
   * which has no `/apps` route, while the API lives on the host's loopback
   * origin). The launch POST targets `${apiBaseUrl}/apps/{id}` so it reaches
   * the host server rather than the page origin. Omitted on web/embedded,
   * where the page IS the API origin and a relative path suffices.
   */
  readonly apiBaseUrl?: string
}

const sliceRuntimeLayer: Layer.Layer<
  AppsHttpApiClient | AppsAdminHttpApiClient,
  never,
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
> = Layer.mergeAll(AppsHttpApiClient.layer, AppsAdminHttpApiClient.layer)

export { sliceRuntimeLayer }
export type { RouterContext, RunAuthed, RuntimeLayer }
