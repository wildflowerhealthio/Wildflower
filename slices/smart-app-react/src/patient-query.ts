import { queryOptions, type UseQueryOptions } from '@tanstack/react-query'
import {
  fetchPatient,
  type PatientRead,
  type SmartClient,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { Effect } from 'effect'

/**
 * The read of patient `patientId` (`fetchPatient`) as a query on the page's
 * cache: the one `PatientChoiceLine` names the patient from, and a routed
 * app's patient route loads before it renders (`ensureRoutedPatient`), so
 * the two share one request.
 */
const patientQuery = (
  client: SmartClient,
  patientId: string
): UseQueryOptions<PatientRead, Error, PatientRead, readonly ['patient', string]> =>
  queryOptions({
    queryKey: ['patient', patientId] as const,
    queryFn: (): Promise<PatientRead> => Effect.runPromise(fetchPatient(client, patientId)),
  })

export { patientQuery }
