import { queryOptions, type UseQueryOptions } from '@tanstack/react-query'
import {
  fetchPatient,
  type PatientResource,
  type SmartClient,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { Effect, type Option } from 'effect'

/**
 * The read of patient `patientId` (`fetchPatient`: `None` when the server
 * has no such patient) as a query on the page's
 * cache: the one `PatientChoiceLine` names the patient from, and a routed
 * app's patient route loads before it renders (`ensureRoutedPatient`), so
 * the two share one request.
 */
const patientQuery = (
  client: SmartClient,
  patientId: string
): UseQueryOptions<
  Option.Option<PatientResource>,
  Error,
  Option.Option<PatientResource>,
  readonly ['patient', string]
> =>
  queryOptions({
    queryKey: ['patient', patientId] as const,
    queryFn: (): Promise<Option.Option<PatientResource>> =>
      Effect.runPromise(fetchPatient(client, patientId)),
  })

export { patientQuery }
