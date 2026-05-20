import type { HttpClient } from '@effect/platform'
import { Layer } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'
import { useContext, useMemo } from 'react'
import { useAuthTokenSubscribable } from 'react-kitchen-sink'
import { webHttpClientLayer } from 'telemetry-react'
import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'

import { TunnelAdminClientLayerContext } from './tunnel-client-context.ts'

/**
 * Returns the tunnel slice's admin client `Layer` —
 * `Layer<TunnelAdminHttpApiClient | HttpClient | BearerToken, never, never>`.
 * Used by the app's `useAllClientsLayer()` for cross-slice composition.
 *
 * Most screen code shouldn't need this — reach for
 * `useTunnelAdminEffect` / `useTunnelAdminEffectRunner`, which
 * auto-provide the slice layer, `BearerToken`, and `webHttpClientLayer`.
 *
 * Throws when no `<TunnelClientProvider>` is in the tree.
 */
const useTunnelAdminClientLayer = (): Layer.Layer<
  TunnelAdminHttpApiClient | HttpClient.HttpClient | BearerToken,
  never,
  never
> => {
  const tunnelLayer = useContext(TunnelAdminClientLayerContext)
  if (tunnelLayer === null) {
    throw new Error('useTunnelAdminClientLayer must be used inside <TunnelClientProvider>')
  }
  const tokenSubscribable = useAuthTokenSubscribable()
  return useMemo(
    (): Layer.Layer<TunnelAdminHttpApiClient | HttpClient.HttpClient | BearerToken, never, never> =>
      tunnelLayer.pipe(
        Layer.provideMerge(Layer.succeed(BearerToken, tokenSubscribable)),
        Layer.provideMerge(webHttpClientLayer)
      ),
    [tunnelLayer, tokenSubscribable]
  )
}

export { useTunnelAdminClientLayer }
