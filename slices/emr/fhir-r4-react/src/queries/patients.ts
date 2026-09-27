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
import { PATIENTS_QUERY_KEY, patientQueryKey } from './keys.ts'
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

/**
 * Reads one `Patient` by logical id (FHIR `read`, `GET /Patient/{id}`) — the
 * read a `patient/Patient.r` grant allows for the patient a SMART launch put in
 * context. Keyed under {@link patientQueryKey}. A `404` or any other failure
 * rejects, so a caller can tell "no such patient" from a patient it can show.
 */
const patientQueryOptions = (
  runAuthed: RunAuthed,
  id: string
): UseQueryOptions<PatientResource, Error, PatientResource, ReturnType<typeof patientQueryKey>> =>
  queryOptions({
    queryKey: patientQueryKey(id),
    queryFn: (): Promise<PatientResource> =>
      runAuthed(
        Effect.gen(function* () {
          const client = yield* FhirR4ResourcesHttpApiClient
          return yield* client.Patient.GetById({ path: { id } })
        })
      ),
  })

/** Reads one `Patient` by logical id, through the route context's authed runner. */
const usePatientQuery = (id: string): UseQueryResult<PatientResource, Error> =>
  useQuery(patientQueryOptions(useRunAuthed(), id))

export { patientQueryOptions, patientsQueryOptions, usePatientQuery, usePatientsQuery }
export type { PatientResource }
