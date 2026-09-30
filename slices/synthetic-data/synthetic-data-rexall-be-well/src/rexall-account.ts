import type { CarebookProfile, medicationListUrlOf } from 'rexall-be-well-source'
import type { StoryDay } from 'synthetic-data-fundamentals/story'

/** The profile's `identifiers`, as the carebook profile body spells them. */
type ProfileIdentifiers = Required<(typeof CarebookProfile.Encoded)['data']['identifiers']>

/**
 * A person's Rexall Be Well (letsbewell.ca) account: the ids the portal's
 * profile and prescriptions list are keyed by, the store that fills for them,
 * and when the account was made.
 *
 * @remarks
 * A generator input, not a story: the same story can be filled under any
 * account. `uid` and `reportingGuid` are the profile's `identifiers`
 * ({@link CarebookProfile}); prescriptions reference `Patient/<uid>`, and
 * `pharmacyLocationId` is the `medication-processor` both the list URL
 * ({@link medicationListUrlOf}) and every medication name.
 */
interface RexallAccount extends Pick<ProfileIdentifiers, 'uid' | 'reportingGuid'> {
  /** The Rexall store number (`external-store-id`), as its store locator numbers it. */
  readonly storeId: string
  /** Carebook's id for the store's pharmacy location. */
  readonly pharmacyLocationId: Parameters<typeof medicationListUrlOf>[0]['pharmacyLocationId']
  /** The day the account was created. */
  readonly createdDay: StoryDay.StoryDay
  /** The day the profile was last updated. */
  readonly updatedDay: StoryDay.StoryDay
}

export type { RexallAccount }
