/**
 * The FHIR R4 resources TanStack-Query surface.
 *
 *   - {@link file://./patients.ts} — the `Patient` search read (the consenting
 *     owner's patient picker, consumed by `gatekeeper-react`).
 *
 * Shared scaffolding lives in {@link file://./keys.ts} (the query-key roots) and
 * {@link file://./use-run-authed.ts} (the authed-runner hook each `queryFn`
 * reads from router context).
 */

export { PATIENTS_QUERY_KEY } from './keys.ts'
export { useRunAuthed } from './use-run-authed.ts'

export { patientsQueryOptions, usePatientsQuery } from './patients.ts'
export type { PatientResource } from './patients.ts'

export type { RunAuthed } from '../router-context.ts'
