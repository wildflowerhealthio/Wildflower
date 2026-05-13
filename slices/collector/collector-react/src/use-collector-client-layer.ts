import type { HttpClient } from '@effect/platform'
import type { CollectorHttpApiClient } from 'collector-core/clients'
import { Layer } from 'effect'
import { useContext, useMemo } from 'react'
import { bearerTokenLayer, useAuthTokenSubscribable, type BearerToken } from 'react-kitchen-sink'
import { webHttpClientLayer } from 'telemetry-react'

import { CollectorClientLayerContext } from './collector-client-context.ts'

/**
 * Returns the slice's client `Layer` —
 * `Layer<CollectorHttpApiClient, never, HttpClient | BearerToken>`.
 * Used by the app's `useAllClientsLayer()` for cross-slice composition.
 *
 * Most screen code shouldn't need this — reach for `useCollectorEffect`
 * / `useCollectorStream` / `useCollectorEffectRunner`, which
 * auto-provide the slice layer, `BearerToken`, and `webHttpClientLayer`.
 *
 * Throws when no `<CollectorClientProvider>` is in the tree.
 */
const useCollectorClientLayer = (): Layer.Layer<
  CollectorHttpApiClient | HttpClient.HttpClient | BearerToken,
  never,
  never
> => {
  const collectorLayer = useContext(CollectorClientLayerContext)
  if (collectorLayer === null) {
    throw new Error('useCollectorClientLayer must be used inside <CollectorClientProvider>')
  }
  const tokenSubscribable = useAuthTokenSubscribable()
  return useMemo(
    () =>
      collectorLayer.pipe(
        Layer.provideMerge(bearerTokenLayer(tokenSubscribable)),
        Layer.provideMerge(webHttpClientLayer)
      ),
    [collectorLayer, tokenSubscribable]
  )
}

export { useCollectorClientLayer }
