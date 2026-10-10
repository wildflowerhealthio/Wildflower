import { DateTime } from 'effect'
import { type CarebookProfile, carebookTimestampOf } from 'rexall-be-well-source'
import { Person, StoryDay } from 'synthetic-data-fundamentals/story'

import type { RexallAccount } from './rexall-account.ts'

/**
 * The body of `…/enduser/profile/v2/me` the portal returns for `person`'s
 * `account`, in the shape of `rexall-be-well-source`'s
 * `fixtures/profile-me.json`.
 *
 * @param asOf - The as-of instant the account's days are dated from
 */
const profileOf = (
  asOf: DateTime.Utc,
  person: Person.Person,
  account: RexallAccount
): typeof CarebookProfile.Encoded => ({
  data: {
    identifiers: { email: person.email, uid: account.uid, reportingGuid: account.reportingGuid },
    names: { firstName: person.givenName, lastName: person.familyName },
    birthDate: DateTime.formatIsoDate(Person.birthDateOf(person, asOf)),
    zipPostalCode: person.postalCode,
    accountState: 'Validated',
    createdOn: carebookTimestampOf(
      StoryDay.instantOn(asOf, account.createdDay, [account.uid, 'created'], 0, 24)
    ),
    updatedOn: carebookTimestampOf(
      StoryDay.instantOn(asOf, account.updatedDay, [account.uid, 'updated'], 0, 24)
    ),
  },
  related: { profiles: [] },
})

export { profileOf }
