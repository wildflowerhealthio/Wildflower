import type { HttpClient } from '@effect/platform'
import { Layer } from 'effect'
import type { FhirResourcesHttpApiClient } from 'fhir-r4/clients'
import { useContext, useMemo } from 'react'
import { bearerTokenLayer, useAuthTokenSubscribable, type BearerToken } from 'react-kitchen-sink'
import { webHttpClientLayer } from 'telemetry-react'

import { FhirResourcesClientLayerContext } from './fhir-resources-client-context.ts'

/**
 * Returns the slice's client `Layer` —
 * `Layer<FhirResourcesHttpApiClient, never, HttpClient | BearerToken>`.
 * Used by the app's `useAllClientsLayer()` for cross-slice composition.
 *
 * Most screen code shouldn't need this — reach for
 * `useFhirResourcesEffect` / `useFhirResourcesStream` /
 * `useFhirResourcesEffectRunner`, which auto-provide the slice layer,
 * `BearerToken`, and `webHttpClientLayer`.
 *
 * Throws when no `<FhirResourcesClientProvider>` is in the tree.
 */
const useFhirResourcesClientLayer = (): Layer.Layer<
  FhirResourcesHttpApiClient | HttpClient.HttpClient | BearerToken,
  never,
  never
> => {
  const fhirResourcesLayer = useContext(FhirResourcesClientLayerContext)
  if (fhirResourcesLayer === null) {
    throw new Error('useFhirResourcesClientLayer must be used inside <FhirResourcesClientProvider>')
  }
  const tokenSubscribable = useAuthTokenSubscribable()
  return useMemo(
    () =>
      fhirResourcesLayer.pipe(
        Layer.provideMerge(bearerTokenLayer(tokenSubscribable)),
        Layer.provideMerge(webHttpClientLayer)
      ),
    [fhirResourcesLayer, tokenSubscribable]
  )
}

export { useFhirResourcesClientLayer }
