import * as Person from '../person.ts'
import type { ShoppersAccount, ShoppersAddress, ShoppersPatient } from './shoppers-account.ts'

/**
 * The body of `…/api/v1/customers/pcid/<pcid>?expand=…`: the account and the
 * people it manages, in the shape `shoppers-drugmart-source`'s
 * `CustomerResponseKind` reads (see its `customer-response-kind.test.ts`
 * fixture).
 *
 * @remarks
 * The account's `id` equals its `pcid`, as the capture shows. Each managed
 * person carries the extras the capture does — `userId` (the account) and
 * `storeId` — which the importer does not read. The portal sends no birth date
 * or gender here, so the imported Patients carry neither.
 */

/** One `customer.patients[]` entry. */
interface CustomerPatient {
  readonly id: string
  readonly firstName: string
  readonly lastName: string
  readonly displayName: string
  readonly userId: string
  readonly storeId: number
  readonly phoneNumber: string
  readonly address: ShoppersAddress
}

/** The whole customers body. */
interface CustomerPayload {
  readonly customer: {
    readonly id: string
    readonly pcid: string
    readonly firstName: string
    readonly lastName: string
    readonly email: string
    readonly phoneNumber: string
    readonly address: ShoppersAddress
    readonly patients: readonly CustomerPatient[]
  }
  readonly stores: readonly [{ readonly id: number; readonly storeName: string }]
}

const customerPatientOf = (account: ShoppersAccount, patient: ShoppersPatient): CustomerPatient => {
  const { person } = patient.story
  return {
    id: patient.patientId,
    firstName: person.givenName,
    lastName: person.familyName,
    displayName: Person.fullNameOf(person),
    userId: account.pcid,
    storeId: account.store.id,
    phoneNumber: patient.phoneNumber,
    address: account.address,
  }
}

/** The customers body for `account`. */
const customerPayloadOf = (account: ShoppersAccount): CustomerPayload => ({
  customer: {
    id: account.pcid,
    pcid: account.pcid,
    firstName: account.holder.givenName,
    lastName: account.holder.familyName,
    email: account.holder.email,
    phoneNumber: account.phoneNumber,
    address: account.address,
    patients: account.patients.map((patient) => customerPatientOf(account, patient)),
  },
  stores: [{ id: account.store.id, storeName: account.store.storeName }],
})

export { customerPayloadOf }
export type { CustomerPatient, CustomerPayload }
