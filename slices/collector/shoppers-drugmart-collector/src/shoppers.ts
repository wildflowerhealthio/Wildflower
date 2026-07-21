/**
 * Constants for the Shoppers Drug Mart "mypharmacy" portal
 * (`mypharmacy.shoppersdrugmart.ca`): the FHIR identifier and coding systems
 * this collector stamps onto the resources it synthesizes from the portal's
 * bespoke (non-FHIR) `getProfile` / `prescription-status` JSON.
 *
 * Grouped here so the entity modules reference one catalogue rather than
 * sprinkling opaque URLs through the code, and so a future correction is a
 * one-line change.
 *
 * @remarks
 * **OPEN QUESTION** — these system URIs are best-guess namespaces under the
 * portal host, *not* captured from a canonical registry. In particular:
 *
 * - `PcId` vs `PatientId` are **two distinct identifier systems on purpose**:
 *   the profile's `pcId` and a prescription's `patientId` do **not** align
 *   (confirmed against production), so each patient identifier is carried under
 *   its own system rather than conflated. See the profile/prescription entity
 *   docs for how the two Patient records relate.
 * - `DIN_CODE_SYSTEM` names Health Canada's Drug Identification Number. The
 *   canonical Health Canada / Infoway DIN system URI should be reconciled
 *   against a real capture before relying on downstream code lookups; the
 *   portal-namespaced value here keeps the coding self-describing in the
 *   meantime (mirrors how `rexall-be-well-collector` namespaces its DIN system).
 */

/** Base URL every Shoppers identifier/coding system is built from. */
const SYSTEM_BASE = 'https://mypharmacy.shoppersdrugmart.ca/fhir'

/** Shoppers identifier systems for the ids the portal JSON carries. */
const ShoppersIdentifierSystem = {
  /** The profile's `pcId` (PC Health id). Distinct from {@link ShoppersIdentifierSystem.PatientId}. */
  PcId: `${SYSTEM_BASE}/identifier/pc-id`,
  /** A prescription's `patientId`. Does **not** align with `pcId`. */
  PatientId: `${SYSTEM_BASE}/identifier/patient-id`,
  /** A prescription's human-facing `prescriptionNumber`. */
  PrescriptionNumber: `${SYSTEM_BASE}/identifier/prescription-number`,
  /** A dispense's `dispenseId`. */
  DispenseId: `${SYSTEM_BASE}/identifier/dispense-id`,
} as const

/**
 * Coding system for Health Canada Drug Identification Numbers (DIN), stamped
 * onto the synthesized `medicationCodeableConcept.coding`. Best-guess namespace
 * — reconcile against the canonical Health Canada / Infoway DIN system URI.
 */
const DIN_CODE_SYSTEM = `${SYSTEM_BASE}/CodeSystem/din`

/**
 * Base of the public Shoppers Drug Mart store-locator URL. A prescription's
 * `storeId` is appended to build the `…/store-locator/store/:id` link stamped
 * onto `MedicationRequest.supportingInformation` (see {@link shoppersStoreLocatorUrl}).
 * This is a **customer-facing web URL**, not a portal-namespaced FHIR system, so
 * it lives on `www.shoppersdrugmart.ca` rather than under {@link SYSTEM_BASE}.
 * The medication-sponsorship UI recognizes a Shoppers store by prefix-matching
 * this same base, so keep the two in sync.
 */
const SHOPPERS_STORE_LOCATOR_BASE = 'https://www.shoppersdrugmart.ca/store-locator/store/'

/** The store-locator URL for a prescription's `storeId`. */
const shoppersStoreLocatorUrl = (storeId: string | number): string =>
  `${SHOPPERS_STORE_LOCATOR_BASE}${encodeURIComponent(String(storeId))}`

export {
  ShoppersIdentifierSystem,
  DIN_CODE_SYSTEM,
  SYSTEM_BASE,
  SHOPPERS_STORE_LOCATOR_BASE,
  shoppersStoreLocatorUrl,
}
