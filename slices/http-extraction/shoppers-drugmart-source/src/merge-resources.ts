import type {
  CodeableConcept,
  IdentifierAndReference,
} from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResourceWithId, MedicationDispense } from '@wildflowerhealthio/fhir-r4/resources'
import type { SourceDescriptor } from '@wildflowerhealthio/http-extraction-fundamentals'

/**
 * The Shoppers source's `mergeResources`: one dispense seen in both the
 * prescription-status feed and the prescription-history feed, as one
 * `MedicationDispense`.
 *
 * @packageDocumentation
 */

type Reference = IdentifierAndReference.ReferenceType
type Concept = typeof CodeableConcept.Schema.Type

/**
 * Whether `dispense` is the history feed's copy: its `subject` has no literal
 * `reference`.
 *
 * @remarks
 * The two copies are told apart by this marker because it is the difference
 * the merge is about: the history feed knows only the account, by an
 * identifier-only reference, and the status feed knows the person, by a
 * literal `Patient/<patientId>` reference. Adoption rewrites a literal
 * reference and leaves an identifier-only one as it is, so the marker
 * survives it. Reading it off the resource, rather than asking which kind
 * emitted it, keeps the merge a function of the two resources alone, with the
 * same answer in either arrival order.
 */
const isHistoryCopy = (dispense: MedicationDispense.Type): boolean =>
  dispense.subject?.reference == null

/**
 * The status copy's store link, labelled with the history copy's store name
 * when both name the same store. The status feed knows the store only by
 * number; the history feed names it.
 */
const locationOf = (
  statusLocation: Reference | null,
  historyLocation: Reference | null
): Reference | null => {
  if (statusLocation === null) return historyLocation
  if (historyLocation === null || historyLocation.reference !== statusLocation.reference) {
    return statusLocation
  }
  return { ...statusLocation, display: historyLocation.display ?? statusLocation.display }
}

const hasCoding = (concept: Concept | null): boolean =>
  concept !== null && concept.coding.length > 0

/** The status copy's medication, unless only the history copy carries a DIN coding. */
const medicationOf = (
  statusMedication: Concept | null,
  historyMedication: Concept | null
): Concept | null =>
  !hasCoding(statusMedication) && hasCoding(historyMedication)
    ? historyMedication
    : statusMedication

/**
 * One dispense from its two copies: the status copy's, which names the person
 * (`subject`), states the dispense's own `status`, and links the request and
 * store (`authorizingPrescription`, `location.reference`), with what only the
 * history copy has: the store's name and, when the status copy has none, the
 * DIN coding.
 */
const mergeDispenseCopies = <TDispense extends MedicationDispense.Type>(
  statusCopy: TDispense,
  historyCopy: MedicationDispense.Type
): TDispense => ({
  ...statusCopy,
  location: locationOf(statusCopy.location, historyCopy.location),
  medicationCodeableConcept: medicationOf(
    statusCopy.medicationCodeableConcept,
    historyCopy.medicationCodeableConcept
  ),
})

/**
 * Two Shoppers resources under one id, as the one to write. A dispense with
 * one copy from each feed merges through {@link mergeDispenseCopies}, in
 * either order. Anything else keeps the later copy, as the store would: two
 * copies from one feed, and every other resource type.
 */
const mergeShoppersResources: SourceDescriptor.ResourceMerge<FhirResourceWithId> = (
  earlier,
  later
) => {
  if (
    earlier.resourceType !== 'MedicationDispense' ||
    later.resourceType !== 'MedicationDispense'
  ) {
    return later
  }
  const earlierIsHistoryCopy = isHistoryCopy(earlier)
  if (earlierIsHistoryCopy === isHistoryCopy(later)) return later
  return earlierIsHistoryCopy
    ? mergeDispenseCopies(later, earlier)
    : mergeDispenseCopies(earlier, later)
}

export { mergeShoppersResources }
