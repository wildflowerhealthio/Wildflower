import { REXALL_CAREBOOK_SYSTEM } from 'rexall-be-well-source'

import type { SourcePatient } from '../source-patient.ts'
import type { StoryDay } from '../story-day.ts'

/**
 * A person's Rexall Be Well (letsbewell.ca) account: the ids the portal's
 * profile and prescriptions list are keyed by, and the store that fills for
 * them.
 */
interface RexallAccount {
  /** The profile's `identifiers.uid`; prescriptions reference `Patient/<uid>`. */
  readonly uid: string
  /** The profile's `identifiers.reportingGuid`. */
  readonly reportingGuid: string
  /** The Rexall store number (`external-store-id`), as its store locator numbers it. */
  readonly storeId: string
  /** Carebook's id for the store's pharmacy location (`medication-processor`). */
  readonly pharmacyLocationId: string
  /** The day the account was created. */
  readonly createdDay: StoryDay
  /** The day the profile was last updated. */
  readonly updatedDay: StoryDay
}

/**
 * The Patient the Rexall import makes of the account's profile: keyed by its
 * `uid` under the carebook source system.
 */
const sourcePatientOf = (account: RexallAccount): SourcePatient => ({
  system: REXALL_CAREBOOK_SYSTEM,
  originalId: account.uid,
})

export { sourcePatientOf }
export type { RexallAccount }
