import type { ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'
import { adoptedReferenceOf } from '@wildflowerhealthio/fhir-r4/identity'
import {
  type CustomerPayload,
  SHOPPERS_DRUGMART_SYSTEM,
  type SourcePatient,
} from '@wildflowerhealthio/shoppers-drugmart-source'
import type { Story } from '@wildflowerhealthio/synthetic-data-fundamentals/story'

/**
 * A family's Shoppers Drug Mart "mypharmacy" account: the account the portal
 * keys every account-wide XHR by, the store that fills for it, and the people
 * it manages, each with the story of what they were prescribed.
 *
 * @remarks
 * A generator input: the stories are the data set's, the account's ids and
 * contact details are what the portal adds around them. The account holder is
 * the first person the account manages, as the portal lists them.
 */

/** A postal address, as the customers body spells it (without a second line). */
type ShoppersAddress = Required<
  Omit<NonNullable<(typeof CustomerPayload.Encoded)['customer']['address']>, 'line2'>
>

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

/** One person the account manages (a `customer.patients[]` entry). */
interface ShoppersPatient {
  /**
   * The portal's `patients[].id` ({@link SourcePatient}); every prescription
   * of theirs names it as `patientId`.
   */
  readonly patientId: (typeof SourcePatient.Encoded)['id']
  /** Ten digits, as the portal writes phone numbers. */
  readonly phoneNumber: string
  /** Who they are and what they were prescribed. */
  readonly story: Story.Story
}

/** See the module summary. */
interface ShoppersAccount {
  /** The account's `customer.pcid`: the `customerId` every account-wide XHR is keyed by. */
  readonly pcid: (typeof CustomerPayload.Encoded)['customer']['pcid']
  /** The account holder's contact phone, ten digits. */
  readonly phoneNumber: string
  /** The household's address, which the portal repeats on every managed person. */
  readonly address: ShoppersAddress
  readonly store: ShoppersStore
  /** In the order the portal lists them: the account holder first. */
  readonly patients: readonly [ShoppersPatient, ...ShoppersPatient[]]
}

/**
 * A reference to the Patient the Shoppers import makes of one person the
 * account manages, as that import spells its own: keyed by their `patientId`
 * under the Shoppers source system — not the account Patient keyed by `pcid`.
 * What a result from another source is filed on.
 */
const shoppersPatientReferenceOf = (patient: ShoppersPatient): ReferenceType =>
  adoptedReferenceOf({ system: SHOPPERS_DRUGMART_SYSTEM }, 'Patient', patient.patientId)

export { shoppersPatientReferenceOf }
export type { ShoppersAccount, ShoppersAddress, ShoppersPatient, ShoppersStore }
