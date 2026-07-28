/**
 * Constants for the Rexall/carebook STU3 dialect: the extension URLs,
 * identifier systems, and coding systems the tunnel API's `…/fhir/stu3/…`
 * responses actually emit.
 *
 * Grouped here so the schema, transform and promotion modules reference a
 * single catalogue, and so a future capture revealing a different URL is a
 * one-line change.
 *
 * @remarks
 * Reproduced verbatim from a real (anonymized) capture, and cross-checked
 * against `medication-sponsorship-react`, which independently reads five of
 * these off the same dialect. The inconsistencies below are the vendor's and
 * must not be "tidied":
 *
 * - Two host spellings, and the split is not by kind: extension URLs **and**
 *   the `request-type` coding system are under `schemas.carebook.com` (plural);
 *   every identifier system and the `din` / `form` codings are under
 *   `schema.carebook.com` (singular).
 * - `number-of-repeats-available` is dual-written under `v1` and `v2` with
 *   different value types (`positiveInt`, `decimal`) carrying the same number.
 */

/** Extension base for the dialect's `v1` URLs (note: `schemas`, plural). */
const EXTENSION_BASE = 'http://schemas.carebook.com/v1/fhir'

/**
 * Extension base for the dialect's `v2` URLs. Only
 * {@link CarebookExtension.NumberOfRepeatsAvailableV2} uses it.
 */
const EXTENSION_BASE_V2 = 'http://schemas.carebook.com/v2/fhir'

/** Base for identifier systems and the `din` / `form` codings (note: `schema`, singular). */
const SYSTEM_BASE = 'http://schema.carebook.com/v1/fhir'

/**
 * Carebook extension URLs, grouped by the resource namespace they appear
 * under. Every one of these is populated on every resource of its type in the
 * reference capture.
 */
const CarebookExtension = {
  // --- common/ — emitted on both MedicationRequest and MedicationDispense ---
  /** Identifier of the external system the record originated from (`RexallPharmacy`). */
  ExternalSystemSource: `${EXTENSION_BASE}/common/extension/external-system-source`,
  /** How the record entered the source system. */
  InputSource: `${EXTENSION_BASE}/common/extension/input-source`,

  // --- medicationrequest/ ---
  /** Estimated pick-up time. Equal to the paired dispense's `whenHandedOver`. */
  RequestEstimatedPickUp: `${EXTENSION_BASE}/medicationrequest/extension/estimated-pick-up`,
  /** Request type discriminator; see {@link RequestType}. Promoted to `category`. */
  RequestType: `${EXTENSION_BASE}/medicationrequest/extension/request-type`,
  /** The dispensing pharmacy. Promoted to `dispenseRequest.performer`. */
  RequestMedicationProcessor: `${EXTENSION_BASE}/medicationrequest/extension/medication-processor`,
  /** Duplicate of {@link CarebookExtension.RequestMedicationProcessor} in every observed record. */
  RequestMedicationRecordProcessor: `${EXTENSION_BASE}/medicationrequest/extension/medicationrecord-processor`,
  /** The R4 `doNotPerform` flag, which STU3 has no slot for. Promoted to `doNotPerform`. */
  DoNotPerform: `${EXTENSION_BASE}/medicationrequest/extension/do-not-perform`,
  /** Whether the prescription is renewable. No conventional R4 field. */
  Renewable: `${EXTENSION_BASE}/medicationrequest/extension/renewable`,
  /** Rexall store number. Promoted onto the `dispenseRequest.performer` reference. */
  RequestExternalStoreId: `${EXTENSION_BASE}/medicationrequest/extension/external-store-id`,
  /** Presentation rank for the prescriptions list. Non-contiguous; not clinical. */
  SortOrder: `${EXTENSION_BASE}/medicationrequest/extension/sort-order`,
  /** Unpopulated stub in the reference capture (`display: 'todo'`). */
  PrescriptionOrder: `${EXTENSION_BASE}/medicationrequest/extension/prescription-order`,
  /**
   * Repeats still available. Emitted as a `modifierExtension` on
   * `MedicationRequest.dispenseRequest`, as a `positiveInt`.
   */
  NumberOfRepeatsAvailable: `${EXTENSION_BASE}/medicationrequest/extension/number-of-repeats-available`,
  /**
   * The `v2` spelling of {@link CarebookExtension.NumberOfRepeatsAvailable},
   * emitted alongside it as a `decimal` carrying the same number.
   */
  NumberOfRepeatsAvailableV2: `${EXTENSION_BASE_V2}/medicationrequest/extension/number-of-repeats-available`,

  // --- medicationdispense/ ---
  /** When the refill was requested. Equal to `whenPrepared` in every observed record. */
  WhenRequested: `${EXTENSION_BASE}/medicationdispense/extension/when-requested`,
  /** Estimated pick-up. Equal to `whenHandedOver` in every observed record. */
  DispenseEstimatedPickUp: `${EXTENSION_BASE}/medicationdispense/extension/estimated-pick-up`,
  /** Whether the refill was requested in-app. No conventional R4 field. */
  DispensedInApp: `${EXTENSION_BASE}/medicationdispense/extension/dispensed-in-app`,
  /**
   * IANA zone of the dispensing pharmacy. The dialect's timestamps all arrive
   * `+00:00`, so this is the only record of their local offset — but the R4
   * schemas normalize `dateTime` to UTC on decode, so it cannot be applied to
   * them today. Carried through unchanged.
   */
  MedicationProcessorTimezone: `${EXTENSION_BASE}/medicationdispense/extension/medication-processor-timezone`,
  /** The dispensing pharmacy. Promoted to `MedicationDispense.location`. */
  DispenseMedicationProcessor: `${EXTENSION_BASE}/medicationdispense/extension/medication-processor`,
  /** Duplicate of {@link CarebookExtension.DispenseMedicationProcessor} in every observed record. */
  DispenseMedicationRecordProcessor: `${EXTENSION_BASE}/medicationdispense/extension/medicationrecord-processor`,
  /** Rexall store number. Promoted onto the `location` reference. */
  DispenseExternalStoreId: `${EXTENSION_BASE}/medicationdispense/extension/external-store-id`,

  // --- medication/ — on the contained Medication ---
  /** Free-text strength (e.g. `'10 mg'`). Promoted to `ingredient[0].strength` when parseable. */
  MedicationStrength: `${EXTENSION_BASE}/medication/extension/strength`,
  /** Human-readable label, richer than `code.text`. Promoted to the narrative. */
  MedicationDescription: `${EXTENSION_BASE}/medication/extension/description`,
} as const

/** Carebook identifier systems (all under the singular `schema.carebook.com`). */
const CarebookIdentifierSystem = {
  /** External id assigned to a medication record by the source system. */
  MedicationRequestExternalId: `${SYSTEM_BASE}/identifier/medicationrequest-external-id`,
  /** External id of the authorizing prescription. */
  MedicationRequestExternalAuthorizingId: `${SYSTEM_BASE}/identifier/medicationrequest-external-authorizing-id`,
  /**
   * Marks an `authorizingPrescription` entry as the original order. The dialect
   * emits this and {@link CarebookIdentifierSystem.MedicationRequestTypeRefill}
   * as two entries carrying the *same* reference.
   */
  MedicationRequestTypeOrder: `${SYSTEM_BASE}/identifier/medication-request-type-order`,
  /** Marks an `authorizingPrescription` entry as a refill. See the `Order` note. */
  MedicationRequestTypeRefill: `${SYSTEM_BASE}/identifier/medication-request-type-refill`,
} as const

/** Carebook coding systems. Note the host spelling differs between these. */
const CarebookCodingSystem = {
  /** Health Canada Drug Identification Numbers, on `Medication.code`. */
  Din: `${SYSTEM_BASE}/coding/medication-din-code`,
  /** Dose form, on `Medication.form` (e.g. `capsule`, `tablet`). */
  MedicationForm: `${SYSTEM_BASE}/coding/medication-form-code`,
  /** The {@link RequestType} value set. Under `schemas` (plural), unlike the two above. */
  RequestType: `${EXTENSION_BASE}/coding/medicationrequest-request-type-code`,
} as const

/**
 * Identifier system for the Rexall store number once it is promoted onto a
 * `Reference.identifier`.
 *
 * Minted by us, under our own namespace: carebook publishes the store number
 * only as a bare `valueString` extension and defines no identifier system for
 * it, so reusing a `carebook.com` URL here would misattribute our modelling
 * choice to the vendor.
 */
const REXALL_STORE_IDENTIFIER_SYSTEM = 'http://wildflower.health/identifier/rexall-store-id'

/**
 * `MedicationRequest.request-type` value set, as observed. Note this is
 * `fill | refill` — **not** `order | refill`; `intent` is a constant `order`
 * across every observed record and carries no signal.
 */
const RequestType = { Fill: 'fill', Refill: 'refill' } as const

/** Value {@link CarebookExtension.ExternalSystemSource} carries for Rexall-sourced records. */
const REXALL_SYSTEM_SOURCE = 'RexallPharmacy'

export {
  CarebookCodingSystem,
  CarebookExtension,
  CarebookIdentifierSystem,
  EXTENSION_BASE,
  EXTENSION_BASE_V2,
  REXALL_STORE_IDENTIFIER_SYSTEM,
  REXALL_SYSTEM_SOURCE,
  RequestType,
  SYSTEM_BASE,
}
