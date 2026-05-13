import { type Scope, Stream } from 'effect'
import type { FhirResourcesHttpApiClient } from 'fhir-r4/clients'
import { useMemo } from 'react'
import { useStream } from 'react-kitchen-sink'

import { useFhirResourcesClientLayer } from './use-fhir-resources-client-layer.ts'

/**
 * React Suspense-friendly runner for a `Stream` that requires
 * `FhirResourcesHttpApiClient`. Auto-provides the slice's client
 * layer, the `BearerToken` (read from `<AuthTokenProvider>` higher
 * up), and `webHttpClientLayer`.
 */
const useFhirResourcesStream = <A, E>(
  stream: Stream.Stream<A, E, FhirResourcesHttpApiClient | Scope.Scope>
): Promise<A> => {
  const clientLayer = useFhirResourcesClientLayer()

  const provided = useMemo(
    () => stream.pipe(Stream.provideSomeLayer(clientLayer)),
    [stream, clientLayer]
  )

  return useStream(provided)
}

export { useFhirResourcesStream }
