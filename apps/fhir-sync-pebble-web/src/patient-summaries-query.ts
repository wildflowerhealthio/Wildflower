import { HttpClient } from '@effect/platform'
import {
  queryOptions,
  useQuery,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query'
import { Effect } from 'effect'
import { useRunAuthed, type RunAuthed } from 'fhir-r4-react'
import { RESOURCE_PAGE_SIZE } from 'fhir-r4-react/smart'
import { PatientSummary } from 'fhir-sync-pebble-core'

/**
 * The key the patient list is cached under. Its own root rather than
 * `fhir-r4-react`'s `PATIENTS_QUERY_KEY`: the rows are this app's lenient
 * {@link PatientSummary.Type}, not decoded `fhir-r4` `Patient`s, so the two
 * must never share a cache entry.
 */
const PATIENT_SUMMARIES_QUERY_KEY = ['fhir-sync-pebble', 'patient-summaries'] as const

/**
 * The first page's search parameters. Sorted by family name server-side, as
 * `fhir-r4-react`'s `fetchPatientPage` sorts the no-context picker, so the list
 * reads in a stable, scannable order; `_count` pinned to the same
 * `RESOURCE_PAGE_SIZE`, because a server's default page (commonly 10–50) would
 * cut the list short.
 */
const SEARCH_PARAMS = { _sort: 'family', _count: String(RESOURCE_PAGE_SIZE) }

/**
 * Reads the server's patients (FHIR `Patient` search) as the summaries the
 * settings page lists, keyed under {@link PATIENT_SUMMARIES_QUERY_KEY}.
 *
 * @param runAuthed - The route context's authed runner
 *
 * @remarks
 * The search goes out through the `HttpClient` the router context provides —
 * `smartHttpClientLayer`, which addresses the relative `/Patient` to the FHIR
 * base the handshake named and adds the granted bearer token — rather than
 * through the typed `fhir-r4` client, whose strict `Patient` decode would fail
 * the whole list over one partial birth date. The body is read with
 * {@link PatientSummary.fromSearchBundle}, which drops an entry it cannot read
 * and keeps the rest. A non-2xx answer, or a body that is not a bundle,
 * rejects.
 *
 * One page: a server holding more patients than `RESOURCE_PAGE_SIZE` lists the
 * first page's worth.
 */
const patientSummariesQueryOptions = (
  runAuthed: RunAuthed
): UseQueryOptions<
  readonly PatientSummary.Type[],
  Error,
  readonly PatientSummary.Type[],
  typeof PATIENT_SUMMARIES_QUERY_KEY
> =>
  queryOptions({
    queryKey: PATIENT_SUMMARIES_QUERY_KEY,
    queryFn: (): Promise<readonly PatientSummary.Type[]> =>
      runAuthed(
        Effect.gen(function* () {
          const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
          const response = yield* client.get('/Patient', { urlParams: SEARCH_PARAMS })
          return yield* PatientSummary.fromSearchBundle(yield* response.json)
        })
      ),
  })

/** Reads the server's patients, through the route context's authed runner. */
const usePatientSummariesQuery = (): UseQueryResult<readonly PatientSummary.Type[], Error> =>
  useQuery(patientSummariesQueryOptions(useRunAuthed()))

export { PATIENT_SUMMARIES_QUERY_KEY, patientSummariesQueryOptions, usePatientSummariesQuery }
