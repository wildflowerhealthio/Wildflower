import type { HttpClient } from '@effect/platform'
import { Layer } from 'effect'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { useContext, useMemo } from 'react'
import { bearerTokenLayer, useAuthTokenSubscribable, type BearerToken } from 'react-kitchen-sink'

import { webHttpClientLayer } from 'telemetry-react'
import { GatekeeperClientLayerContext } from './gatekeeper-client-context.ts'

/**
 * Returns the slice's client `Layer` —
 * `Layer<GatekeeperHttpApiClient, never, HttpClient | BearerToken>`.
 * Used by the app's `useAllClientsLayer()` for cross-slice composition.
 *
 * Most screen code shouldn't need this — reach for
 * `useGatekeeperEffect` / `useGatekeeperStream` /
 * `useGatekeeperEffectRunner`, which auto-provide the slice layer,
 * `BearerToken`, and `webHttpClientLayer`.
 *
 * Throws when no `<GatekeeperClientProvider>` is in the tree.
 */
const useGatekeeperClientLayer = (): Layer.Layer<
  GatekeeperHttpApiClient | HttpClient.HttpClient | BearerToken,
  never,
  never
> => {
  const gatekeeperLayer = useContext(GatekeeperClientLayerContext)
  if (gatekeeperLayer === null) {
    throw new Error('useGatekeeperClientLayer must be used inside <GatekeeperClientProvider>')
  }
  const tokenSubscribable = useAuthTokenSubscribable()
  return useMemo(
    () =>
      gatekeeperLayer.pipe(
        Layer.provideMerge(bearerTokenLayer(tokenSubscribable)),
        Layer.provideMerge(webHttpClientLayer)
      ),
    [gatekeeperLayer, tokenSubscribable]
  )
}

export { useGatekeeperClientLayer }
