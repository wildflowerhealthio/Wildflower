import { Option, pipe } from 'effect'
import { PharmacyStoreLocatorBase } from 'fhir-r4/data-types'
import type { MedicationRequest } from 'fhir-r4/resources'
import { nonEmpty } from 'kitchen-sink'

/**
 * `dispenseRequest.performer.reference` when it is a page under `base` — the
 * slot the sources write the dispensing store's public store-locator page to,
 * from the same `PharmacyStoreLocatorBase` this reads.
 */
const storeUrlOf = (request: MedicationRequest.Type, base: string): string | null =>
  pipe(
    Option.fromNullable(nonEmpty(request.dispenseRequest?.performer?.reference)),
    Option.filter((reference) => reference.startsWith(base)),
    Option.getOrNull
  )

/** The Rexall store-locator URL the request was dispensed from, if any. */
const rexallStoreUrlOf = (request: MedicationRequest.Type): string | null =>
  storeUrlOf(request, PharmacyStoreLocatorBase.Rexall)

/** The Shoppers Drug Mart store-locator URL the request was dispensed from, if any. */
const shoppersStoreUrlOf = (request: MedicationRequest.Type): string | null =>
  storeUrlOf(request, PharmacyStoreLocatorBase.ShoppersDrugMart)

export { rexallStoreUrlOf, shoppersStoreUrlOf }
