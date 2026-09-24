/**
 * The FHIR R4 adapters for the medication slices: map a decoded
 * `MedicationRequest` onto the core `Medication` the matchers consume
 * ({@link medicationRequestToMedication}), or onto the richer
 * {@link MedicationView} the medication cards render
 * ({@link medicationRequestToMedicationView}).
 *
 * Each view field is read by a small accessor over the decoded `fhir-r4`
 * `MedicationRequest` (`dinOf`, `descriptionOf`, `repeatsAvailableOf`, …),
 * exported so a caller can read one slot without building a whole view.
 *
 * Kept behind the `medication-core/fhir` subpath so importing the pure matcher
 * from `medication-core` does not pull in `fhir-r4`'s schemas.
 *
 * @packageDocumentation
 */
export {
  containedMedicationOf,
  descriptionOf,
  dinOf,
  displayNameOf,
  dosageTextOf,
  hasRefill,
  medicationConceptOf,
  medicationReferenceOf,
  medicationRequestsToMedications,
  medicationRequestsToMedicationViews,
  medicationRequestToMedication,
  medicationRequestToMedicationView,
  nextFillDateOf,
  noteOf,
  repeatsAllowedOf,
  repeatsAvailableOf,
  requesterOf,
  rexallStoreUrlOf,
  shoppersStoreUrlOf,
  type MedicationRequestResource,
  type MedicationView,
} from './medication-request.ts'
