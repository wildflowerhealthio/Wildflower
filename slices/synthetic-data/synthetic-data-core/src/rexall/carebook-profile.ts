import { DateTime } from 'effect'

import * as Person from '../person.ts'
import { carebookTimestampOf, instantOn } from './carebook-time.ts'
import type { RexallAccount } from './rexall-account.ts'

/**
 * The body of `…/enduser/profile/v2/me`, in the shape of
 * `rexall-be-well-source/src/fixtures/profile-me.json`.
 */
interface CarebookProfile {
  readonly data: {
    readonly identifiers: {
      readonly email: string
      readonly uid: string
      readonly reportingGuid: string
    }
    readonly names: { readonly firstName: string; readonly lastName: string }
    readonly birthDate: string
    readonly zipPostalCode: string
    readonly accountState: 'Validated'
    readonly createdOn: string
    readonly updatedOn: string
  }
  readonly related: { readonly profiles: readonly [] }
}

/**
 * The profile the portal returns for `person`'s `account`.
 *
 * @param asOf - The as-of instant the account's days are dated from
 */
const profileOf = (
  asOf: DateTime.Utc,
  person: Person.Person,
  account: RexallAccount
): CarebookProfile => ({
  data: {
    identifiers: { email: person.email, uid: account.uid, reportingGuid: account.reportingGuid },
    names: { firstName: person.givenName, lastName: person.familyName },
    birthDate: DateTime.formatIsoDate(Person.birthDateOf(person, asOf)),
    zipPostalCode: person.postalCode,
    accountState: 'Validated',
    createdOn: carebookTimestampOf(
      instantOn(asOf, account.createdDay, [account.uid, 'created'], 0, 24)
    ),
    updatedOn: carebookTimestampOf(
      instantOn(asOf, account.updatedDay, [account.uid, 'updated'], 0, 24)
    ),
  },
  related: { profiles: [] },
})

export { profileOf }
export type { CarebookProfile }
