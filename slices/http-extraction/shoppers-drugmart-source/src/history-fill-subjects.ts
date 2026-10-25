import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResource, MedicationDispense } from '@wildflowerhealthio/fhir-r4/resources'
import type { SourceDescriptor } from '@wildflowerhealthio/http-extraction-fundamentals'
import { Array as Arr, Effect, Option } from 'effect'

/**
 * The Shoppers source's `completeFromExtraction`: every history fill filed on
 * the account's one person.
 *
 * @packageDocumentation
 */

type Reference = IdentifierAndReference.ReferenceType

/**
 * A reference to the one Patient `extraction` holds, or `None` when it holds
 * none or several. It carries the Patient's `identifier[0]` (its adopted
 * source id), as adoption spells the references it rewrites.
 */
const solePatientReferenceOf = (extraction: readonly FhirResource[]): Option.Option<Reference> => {
  const patients = Arr.dedupeWith(
    extraction.flatMap((resource) =>
      resource.resourceType === 'Patient' && resource.id !== null
        ? [{ id: resource.id, identifier: resource.identifier[0] ?? null }]
        : []
    ),
    (left, right) => left.id === right.id
  )
  const [patient] = patients
  return patients.length === 1 && patient !== undefined
    ? Option.some({
        ...IdentifierAndReference.referenceTo({ resourceType: 'Patient', id: patient.id }),
        identifier: patient.identifier,
      })
    : Option.none()
}

/** Whether `resource` is a fill that names nobody: a history-feed dispense, as the kind emits it. */
const isFillWithNoSubject = (resource: FhirResource): resource is MedicationDispense.Type =>
  resource.resourceType === 'MedicationDispense' && resource.subject === null

/**
 * Every history fill with no `subject` filed on the one Patient the
 * extraction holds.
 *
 * @remarks
 * The history feed does not say whom a fill was for. An account that manages
 * one person can only have filled it for them. An account that manages
 * several is not supported until one can be tested against a real account:
 * nothing is guessed, its fills keep no `subject`, and the count of those is
 * logged. Every other resource is returned as itself.
 */
const completeShoppersExtraction: SourceDescriptor.ExtractionCompletion<FhirResource> = (
  extraction
) =>
  Effect.gen(function* () {
    const solePatient = solePatientReferenceOf(extraction)
    const fillsWithNoSubjectCount = extraction.filter(isFillWithNoSubject).length
    if (Option.isNone(solePatient) && fillsWithNoSubjectCount > 0) {
      yield* Effect.logInfo(
        `completeShoppersExtraction: left ${fillsWithNoSubjectCount} history fills with no subject (the extraction does not hold exactly one Patient, and an account managing several people is not supported)`
      )
    }

    return (resource: FhirResource): FhirResource =>
      isFillWithNoSubject(resource)
        ? Option.match(solePatient, {
            onNone: () => resource,
            onSome: (subject) => ({ ...resource, subject }),
          })
        : resource
  })

export { completeShoppersExtraction }
