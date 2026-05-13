import type { JSX, PropsWithChildren } from 'react'

import { buildFhirResourcesClientLayer } from './client/fhir-resources-client.ts'
import { FhirResourcesClientLayerContext } from './fhir-resources-client-context.ts'

// The slice's client layer no longer depends on a token directly —
// `buildFhirResourcesClientLayer()` reads from the `BearerToken` service
// at request time, so a single layer instance suffices for the entire
// app. Build it once at module load and re-use across every mount.
const fhirResourcesClientLayer = buildFhirResourcesClientLayer()

type FhirResourcesClientProviderProps = PropsWithChildren

/**
 * Provides the slice's client `Layer` to descendants via
 * {@link FhirResourcesClientLayerContext}. No token prop — the layer
 * reads the live token from {@link BearerToken} (a Subscribable
 * provided higher in the tree via `<AuthTokenProvider>` from
 * react-kitchen-sink).
 */
const FhirResourcesClientProvider = ({
  children,
}: FhirResourcesClientProviderProps): JSX.Element => (
  <FhirResourcesClientLayerContext.Provider value={fhirResourcesClientLayer}>
    {children}
  </FhirResourcesClientLayerContext.Provider>
)

export { FhirResourcesClientProvider }
export type { FhirResourcesClientProviderProps }
