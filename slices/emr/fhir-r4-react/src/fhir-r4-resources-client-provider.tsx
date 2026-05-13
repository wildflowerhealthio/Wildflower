import type { JSX, PropsWithChildren } from 'react'

import { buildFhirR4ResourcesClientLayer } from './client/fhir-r4-resources-client.ts'
import { FhirR4ResourcesClientLayerContext } from './fhir-r4-resources-client-context.ts'

// The slice's client layer no longer depends on a token directly —
// `buildFhirR4ResourcesClientLayer()` reads from the `BearerToken` service
// at request time, so a single layer instance suffices for the entire
// app. Build it once at module load and re-use across every mount.
const fhirResourcesClientLayer = buildFhirR4ResourcesClientLayer()

type FhirR4ResourcesClientProviderProps = PropsWithChildren

/**
 * Provides the slice's client `Layer` to descendants via
 * {@link FhirR4ResourcesClientLayerContext}. No token prop — the layer
 * reads the live token from {@link BearerToken} (a Subscribable
 * provided higher in the tree via `<AuthTokenProvider>` from
 * react-kitchen-sink).
 */
const FhirR4ResourcesClientProvider = ({
  children,
}: FhirR4ResourcesClientProviderProps): JSX.Element => (
  <FhirR4ResourcesClientLayerContext.Provider value={fhirResourcesClientLayer}>
    {children}
  </FhirR4ResourcesClientLayerContext.Provider>
)

export { FhirR4ResourcesClientProvider }
export type { FhirR4ResourcesClientProviderProps }
