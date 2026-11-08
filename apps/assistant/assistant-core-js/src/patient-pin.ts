import type { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Either, Match, Option, Schema } from 'effect'

import * as SearchParam from './search-param.ts'

/**
 * How a chat about one patient keeps its reads to that patient: the search
 * parameter that pins each resource type to them, the parameters a search
 * may not set, and the check every record read back passes.
 *
 * @remarks
 * A namespace module: `PatientPin.Type`, `PatientPin.of`,
 * `PatientPin.pinnedParamsOf`, `PatientPin.isAboutAnotherPatient`. The
 * table follows FHIR R4's Patient compartment and each type's search
 * parameters. A type in neither table is not offered in a chat about one
 * patient: nothing here knows how to keep it to them.
 *
 * @packageDocumentation
 */

/** How a resource type is kept to one patient. */
type Type =
  /** `Patient` itself: searched by `_id`. */
  | { readonly kind: 'the-patient' }
  /** A record about a patient, searched by the parameter that references them. */
  | { readonly kind: 'by-reference'; readonly parameter: 'patient' | 'subject' }
  /** A record about no one patient (a practitioner, an organization, a medication). */
  | { readonly kind: 'not-patient-specific' }

/** The R4 types whose search parameter `patient` references the patient they are about. */
const BY_PATIENT_PARAMETER: ReadonlySet<ResourceType.Type> = new Set<ResourceType.Type>([
  'Account',
  'AllergyIntolerance',
  'Appointment',
  'AppointmentResponse',
  'AuditEvent',
  'Basic',
  'BodyStructure',
  'CarePlan',
  'CareTeam',
  'ChargeItem',
  'Claim',
  'ClaimResponse',
  'ClinicalImpression',
  'Communication',
  'CommunicationRequest',
  'Composition',
  'Condition',
  'Consent',
  'Contract',
  'Coverage',
  'CoverageEligibilityRequest',
  'CoverageEligibilityResponse',
  'DetectedIssue',
  'Device',
  'DeviceRequest',
  'DeviceUseStatement',
  'DiagnosticReport',
  'DocumentManifest',
  'DocumentReference',
  'Encounter',
  'EnrollmentRequest',
  'EpisodeOfCare',
  'ExplanationOfBenefit',
  'FamilyMemberHistory',
  'Flag',
  'Goal',
  'GuidanceResponse',
  'ImagingStudy',
  'Immunization',
  'ImmunizationEvaluation',
  'ImmunizationRecommendation',
  'Invoice',
  'List',
  'MeasureReport',
  'Media',
  'MedicationAdministration',
  'MedicationDispense',
  'MedicationRequest',
  'MedicationStatement',
  'MolecularSequence',
  'NutritionOrder',
  'Observation',
  'Person',
  'Procedure',
  'Provenance',
  'QuestionnaireResponse',
  'RelatedPerson',
  'RequestGroup',
  'ResearchSubject',
  'RiskAssessment',
  'ServiceRequest',
  'Specimen',
  'SupplyDelivery',
  'Task',
  'VisionPrescription',
])

/** The R4 types that reference the patient they are about only through `subject`. */
const BY_SUBJECT_PARAMETER: ReadonlySet<ResourceType.Type> = new Set<ResourceType.Type>([
  'AdverseEvent',
  'SupplyRequest',
])

/** The R4 types about no one patient, read as they are in a chat about one. */
const NOT_PATIENT_SPECIFIC: ReadonlySet<ResourceType.Type> = new Set<ResourceType.Type>([
  'ActivityDefinition',
  'CodeSystem',
  'ConceptMap',
  'DeviceDefinition',
  'Endpoint',
  'HealthcareService',
  'Library',
  'Location',
  'Medication',
  'MedicationKnowledge',
  'ObservationDefinition',
  'Organization',
  'OrganizationAffiliation',
  'PlanDefinition',
  'Practitioner',
  'PractitionerRole',
  'Questionnaire',
  'SpecimenDefinition',
  'Substance',
  'ValueSet',
])

/** How `resourceType` is kept to one patient; `None` when nothing here knows how. */
const of = (resourceType: ResourceType.Type): Option.Option<Type> => {
  if (resourceType === 'Patient') return Option.some({ kind: 'the-patient' })
  if (BY_PATIENT_PARAMETER.has(resourceType)) {
    return Option.some({ kind: 'by-reference', parameter: 'patient' })
  }
  if (BY_SUBJECT_PARAMETER.has(resourceType)) {
    return Option.some({ kind: 'by-reference', parameter: 'subject' })
  }
  if (NOT_PATIENT_SPECIFIC.has(resourceType)) return Option.some({ kind: 'not-patient-specific' })
  return Option.none()
}

/** The parameters a pinned search may not set, since they name whose records to read. */
const patientNamingParametersOf = (pin: Type): readonly string[] =>
  Match.value(pin).pipe(
    Match.when({ kind: 'the-patient' }, () => ['_id']),
    Match.when({ kind: 'by-reference' }, () => ['patient', 'subject']),
    Match.when({ kind: 'not-patient-specific' }, () => []),
    Match.exhaustive
  )

/**
 * `params` with the parameter that keeps `pin`'s type to `patientId` added,
 * or, on the left, the first parameter the agent set that would choose whose
 * records to read.
 */
const pinnedParamsOf = (
  pin: Type,
  patientId: string,
  params: readonly SearchParam.Type[]
): Either.Either<readonly SearchParam.Type[], SearchParam.Type> => {
  const forbidden = patientNamingParametersOf(pin)
  return Array.findFirst(params, ({ name }) =>
    forbidden.includes(SearchParam.baseNameOf(name))
  ).pipe(
    Option.match({
      onSome: Either.left,
      onNone: () =>
        Either.right(
          Match.value(pin).pipe(
            Match.when({ kind: 'the-patient' }, () => [
              ...params,
              { name: '_id', value: patientId },
            ]),
            Match.when({ kind: 'by-reference' }, ({ parameter }) => [
              ...params,
              {
                name: parameter,
                value: parameter === 'patient' ? patientId : `Patient/${patientId}`,
              },
            ]),
            Match.when({ kind: 'not-patient-specific' }, () => params),
            Match.exhaustive
          )
        ),
    })
  )
}

/** A reference, as far as the patient check reads it. */
const PatientCheckReference = Schema.Struct({ reference: Schema.optional(Schema.String) })

/** A record, as far as the patient check reads it: its type, its id, and whom it is about. */
const PatientCheckedRecord = Schema.Struct({
  resourceType: Schema.String,
  id: Schema.optional(Schema.String),
  subject: Schema.optional(PatientCheckReference),
  patient: Schema.optional(PatientCheckReference),
})

/** The id of the patient `reference` points at, if it points at a `Patient`. */
const patientIdOf = (reference: string): Option.Option<string> =>
  Option.fromNullable(/(?:^|\/)Patient\/([^/]+)(?:\/_history\/[^/]+)?$/u.exec(reference)?.[1])

/**
 * Whether `record` is about a patient other than `patientId`: a `Patient`
 * with another id, or a record whose `subject` or `patient` references
 * another `Patient`. Something that is not a record at all counts as one.
 */
const isAboutAnotherPatient = (record: unknown, patientId: string): boolean =>
  Schema.decodeUnknownOption(PatientCheckedRecord)(record).pipe(
    Option.match({
      onNone: () => true,
      onSome: ({ resourceType, id, subject, patient }) =>
        resourceType === 'Patient'
          ? id !== patientId
          : [subject, patient].some((reference) =>
              Option.fromNullable(reference?.reference).pipe(
                Option.flatMap(patientIdOf),
                Option.exists((referencedId) => referencedId !== patientId)
              )
            ),
    })
  )

export { isAboutAnotherPatient, of, pinnedParamsOf }
export type { Type }
