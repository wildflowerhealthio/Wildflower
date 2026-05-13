import { Effect, type Scope } from 'effect'
import type { FhirResourcesHttpApiClient } from 'fhir-r4/clients'
import { useMemo } from 'react'
import { useEffectTs } from 'react-kitchen-sink'

import { useFhirResourcesClientLayer } from './use-fhir-resources-client-layer.ts'

/**
 * React Suspense-friendly runner for an Effect that requires
 * `FhirResourcesHttpApiClient`. Auto-provides the slice's client
 * layer, the `BearerToken` (read from `<AuthTokenProvider>` higher
 * up), and `webHttpClientLayer` — the screen just constructs the
 * Effect without any `Effect.provide(...)` plumbing.
 *
 * @example
 * ```ts
 * const patientEffect = useMemo(
 *   () => Effect.flatMap(FhirResourcesHttpApiClient, (c) =>
 *     c['patient'].GetPatient({ path: { id } })
 *   ),
 *   [id]
 * )
 * const patient = useFhirResourcesEffect(patientEffect)
 * ```
 */
const useFhirResourcesEffect = <A, E>(
  effect: Effect.Effect<A, E, FhirResourcesHttpApiClient | Scope.Scope>
): Promise<A> => {
  const clientLayer = useFhirResourcesClientLayer()

  const provided = useMemo(() => effect.pipe(Effect.provide(clientLayer)), [effect, clientLayer])

  return useEffectTs(provided)
}

export { useFhirResourcesEffect }
