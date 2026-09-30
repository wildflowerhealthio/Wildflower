import type { ReferenceType } from '../data-types/complex/identifier-and-reference.ts'
import type { FhirResource } from './fhir-resource.ts'

/**
 * The resource types that name the patient they are about as `subject`: the
 * results, reports, orders, studies, documents, medication records, care plans
 * and goals an import files on a Patient.
 */
const SUBJECT_RESOURCE_TYPES = [
  'CarePlan',
  'DiagnosticReport',
  'DocumentReference',
  'Goal',
  'ImagingStudy',
  'MedicationDispense',
  'MedicationRequest',
  'Observation',
  'ServiceRequest',
] as const satisfies readonly FhirResource['resourceType'][]

/** A resource of one of the {@link SUBJECT_RESOURCE_TYPES}. */
type FiledOnSubject = Extract<
  FhirResource,
  { readonly resourceType: (typeof SUBJECT_RESOURCE_TYPES)[number] }
>

const isFiledOnSubject = (resource: FhirResource): resource is FiledOnSubject =>
  (SUBJECT_RESOURCE_TYPES as readonly string[]).includes(resource.resourceType)

/**
 * `resource` filed on `subject` instead of the patient it names, if its type
 * names one as `subject`; any other resource (a `Patient`, a `Practitioner`, a
 * `Binary`) unchanged.
 *
 * @remarks
 * For resources one import made that belong on a Patient another import
 * made — a lab result or imaging study filed on the person's pharmacy Patient
 * (`fhir-r4/identity`'s `adoptedReferenceOf`).
 */
const withSubject =
  (subject: ReferenceType) =>
  (resource: FhirResource): FhirResource =>
    isFiledOnSubject(resource) ? { ...resource, subject } : resource

export { SUBJECT_RESOURCE_TYPES, withSubject }
