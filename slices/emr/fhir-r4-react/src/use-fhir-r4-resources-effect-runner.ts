import type { Effect, Scope } from 'effect'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { useEffectAction } from 'react-kitchen-sink'

import { useFhirR4ResourcesClientLayer } from './use-fhir-r4-resources-client-layer.ts'

type FhirR4ResourcesEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, FhirR4ResourcesHttpApiClient | Scope.Scope>
) => Promise<A>

/**
 * Thin wrapper around `useEffectAction` that supplies the slice's
 * full client layer (`FhirR4ResourcesHttpApiClient` + `BearerToken` +
 * `webHttpClientLayer`). Returns a `<A, E>(effect) => Promise<A>`
 * runner for one-off effect executions outside the Suspense flow
 * (button-click handlers that await a write, for example).
 *
 * @example
 * ```ts
 * const run = useFhirR4ResourcesEffectRunner()
 *
 * const create = async (payload: Patient): Promise<void> => {
 *   await run(
 *     Effect.flatMap(FhirR4ResourcesHttpApiClient, (c) =>
 *       c.Patient.Create({ payload })
 *     )
 *   )
 * }
 * ```
 */
const useFhirR4ResourcesEffectRunner = (): FhirR4ResourcesEffectRunner =>
  useEffectAction(useFhirR4ResourcesClientLayer())

export { useFhirR4ResourcesEffectRunner }
export type { FhirR4ResourcesEffectRunner }
