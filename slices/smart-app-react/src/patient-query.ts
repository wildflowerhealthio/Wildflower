import { queryOptions, type UseQueryOptions } from '@tanstack/react-query'
import {
  fetchPatient,
  type PatientResource,
  type RunSmart,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import type { Option } from 'effect'

/**
 * The read of patient `patientId` (`fetchPatient`: `None` when the server
 * has no such patient) as a query on the page's
 * cache: the one `PatientChoiceLine` names the patient from, and a routed
 * app's patient route loads before it renders (`requirePatient`), so
 * the two share one request. `runSmart` runs it: `useRunSmart`'s in a
 * component, the router context's `runAuthed` in a loader.
 */
const patientQuery = (
  runSmart: RunSmart,
  patientId: string
): UseQueryOptions<
  Option.Option<PatientResource>,
  Error,
  Option.Option<PatientResource>,
  readonly ['patient', string]
> =>
  queryOptions({
    queryKey: ['patient', patientId] as const,
    queryFn: (): Promise<Option.Option<PatientResource>> => runSmart(fetchPatient(patientId)),
  })

export { patientQuery }
