import type { MedicationRequest } from 'fhir-r4/resources'
import { nonEmpty } from 'kitchen-sink'

/**
 * Store-locator bases the sources write onto
 * `dispenseRequest.performer.reference`. A reference under one of them names
 * that chain's store. Keep in step with `rexall-be-well-source`'s
 * `REXALL_STORE_LOCATOR_BASE` and `shoppers-drugmart-source`'s
 * `SHOPPERS_STORE_LOCATOR_BASE`.
 */
const REXALL_STORE_URL_BASE = 'https://www.rexall.ca/storelocator/store/'
const SHOPPERS_STORE_URL_BASE = 'https://www.shoppersdrugmart.ca/store-locator/store/'

/**
 * `dispenseRequest.performer.reference` when it is a URL under `base` — the
 * slot the sources write the dispensing store's public store-locator page to.
 */
const storeUrlOf = (request: MedicationRequest.Type, base: string): string | null => {
  const reference = nonEmpty(request.dispenseRequest?.performer?.reference)
  return reference !== null && reference.startsWith(base) ? reference : null
}

/** The Rexall store-locator URL the request was dispensed from, if any. */
const rexallStoreUrlOf = (request: MedicationRequest.Type): string | null =>
  storeUrlOf(request, REXALL_STORE_URL_BASE)

/** The Shoppers Drug Mart store-locator URL the request was dispensed from, if any. */
const shoppersStoreUrlOf = (request: MedicationRequest.Type): string | null =>
  storeUrlOf(request, SHOPPERS_STORE_URL_BASE)

export { rexallStoreUrlOf, shoppersStoreUrlOf }
