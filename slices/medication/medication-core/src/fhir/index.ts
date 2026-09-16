/**
 * The FHIR R4 adapters for the medication slices: map a decoded
 * `MedicationRequest` onto the core `Medication` the matchers consume
 * ({@link medicationRequestToMedication}), or onto the richer
 * {@link MedicationView} the medication cards render
 * ({@link medicationRequestToMedicationView}).
 *
 * Kept behind the `medication-core/fhir` subpath so importing the pure matcher
 * from `medication-core` does not pull in `fhir-r4`'s schemas.
 *
 * @packageDocumentation
 */
export {
  hasRefill,
  medicationRequestsToMedications,
  medicationRequestsToMedicationViews,
  medicationRequestToMedication,
  medicationRequestToMedicationView,
  type MedicationRequestResource,
  type MedicationView,
} from './medication-request.ts'
