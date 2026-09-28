/**
 * The FHIR R4 adapters for the medication slices: map a decoded
 * `MedicationRequest` that carries its server `id`
 * ({@link MedicationRequestWithId}) onto the core `Medication` the matchers
 * consume ({@link medicationRequestToMedication}), or onto the richer
 * {@link MedicationView} the medication cards render
 * ({@link medicationRequestToMedicationView}); the request's `id` is the
 * medication's `id`.
 *
 * Each view field is read by a small accessor over the decoded `fhir-r4`
 * `MedicationRequest` (`dinOf`, `descriptionOf`, `repeatsAvailableOf`, …),
 * exported so a caller can read one slot without building a whole view.
 *
 * {@link medicationRequestToDoseRegimen} reads the same request as a
 * {@link DoseRegimen} — its first instruction's dose, per administration or as
 * a daily total, or, when it states none, its dispensed supply amortized into
 * a daily dose ({@link DoseDerivation}), over the period the request was in
 * effect — for a chart to draw as one step of a dose line;
 * {@link medicationRequestsToDoseRegimens} reads a bundle's worth and counts
 * the requests that yield none.
 *
 * Kept behind the `medication-core/fhir` subpath so importing the pure matcher
 * from `medication-core` does not pull in `fhir-r4`'s schemas.
 *
 * @packageDocumentation
 */
export { descriptionOf } from './description.ts'
export { dinOf } from './din.ts'
export {
  medicationRequestsToDoseRegimens,
  medicationRequestToDoseRegimen,
  type DoseRegimen,
  type DoseRegimenBatch,
} from './dose-regimen.ts'
export type { Dose, DoseBasis, DoseDerivation } from './dosage.ts'
export { nextFillDateOf, repeatsAllowedOf, repeatsAvailableOf } from './dispense-request.ts'
export { displayNameOf } from './display-name.ts'
export { dosageTextOf, noteOf, requesterOf } from './free-text.ts'
export {
  containedMedicationOf,
  medicationConceptOf,
  medicationReferenceOf,
} from './medication-slots.ts'
export type { MedicationRequestWithId } from './medication-request-with-id.ts'
export {
  hasRefill,
  medicationRequestsToMedications,
  medicationRequestsToMedicationViews,
  medicationRequestToMedication,
  medicationRequestToMedicationView,
  type MedicationView,
} from './medication-view.ts'
export { storeLinkOf, type StoreLink } from './store-link.ts'
