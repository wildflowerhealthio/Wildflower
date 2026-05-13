import type { Effect, Scope } from 'effect'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { useEffectTs } from 'react-kitchen-sink'

import { useFhirR4ResourcesClientLayer } from './use-fhir-r4-resources-client-layer.ts'

/**
 * Thin wrapper around `useEffectTs` that supplies the slice's full
 * client layer (`FhirR4ResourcesHttpApiClient` + `BearerToken` +
 * `webHttpClientLayer`). The screen just constructs the Effect; the
 * shared kitchen-sink hook handles fork/exit/scope.
 *
 * @example
 * ```ts
 * const patientEffect = useMemo(
 *   () => Effect.flatMap(FhirR4ResourcesHttpApiClient, (c) =>
 *     c['Patient'].GetById({ path: { id } })
 *   ),
 *   [id]
 * )
 * const patient = useFhirR4ResourcesEffect(patientEffect)
 * ```
 */
const useFhirR4ResourcesEffect = <A, E>(
  effect: Effect.Effect<A, E, FhirR4ResourcesHttpApiClient | Scope.Scope>
): Promise<A> => useEffectTs(effect, useFhirR4ResourcesClientLayer())

export { useFhirR4ResourcesEffect }
