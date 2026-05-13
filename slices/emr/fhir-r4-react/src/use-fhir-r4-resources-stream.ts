import type { Scope, Stream } from 'effect'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { useStream } from 'react-kitchen-sink'

import { useFhirR4ResourcesClientLayer } from './use-fhir-r4-resources-client-layer.ts'

/**
 * Thin wrapper around `useStream` that supplies the slice's full
 * client layer (`FhirR4ResourcesHttpApiClient` + `BearerToken` +
 * `webHttpClientLayer`). The screen just constructs the Stream; the
 * shared kitchen-sink hook handles subscription, scope, and lifecycle.
 */
const useFhirR4ResourcesStream = <A, E>(
  stream: Stream.Stream<A, E, FhirR4ResourcesHttpApiClient | Scope.Scope>
): Promise<A> => useStream(stream, useFhirR4ResourcesClientLayer())

export { useFhirR4ResourcesStream }
