import type { CollectorHttpApiClient } from 'collector-core/clients'
import { CollectorClientLayerContext } from 'collector-react'
import { Layer } from 'effect'
import { FhirResourcesClientLayerContext } from 'fhir-r4-react'
import type { FhirResourcesHttpApiClient } from 'fhir-r4/clients'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { GatekeeperClientLayerContext } from 'gatekeeper-react'
import { useContext, useMemo } from 'react'
import { bearerTokenLayer, useAuthTokenSubscribable } from 'react-kitchen-sink'
import { webHttpClientLayer } from 'telemetry-react'

/**
 * Composes every slice's client layer into one self-contained
 * `Layer<AllClients, never, never>` — provides `BearerToken` (read
 * from `<AuthTokenProvider>`) and `webHttpClientLayer` at the bottom.
 *
 * Reads each slice's *bare* layer (the layer-context, not the
 * self-providing hook) so the auth + http layers get provided exactly
 * once at this composition site.
 *
 * Use this where app code needs to call multiple slice clients in a
 * single Effect (or wants a single composed runtime). Slice-internal
 * screens reach for their slice's per-effect runner instead
 * (`useGatekeeperEffect` / `useCollectorEffect` /
 * `useFhirResourcesEffect` / …), which auto-provide the same trio
 * behind the scenes.
 */
const useAllClientsLayer = (): Layer.Layer<
  GatekeeperHttpApiClient | CollectorHttpApiClient | FhirResourcesHttpApiClient
> => {
  const gatekeeperLayer = useContext(GatekeeperClientLayerContext)
  if (gatekeeperLayer === null) {
    throw new Error('useAllClientsLayer must be used inside <GatekeeperClientProvider>')
  }
  const collectorLayer = useContext(CollectorClientLayerContext)
  if (collectorLayer === null) {
    throw new Error('useAllClientsLayer must be used inside <CollectorClientProvider>')
  }
  const fhirResourcesLayer = useContext(FhirResourcesClientLayerContext)
  if (fhirResourcesLayer === null) {
    throw new Error('useAllClientsLayer must be used inside <FhirResourcesClientProvider>')
  }
  const tokenSubscribable = useAuthTokenSubscribable()

  return useMemo(
    () =>
      Layer.mergeAll(gatekeeperLayer, collectorLayer, fhirResourcesLayer).pipe(
        Layer.provide(bearerTokenLayer(tokenSubscribable)),
        Layer.provide(webHttpClientLayer)
      ),
    [gatekeeperLayer, collectorLayer, fhirResourcesLayer, tokenSubscribable]
  )
}

export { useAllClientsLayer }
