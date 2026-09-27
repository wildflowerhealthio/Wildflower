/**
 * The FHIR R4 resources TanStack-Query surface.
 *
 *   - {@link file://./patients.ts} — the `Patient` search read (the consenting
 *     owner's patient picker, consumed by `gatekeeper-react`) and the one-patient
 *     read by id (the launch patient `apps/fhir-sync-pebble-web` confirms).
 *
 * Shared scaffolding lives in {@link file://./keys.ts} (the query-key roots) and
 * {@link file://./use-run-authed.ts} (the authed-runner hook each `queryFn`
 * reads from router context).
 */

export { PATIENTS_QUERY_KEY, patientQueryKey } from './keys.ts'
export { useRunAuthed } from './use-run-authed.ts'

export {
  patientQueryOptions,
  patientsQueryOptions,
  usePatientQuery,
  usePatientsQuery,
} from './patients.ts'
export type { PatientResource } from './patients.ts'

export type { RunAuthed } from '../router-context.ts'
