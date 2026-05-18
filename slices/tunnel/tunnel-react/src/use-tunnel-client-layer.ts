import type { HttpClient } from '@effect/platform'
import { Layer } from 'effect'
import { useContext, useMemo } from 'react'
import { bearerTokenLayer, useAuthTokenSubscribable, type BearerToken } from 'react-kitchen-sink'
import { webHttpClientLayer } from 'telemetry-react'
import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'

import { TunnelAdminClientLayerContext } from './tunnel-client-context.ts'

/**
 * Returns the slice's admin client `Layer` —
 * `Layer<TunnelAdminHttpApiClient | HttpClient | BearerToken, never, never>`.
 * Used by the app's `useAllClientsLayer()` for cross-slice composition.
 *
 * Most screen code shouldn't need this — reach for `useTunnelAdminEffect`
 * / `useTunnelAdminEffectRunner`, which auto-provide the slice layer,
 * `BearerToken`, and `webHttpClientLayer`.
 *
 * Throws when no `<TunnelClientProvider>` is in the tree.
 */
const useTunnelAdminClientLayer = (): Layer.Layer<
  TunnelAdminHttpApiClient | HttpClient.HttpClient | BearerToken,
  never,
  never
> => {
  const tunnelAdminLayer = useContext(TunnelAdminClientLayerContext)
  if (tunnelAdminLayer === null) {
    throw new Error('useTunnelAdminClientLayer must be used inside <TunnelClientProvider>')
  }
  const tokenSubscribable = useAuthTokenSubscribable()
  return useMemo(
    () =>
      tunnelAdminLayer.pipe(
        Layer.provideMerge(bearerTokenLayer(tokenSubscribable)),
        Layer.provideMerge(webHttpClientLayer)
      ),
    [tunnelAdminLayer, tokenSubscribable]
  )
}

export { useTunnelAdminClientLayer }
