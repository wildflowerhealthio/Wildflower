import type { RunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'

import type { SmartClient } from '../smart-client.ts'

/**
 * Everything a lifting screen that writes reads and writes through: one
 * launch, for one lifter. There is none for "All patients", which only reads.
 */
interface LiftingSession {
  /** The SMART client every search is issued through. */
  readonly client: SmartClient
  /** The lifter: every search is scoped to them, and every write names them. */
  readonly patientId: string
  /** Runs a write against the FHIR server the handshake named, with the granted token. */
  readonly runAuthed: RunAuthed
}

/** The lifter as every resource written names them: a reference to the session's patient. */
const subjectOf = (session: LiftingSession): IdentifierAndReference.ReferenceType =>
  IdentifierAndReference.referenceTo({ resourceType: 'Patient', id: session.patientId })

/**
 * The key every lifting query and write of one patient scope sits under — a
 * lifter's id, or `null` for every patient's records — so one invalidation
 * refetches the whole record and one `useIsMutating` sees every write.
 */
const liftingKeyOf = (patientScope: string | null): readonly ['lifting', string | null] => [
  'lifting',
  patientScope,
]

export { liftingKeyOf, type LiftingSession, subjectOf }
