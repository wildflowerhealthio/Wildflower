/**
 * The FHIR R4 resources TanStack-Query surface: the authed-runner hook
 * ({@link file://./use-run-authed.ts}) each consumer's `queryFn` reads from
 * router context.
 */

export { useRunAuthed } from './use-run-authed.ts'

export type { RunAuthed } from '../router-context.ts'
