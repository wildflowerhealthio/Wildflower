import { SHOPPERS_DRUGMART_SYSTEM } from 'shoppers-drugmart-source'

import type { Person } from '../person.ts'
import type { SourcePatient } from '../source-patient.ts'
import type { Story } from '../story.ts'

/**
 * A family's Shoppers Drug Mart "mypharmacy" account: the account holder who
 * signs in, the store that fills for them, and the people the account manages,
 * each with the story of what they were prescribed.
 */

/** A postal address as the portal carries it. */
interface ShoppersAddress {
  readonly line1: string
  readonly city: string
  /** Two-letter province code (`ON`). */
  readonly province: string
  /** Canadian postal code (`A1A 1A1`). */
  readonly postalCode: string
}

/** The store the account's prescriptions are filled at. */
interface ShoppersStore {
  /** The store number, which the portal writes as a JSON number. */
  readonly id: number
  /** The name the history feed prints for it. */
  readonly storeName: string
  /** Ten digits, as the portal writes phone numbers. */
  readonly phoneNumber: string
  readonly address: ShoppersAddress
}

/** One person the account manages (`customer.patients[]`). */
interface ShoppersPatient {
  /** The portal's `patients[].id`; every prescription of theirs names it as `patientId`. */
  readonly patientId: string
  /** Ten digits, as the portal writes phone numbers. */
  readonly phoneNumber: string
  /** Who they are and what they were prescribed. */
  readonly story: Story
}

/** See the module summary. */
interface ShoppersAccount {
  /** The account's `customer.pcid`: the `customerId` every account-wide XHR is keyed by. */
  readonly pcid: string
  /** Who signs in; also one of `patients`. */
  readonly holder: Person
  /** The holder's contact phone, ten digits. */
  readonly phoneNumber: string
  /** The household's address, which the portal repeats on every managed person. */
  readonly address: ShoppersAddress
  readonly store: ShoppersStore
  /** In the order the portal lists them: the holder first. */
  readonly patients: readonly ShoppersPatient[]
}

/**
 * The Patient the Shoppers import makes of one person the account manages:
 * keyed by their `patients[].id` under the Shoppers source system — not the
 * account Patient keyed by `pcid`.
 */
const sourcePatientOf = (patient: ShoppersPatient): SourcePatient => ({
  system: SHOPPERS_DRUGMART_SYSTEM,
  originalId: patient.patientId,
})

export { sourcePatientOf }
export type { ShoppersAccount, ShoppersAddress, ShoppersPatient, ShoppersStore }
