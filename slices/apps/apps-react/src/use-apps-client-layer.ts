import type { HttpClient } from '@effect/platform'
import type { AppsAdminHttpApiClient, AppsHttpApiClient } from 'apps-core/clients'
import { Layer } from 'effect'
import { useContext, useMemo } from 'react'
import { bearerTokenLayer, useAuthTokenSubscribable, type BearerToken } from 'react-kitchen-sink'
import { webHttpClientLayer } from 'telemetry-react'

import { AppsAdminClientLayerContext, AppsClientLayerContext } from './apps-client-context.ts'

/**
 * Returns the slice's *public* client `Layer` —
 * `Layer<AppsHttpApiClient | HttpClient, never, never>`. Used by the
 * app's `useAllClientsLayer()` for cross-slice composition.
 *
 * Most screen code shouldn't need this — reach for `useAppsEffect` /
 * `useAppsEffectRunner`, which auto-provide the slice layer and
 * `webHttpClientLayer`.
 *
 * Throws when no `<AppsClientProvider>` is in the tree.
 */
const useAppsClientLayer = (): Layer.Layer<
  AppsHttpApiClient | HttpClient.HttpClient,
  never,
  never
> => {
  const appsLayer = useContext(AppsClientLayerContext)
  if (appsLayer === null) {
    throw new Error('useAppsClientLayer must be used inside <AppsClientProvider>')
  }
  return useMemo(() => appsLayer.pipe(Layer.provideMerge(webHttpClientLayer)), [appsLayer])
}

/**
 * Returns the slice's *admin* client `Layer` —
 * `Layer<AppsAdminHttpApiClient | HttpClient | BearerToken, never, never>`.
 * Used by the app's `useAllClientsLayer()` for cross-slice composition.
 *
 * Most screen code shouldn't need this — reach for `useAppsAdminEffect`
 * / `useAppsAdminEffectRunner`, which auto-provide the slice layer,
 * `BearerToken`, and `webHttpClientLayer`.
 *
 * Throws when no `<AppsClientProvider>` is in the tree.
 */
const useAppsAdminClientLayer = (): Layer.Layer<
  AppsAdminHttpApiClient | HttpClient.HttpClient | BearerToken,
  never,
  never
> => {
  const appsAdminLayer = useContext(AppsAdminClientLayerContext)
  if (appsAdminLayer === null) {
    throw new Error('useAppsAdminClientLayer must be used inside <AppsClientProvider>')
  }
  const tokenSubscribable = useAuthTokenSubscribable()
  return useMemo(
    () =>
      appsAdminLayer.pipe(
        Layer.provideMerge(bearerTokenLayer(tokenSubscribable)),
        Layer.provideMerge(webHttpClientLayer)
      ),
    [appsAdminLayer, tokenSubscribable]
  )
}

export { useAppsAdminClientLayer, useAppsClientLayer }
