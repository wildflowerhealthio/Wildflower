/**
 * Constants for the Rexall/carebook STU3 dialect: the extension URLs,
 * identifier systems, and coding systems observed in the tunnel API's
 * `…/fhir/stu3/…` responses.
 *
 * These are grouped here so the schema and transform modules reference a
 * single catalogue rather than sprinkling opaque URLs through the code, and so
 * a future capture that reveals a slightly different URL is a one-line change.
 *
 * @remarks
 * Note the two host spellings the dialect uses: extension URLs live under
 * `schemas.carebook.com` (plural) while identifier/coding systems live under
 * `schema.carebook.com` (singular). Both are reproduced verbatim from the
 * epic's dialect notes — do not "correct" one to match the other.
 */

/** Base URL every carebook extension URL is built from (note: `schemas`, plural). */
const EXTENSION_BASE = 'http://schemas.carebook.com/v1/fhir'

/** Base URL every carebook identifier/coding system is built from (note: `schema`, singular). */
const SYSTEM_BASE = 'http://schema.carebook.com/v1/fhir'

/**
 * Carebook extension URLs. Carried verbatim onto the transformed R4 resources
 * (R4 permits arbitrary extensions) so no source metadata is dropped.
 */
const CarebookExtension = {
  /** When the request was originally made in the source system. */
  WhenRequested: `${EXTENSION_BASE}/when-requested`,
  /** Estimated pick-up time for a dispense. */
  EstimatedPickUp: `${EXTENSION_BASE}/estimated-pick-up`,
  /** Identifier of the external system the record originated from. */
  ExternalSystemSource: `${EXTENSION_BASE}/external-system-source`,
  /** How the record entered the source system. */
  InputSource: `${EXTENSION_BASE}/input-source`,
  /** Processor that handled the medication. */
  MedicationProcessor: `${EXTENSION_BASE}/medication-processor`,
  /** Processor that handled the medication record. */
  MedicationRecordProcessor: `${EXTENSION_BASE}/medicationrecord-processor`,
  /** External store identifier the record is associated with. */
  ExternalStoreId: `${EXTENSION_BASE}/external-store-id`,
  /** Request type discriminator (`order` | `refill`). */
  RequestType: `${EXTENSION_BASE}/request-type`,
  /** Whether the prescription is renewable. */
  Renewable: `${EXTENSION_BASE}/renewable`,
  /** Contained-Medication strength (free-text / structured strength). */
  MedicationStrength: `${EXTENSION_BASE}/medication-strength`,
  /** Contained-Medication human-readable description. */
  MedicationDescription: `${EXTENSION_BASE}/medication-description`,
  /**
   * Repeats still available on the request. Emitted as a `modifierExtension`
   * on `MedicationRequest.dispenseRequest` in the carebook dialect.
   */
  NumberOfRepeatsAvailable: `${EXTENSION_BASE}/number-of-repeats-available`,
} as const

/** Carebook identifier systems. */
const CarebookIdentifierSystem = {
  /** External id assigned to a MedicationRequest by the source system. */
  MedicationRequestExternalId: `${SYSTEM_BASE}/identifier/medicationrequest-external-id`,
  /** External id of the authorizing prescription for a MedicationRequest. */
  MedicationRequestExternalAuthorizingId: `${SYSTEM_BASE}/identifier/medicationrequest-external-authorizing-id`,
} as const

/**
 * Coding system for Health Canada Drug Identification Numbers (DIN) as emitted
 * by the carebook dialect on contained `Medication.code`.
 */
const DIN_CODE_SYSTEM = `${SYSTEM_BASE}/CodeSystem/din`

/** `MedicationRequest.request-type` extension value set. */
const RequestType = { Order: 'order', Refill: 'refill' } as const

export {
  CarebookExtension,
  CarebookIdentifierSystem,
  DIN_CODE_SYSTEM,
  EXTENSION_BASE,
  SYSTEM_BASE,
  RequestType,
}
