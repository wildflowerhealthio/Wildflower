import {
  queryOptions,
  useQuery,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query'
import { Effect, type Schema } from 'effect'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { Patient } from 'fhir-r4/resources'

import type { RunAuthed } from '../router-context.ts'
import { PATIENTS_QUERY_KEY } from './keys.ts'
import { useRunAuthed } from './use-run-authed.ts'

/**
 * A decoded `Patient` resource as returned in the `Patient.SearchByGet`
 * bundle. Aliased to the FHIR `Patient` schema's decoded type — a
 * concrete named type (so it survives the slice's `.d.ts` emit, unlike a
 * derivation through the client's `Effect`-returning method signature).
 */
type PatientResource = Schema.Schema.Type<typeof Patient.Schema>

/**
 * Fetches the patient list (FHIR `Patient` search) and flattens the
 * bundle to the resource rows. Shared by call sites that read the patient
 * picker (`gatekeeper-react`'s `usePatientOptions`).
 *
 * `useQuery`-shaped (not `useSuspenseQuery`): the only consumer gates the
 * read on a runtime `enabled` flag (the picker only matters when the
 * SMART app requested a `patient/*` scope), and a suspense query can't be
 * conditionally disabled from the same component. The list is keyed under
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

/**
 * Reads the patient list. `enabled` gates the read off when no patient
 * picker is needed (no `patient/*` scope requested); while disabled the
 * query never fires and `data` stays `undefined`.
 */
const usePatientsQuery = (enabled: boolean): UseQueryResult<readonly PatientResource[], Error> =>
  useQuery({ ...patientsQueryOptions(useRunAuthed()), enabled })

export { patientsQueryOptions, usePatientsQuery }
export type { PatientResource }
