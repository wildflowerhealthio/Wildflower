import type { CustomerPayload, SourcePatient } from '@wildflowerhealthio/shoppers-drugmart-source'

import type { ShoppersAccount, ShoppersPatient } from './shoppers-account.ts'

/**
 * The body of `…/api/v1/customers/pcid/<pcid>?expand=…`: the account and the
 * people it manages, written as `shoppers-drugmart-source`'s
 * {@link CustomerPayload} encodes it (see its `customer-response-kind.test.ts`
 * fixture).
 *
 * @remarks
 * The account's `id` equals its `pcid`, as the capture shows. Each managed
 * person carries the capture's `userId` (the account) and `storeId`, and the
 * body its `stores`, which the source does not read. The portal sends no birth
 * date or gender here, so the imported Patients carry neither.
 */

/** One `customer.patients[]` entry: a {@link SourcePatient}, plus the capture's unread ids. */
type CustomerPatient = typeof SourcePatient.Encoded & {
  readonly userId: string
  readonly storeId: number
}

/** The whole customers body. */
type CustomerBody = typeof CustomerPayload.Encoded & {
  readonly customer: { readonly id: string; readonly patients: readonly CustomerPatient[] }
  readonly stores: readonly [{ readonly id: number; readonly storeName: string }]
}

const customerPatientOf = (account: ShoppersAccount, patient: ShoppersPatient): CustomerPatient => {
  const { person } = patient.story
  return {
    id: patient.patientId,
    firstName: person.givenName,
    lastName: person.familyName,
    displayName: `${person.givenName} ${person.familyName}`,
    userId: account.pcid,
    storeId: account.store.id,
    phoneNumber: patient.phoneNumber,
    address: account.address,
  }
}

/** The customers body for `account`; the account holder is its first patient. */
const customerPayloadOf = (account: ShoppersAccount): CustomerBody => {
  const holder = account.patients[0].story.person
  return {
    customer: {
      id: account.pcid,
      pcid: account.pcid,
      firstName: holder.givenName,
      lastName: holder.familyName,
      email: holder.email,
      phoneNumber: account.phoneNumber,
      address: account.address,
      patients: account.patients.map((patient) => customerPatientOf(account, patient)),
    },
    stores: [{ id: account.store.id, storeName: account.store.storeName }],
  }
}

export { customerPayloadOf }
