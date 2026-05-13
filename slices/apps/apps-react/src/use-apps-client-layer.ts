import type { HttpClient } from '@effect/platform'
import type { AppsHttpApiClient } from 'apps-core/clients'
import { Layer } from 'effect'
import { useContext, useMemo } from 'react'
import { bearerTokenLayer, useAuthTokenSubscribable, type BearerToken } from 'react-kitchen-sink'
import { webHttpClientLayer } from 'telemetry-react'

import { AppsClientLayerContext } from './apps-client-context.ts'

/**
 * Returns the slice's client `Layer` —
 * `Layer<AppsHttpApiClient, never, HttpClient | BearerToken>`.
 * Used by the app's `useAllClientsLayer()` for cross-slice composition.
 *
 * Most screen code shouldn't need this — reach for `useAppsEffect` /
 * `useAppsEffectRunner`, which auto-provide the slice layer,
 * `BearerToken`, and `webHttpClientLayer`.
 *
 * Throws when no `<AppsClientProvider>` is in the tree.
 */
const useAppsClientLayer = (): Layer.Layer<
  AppsHttpApiClient | HttpClient.HttpClient | BearerToken,
  never,
  never
> => {
  const appsLayer = useContext(AppsClientLayerContext)
  if (appsLayer === null) {
    throw new Error('useAppsClientLayer must be used inside <AppsClientProvider>')
  }
  const tokenSubscribable = useAuthTokenSubscribable()
  return useMemo(
    () =>
      appsLayer.pipe(
        Layer.provideMerge(bearerTokenLayer(tokenSubscribable)),
        Layer.provideMerge(webHttpClientLayer)
      ),
    [appsLayer, tokenSubscribable]
  )
}

export { useAppsClientLayer }
