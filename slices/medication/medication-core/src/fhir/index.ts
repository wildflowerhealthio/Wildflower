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
export { descriptionOf } from './description.ts'
export { dinOf } from './din.ts'
export { nextFillDateOf, repeatsAllowedOf, repeatsAvailableOf } from './dispense-request.ts'
export { displayNameOf } from './display-name.ts'
export { dosageTextOf, noteOf, requesterOf } from './free-text.ts'
export {
  containedMedicationOf,
  medicationConceptOf,
  medicationReferenceOf,
} from './medication-slots.ts'
export {
  hasRefill,
  medicationRequestsToMedications,
  medicationRequestsToMedicationViews,
  medicationRequestToMedication,
  medicationRequestToMedicationView,
  type MedicationRequestResource,
  type MedicationView,
} from './medication-view.ts'
export { storeLinkOf, type StoreLink } from './store-link.ts'
