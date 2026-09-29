import { type Effect, type ParseResult, Schema } from 'effect'
import { IdentifierAndReference, type ReferenceType } from 'fhir-r4/data-types'
import { localResourceId } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'

/**
 * A person's Patient as the importer of one source keys it: the source system
 * it is adopted under and the id the source gave it — so a renderer for
 * another source can file its results on that same Patient.
 *
 * @remarks
 * Adoption (`fhir-r4/identity`'s `adoptResource`) stores a resource under
 * `localResourceId(system, 'Patient', originalId)` and writes every reference
 * to it as that local id plus the source's own id as `Reference.identifier`;
 * {@link referenceOf} spells the reference the same way, so a result pointed
 * at it reads exactly like one of the source's own resources.
 */
interface SourcePatient {
  /** The source system the Patient is adopted under (a `sid` URI). */
  readonly system: string
  /** The id the source gave the Patient (`Patient/<originalId>` in its own references). */
  readonly originalId: string
}

const decodeReference = Schema.decode(IdentifierAndReference.ReferenceSchema)

/** The id the Patient is stored under once its source's import adopts it. */
const adoptedIdOf = (sourcePatient: SourcePatient): string =>
  localResourceId(sourcePatient.system, 'Patient', sourcePatient.originalId)

/**
 * A reference to the Patient, as adoption rewrites the source's own
 * `Patient/<originalId>`: the adopted id, with the source's id beside it as
 * `Reference.identifier`. Fails with a `ParseError` when `system` is not a
 * URI the `Reference` schema accepts.
 */
const referenceOf = (
  sourcePatient: SourcePatient
): Effect.Effect<ReferenceType, ParseResult.ParseError> =>
  decodeReference({
    reference: `Patient/${adoptedIdOf(sourcePatient)}`,
    identifier: { system: sourcePatient.system, value: sourcePatient.originalId },
  })

/**
 * The resource types an importer files on a patient through `subject` that a
 * renderer retargets: LifeLabs' results and reports, and the DICOM import's
 * study, order and source file.
 */
const SUBJECT_RESOURCE_TYPES = [
  'Observation',
  'DiagnosticReport',
  'ImagingStudy',
  'ServiceRequest',
  'DocumentReference',
] as const satisfies readonly FhirResource['resourceType'][]

type FiledOnSubject = Extract<
  FhirResource,
  { readonly resourceType: (typeof SUBJECT_RESOURCE_TYPES)[number] }
>

const isFiledOnSubject = (resource: FhirResource): resource is FiledOnSubject =>
  (SUBJECT_RESOURCE_TYPES as readonly string[]).includes(resource.resourceType)

/**
 * `resource` filed on `subject` (typically {@link referenceOf} a pharmacy
 * Patient), if it is one of the resources that names its patient as
 * `subject`; any other resource unchanged.
 */
const withSubject =
  (subject: ReferenceType) =>
  (resource: FhirResource): FhirResource =>
    isFiledOnSubject(resource) ? { ...resource, subject } : resource

export { adoptedIdOf, referenceOf, withSubject }
export type { SourcePatient }
