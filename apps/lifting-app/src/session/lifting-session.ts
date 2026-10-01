import type { RunAuthed } from 'fhir-r4-react'
import { IdentifierAndReference } from 'fhir-r4/data-types'

import type { SmartClient } from '../smart-client.ts'

/** Everything a lifting screen reads and writes through: one launch, for one lifter. */
interface LiftingSession {
  /** The SMART client every search is issued through. */
  readonly client: SmartClient
  /** The launch's patient: every search is scoped to them. */
  readonly patientId: string
  /** Runs a write against the FHIR server the handshake named, with the granted token. */
  readonly runAuthed: RunAuthed
}

/** The lifter as every resource written names them: a reference to the launch's patient. */
const subjectOf = (session: LiftingSession): IdentifierAndReference.ReferenceType =>
  IdentifierAndReference.referenceTo({ resourceType: 'Patient', id: session.patientId })

/**
 * The key every lifting query and write of one lifter sits under, so one
 * invalidation refetches the whole record and one `useIsMutating` sees every
 * write.
 */
const liftingKeyOf = (patientId: string): readonly ['lifting', string] => ['lifting', patientId]

export { liftingKeyOf, type LiftingSession, subjectOf }
