import type { HttpClient } from '@effect/platform'
import { Layer } from 'effect'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { useContext, useMemo } from 'react'
import { bearerTokenLayer, useAuthTokenSubscribable, type BearerToken } from 'react-kitchen-sink'
import { webHttpClientLayer } from 'telemetry-react'

import { FhirR4ResourcesClientLayerContext } from './fhir-r4-resources-client-context.ts'

/**
 * Returns the slice's client `Layer` —
 * `Layer<FhirR4ResourcesHttpApiClient, never, HttpClient | BearerToken>`.
 * Used by the app's `useAllClientsLayer()` for cross-slice composition.
 *
 * Most screen code shouldn't need this — reach for
 * `useFhirR4ResourcesEffect` / `useFhirR4ResourcesStream` /
 * `useFhirR4ResourcesEffectRunner`, which auto-provide the slice layer,
 * `BearerToken`, and `webHttpClientLayer`.
 *
 * Throws when no `<FhirR4ResourcesClientProvider>` is in the tree.
 */
const useFhirR4ResourcesClientLayer = (): Layer.Layer<
  FhirR4ResourcesHttpApiClient | HttpClient.HttpClient | BearerToken,
  never,
  never
> => {
  const fhirResourcesLayer = useContext(FhirR4ResourcesClientLayerContext)
  if (fhirResourcesLayer === null) {
    throw new Error(
      'useFhirR4ResourcesClientLayer must be used inside <FhirR4ResourcesClientProvider>'
    )
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

export { useFhirR4ResourcesClientLayer }
