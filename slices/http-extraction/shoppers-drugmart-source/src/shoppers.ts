/**
 * Constants for the Shoppers Drug Mart "mypharmacy" portal
 * (`mypharmacy.shoppersdrugmart.ca`): the FHIR identifier and coding systems
 * this source stamps onto the resources it synthesizes from the portal's
 * bespoke (non-FHIR) `customers` / `prescription-status` / `prescription-history`
 * JSON.
 *
 * Grouped here so the entity modules reference one catalogue rather than
 * sprinkling opaque URLs through the code, and so a future correction is a
 * one-line change.
 *
 * @remarks
 * These system URIs are best-guess namespaces under the portal host, *not*
 * captured from a canonical registry. In particular:
 *
 * - Only people are identified, never the account: `PatientId` names a person
 *   the account manages (a `customer.patients[].id`, the id a prescription's
 *   `patientId` references). Prescriptions are filled for a person, so the
 *   account's own id (the `customerId` in the account-wide query strings) is
 *   no identifier here.
 * - There is deliberately **no** Shoppers DIN system: the portal does not
 *   namespace DINs, so a DIN is coded under `fhir-r4`'s canonical
 *   `CanadianCodingSystem.Din` only.
 */

/** Base URL every Shoppers identifier/coding system is built from. */
const SYSTEM_BASE = 'https://mypharmacy.shoppersdrugmart.ca/fhir'

/** Shoppers identifier systems for the ids the portal JSON carries. */
const ShoppersIdentifierSystem = {
  /**
   * A managed person's `patientId` (a `customer.patients[].id`, the id a
   * prescription's `patientId` references).
   */
  PatientId: `${SYSTEM_BASE}/identifier/patient-id`,
  /** A prescription's human-facing `prescriptionNumber`. */
  PrescriptionNumber: `${SYSTEM_BASE}/identifier/prescription-number`,
  /** A dispense's `dispenseId`. */
  DispenseId: `${SYSTEM_BASE}/identifier/dispense-id`,
} as const

/**
 * Coding system for the portal's machine-readable prescription-status `type`
 * enum (`READY_FOR_RENEW`, `UNABLE_TO_RENEW_ONLINE`,
 * `READY_FOR_REFILL_NO_DISPENSE`, …), stamped onto the synthesized
 * `MedicationRequest.statusReason.coding`. The set is **open** — new codes may
 * appear — so the schema decodes it as a free string rather than a literal
 * union, and this system just namespaces whatever code the portal sends so the
 * coding stays self-describing.
 */
const PRESCRIPTION_STATUS_TYPE_SYSTEM = `${SYSTEM_BASE}/CodeSystem/prescription-status-type`

/**
 * Where Shoppers Drug Mart's public store-locator pages live — a
 * customer-facing web page, not a portal-namespaced FHIR system, so it is not
 * under {@link SYSTEM_BASE}.
 */
const STORE_LOCATOR_BASE = 'https://www.shoppersdrugmart.ca/store-locator/store/'

/**
 * The public store-locator page for a prescription's `storeId`, stamped onto
 * `MedicationRequest.dispenseRequest.performer.reference` and
 * `MedicationDispense.location.reference`, with the store number URL-encoded
 * so it cannot escape the store path.
 */
const shoppersStoreLocatorUrl = (storeId: string | number): string =>
  `${STORE_LOCATOR_BASE}${encodeURIComponent(String(storeId))}`

/**
 * The store's name for the `display` beside its store-locator link, when the
 * portal gives none of its own.
 */
const shoppersStoreDisplay = (storeId: string | number): string =>
  `Shoppers Drug Mart (store ${storeId})`

export {
  ShoppersIdentifierSystem,
  PRESCRIPTION_STATUS_TYPE_SYSTEM,
  SYSTEM_BASE,
  shoppersStoreDisplay,
  shoppersStoreLocatorUrl,
}
