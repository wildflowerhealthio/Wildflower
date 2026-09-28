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
 * {@link medicationRequestToDoseRegimen} reads a request that carries its
 * server `id` ({@link MedicationRequestWithId}) as a {@link DoseRegimen} — its
 * first instruction's dose, per administration or as a daily total, over the
 * period the request was in effect — for a chart to draw as one step of a dose
 * line; {@link medicationRequestsToDoseRegimens} reads a bundle's worth and
 * counts the requests that yield none.
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
  type MedicationRequestWithId,
} from './dose-regimen.ts'
export type { Dose, DoseBasis } from './dosage.ts'
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
