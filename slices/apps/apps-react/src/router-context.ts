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
   * origin). It is purely the app-launch arm selector: set ⇒ the loopback
   * (Tauri) arm, which drives the authed Effect client's `POST /apps/{id}` (the
   * typed client owns the host origin) so the SPA stays mounted; unset ⇒ the web
   * arm, where the home tile is a native `<a href="/apps/{id}">` the browser
   * follows against the page origin (which IS the API origin). See `-launch.ts`.
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
