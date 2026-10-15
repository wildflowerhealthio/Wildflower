import { queryOptions, type UseQueryOptions } from '@tanstack/react-query'
import { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import type { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, type Schema } from 'effect'

import type { RunAuthed } from '../router-context.ts'
import { PATIENTS_QUERY_KEY } from './keys.ts'

/**
 * A decoded `Patient` resource as returned in the `Patient.SearchByGet`
 * bundle. Aliased to the FHIR `Patient` schema's decoded type — a
 * concrete named type (so it survives the slice's `.d.ts` emit, unlike a
 * derivation through the client's `Effect`-returning method signature).
 */
type PatientResource = Schema.Schema.Type<typeof Patient.Schema>

/**
 * Fetches the patient list (FHIR `Patient` search) and flattens the
 * bundle to the resource rows. The list is keyed under
 * {@link PATIENTS_QUERY_KEY}.
 */
const patientsQueryOptions = (
  runAuthed: RunAuthed
): UseQueryOptions<
  readonly PatientResource[],
  Error,
  readonly PatientResource[],
  typeof PATIENTS_QUERY_KEY
> =>
  queryOptions({
    queryKey: PATIENTS_QUERY_KEY,
    queryFn: (): Promise<readonly PatientResource[]> =>
      runAuthed(
        Effect.gen(function* () {
          const client = yield* FhirR4ResourcesHttpApiClient
          const bundle = yield* client.Patient.SearchByGet({ urlParams: {} })
          const resources: readonly PatientResource[] = (bundle.entry ?? []).flatMap(
            (entry): readonly PatientResource[] => {
              const resource = entry.resource
              return resource === undefined || resource === null ? [] : [resource]
            }
          )
          return resources
        })
      ),
  })

export { patientsQueryOptions }
export type { PatientResource }
