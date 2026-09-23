/**
 * Constants for the Shoppers Drug Mart "mypharmacy" portal
 * (`mypharmacy.shoppersdrugmart.ca`): the FHIR identifier and coding systems
 * this collector stamps onto the resources it synthesizes from the portal's
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
 * - `PcId` vs `PatientId` are **two distinct identifier systems**: `pcId` names
 *   the account (the `customer.pcid`, the `customerId` in every query string),
 *   `patientId` names a person the account manages (a `customer.patients[].id`,
 *   the id a prescription's `patientId` references). Unlike the earlier design,
 *   the relationship is now **known and joinable**: the customers payload carries
 *   both — `customer.pcid` alongside each `customer.patients[].id` — so the
 *   account `Patient` links to each demographic `Patient` via `link.seealso`
 *   (see {@link CustomerResponseKind}). The two systems stay distinct because they
 *   identify different things (an account vs a person), not because the join is
 *   unknown.
 * - `DIN_CODE_SYSTEM` is the portal-namespaced vendor DIN system. Every DIN
 *   coding under it has a twin under `fhir-r4`'s canonical
 *   `CanadianCodingSystem.Din` beside it; the vendor one is kept so a reader
 *   that already matches on it still finds the code (mirrors how
 *   `rexall-be-well-source` treats its carebook DIN system).
 */

/** Base URL every Shoppers identifier/coding system is built from. */
const SYSTEM_BASE = 'https://mypharmacy.shoppersdrugmart.ca/fhir'

/** Shoppers identifier systems for the ids the portal JSON carries. */
const ShoppersIdentifierSystem = {
  /**
   * The account's `pcid` (PC Health id, `== customer.id == the customerId` query
   * param). Names the account, not a managed person — distinct from
   * {@link ShoppersIdentifierSystem.PatientId}.
   */
  PcId: `${SYSTEM_BASE}/identifier/pc-id`,
  /**
   * A managed person's `patientId` (a `customer.patients[].id`, the id a
   * prescription's `patientId` references). Joinable to `pcId` through the
   * customers payload, but a different kind of thing — see the module remarks.
   */
  PatientId: `${SYSTEM_BASE}/identifier/patient-id`,
  /** A prescription's human-facing `prescriptionNumber`. */
  PrescriptionNumber: `${SYSTEM_BASE}/identifier/prescription-number`,
  /** A dispense's `dispenseId`. */
  DispenseId: `${SYSTEM_BASE}/identifier/dispense-id`,
} as const

/**
 * The portal-namespaced vendor coding system for Health Canada Drug
 * Identification Numbers (DIN), stamped onto the synthesized
 * `medicationCodeableConcept.coding`. Each coding under it is paired with one
 * under the canonical `CanadianCodingSystem.Din` (`fhir-r4`), which is the
 * system a reader should match on; this one is kept alongside, additively.
 */
const DIN_CODE_SYSTEM = `${SYSTEM_BASE}/CodeSystem/din`

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
 * Base of the public Shoppers Drug Mart store-locator URL. A prescription's
 * `storeId` is appended to build the `…/store-locator/store/:id` link stamped
 * onto `MedicationRequest.dispenseRequest.performer.reference` and
 * `MedicationDispense.location.reference` (see {@link shoppersStoreLocatorUrl}).
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
  PRESCRIPTION_STATUS_TYPE_SYSTEM,
  SYSTEM_BASE,
  SHOPPERS_STORE_LOCATOR_BASE,
  shoppersStoreLocatorUrl,
}
