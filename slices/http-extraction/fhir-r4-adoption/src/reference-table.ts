/**
 * The per-type reference table: every `Reference` a resource holds, reached
 * by one walk, which detaching a server's record and adopting a detached one
 * both rewrite through.
 *
 * @packageDocumentation
 */
import type { IdentifierType, ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'
import type {
  Binary,
  CarePlan,
  DiagnosticReport,
  DocumentReference,
  FhirResource,
  Goal,
  ImagingStudy,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
  PlanDefinition,
  PlanDefinitionAction,
  Practitioner,
  Procedure,
  ServiceRequest,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Match } from 'effect'

/** Apply `rewrite` to a nullable reference slot. */
const rewriteNullable = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  reference: ReferenceType | null
): ReferenceType | null => (reference === null ? null : rewrite(reference))

/** An `Annotation`'s reference-bearing half, named structurally. */
interface AnnotationAuthor {
  readonly authorReference: ReferenceType | null
}

/**
 * Rewrite the `authorReference` of every annotation in a list — a resource's
 * `note`, or `CarePlan.activity.progress`.
 *
 * @remarks
 * `Annotation.author[x]` is a `Reference` when it is not the `authorString`
 * variant, so it dangles like any other if left holding the source's id. It sits
 * one level down inside an array, which is why a hand audit missed it and the
 * schema-derived coverage property in `adopt-resource.test.ts` did not.
 */
const rewriteAnnotationAuthors = <TAnnotation extends AnnotationAuthor>(
  rewrite: (reference: ReferenceType) => ReferenceType,
  annotations: readonly TAnnotation[]
): TAnnotation[] =>
  annotations.map((annotation) => ({
    ...annotation,
    authorReference: rewriteNullable(rewrite, annotation.authorReference),
  }))

const mapBinaryReferences = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  binary: typeof Binary.Schema.Type
): typeof Binary.Schema.Type => ({
  ...binary,
  securityContext: rewriteNullable(rewrite, binary.securityContext),
})

const mapPatientReferences = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  patient: typeof Patient.Schema.Type
): typeof Patient.Schema.Type => ({
  ...patient,
  generalPractitioner: patient.generalPractitioner.map(rewrite),
  managingOrganization: rewriteNullable(rewrite, patient.managingOrganization),
  link: patient.link.map((link) => ({ ...link, other: rewrite(link.other) })),
  contact: patient.contact.map((contact) => ({
    ...contact,
    organization: rewriteNullable(rewrite, contact.organization),
  })),
})

const mapObservationReferences = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  observation: typeof Observation.Schema.Type
): typeof Observation.Schema.Type => ({
  ...observation,
  note: rewriteAnnotationAuthors(rewrite, observation.note),
  subject: rewriteNullable(rewrite, observation.subject),
  encounter: rewriteNullable(rewrite, observation.encounter),
  device: rewriteNullable(rewrite, observation.device),
  specimen: rewriteNullable(rewrite, observation.specimen),
  basedOn: observation.basedOn.map(rewrite),
  derivedFrom: observation.derivedFrom.map(rewrite),
  focus: observation.focus.map(rewrite),
  hasMember: observation.hasMember.map(rewrite),
  partOf: observation.partOf.map(rewrite),
  performer: observation.performer.map(rewrite),
})

const mapMedicationRequestReferences = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  request: typeof MedicationRequest.Schema.Type
): typeof MedicationRequest.Schema.Type => ({
  ...request,
  note: rewriteAnnotationAuthors(rewrite, request.note),
  subject: rewrite(request.subject),
  encounter: rewriteNullable(rewrite, request.encounter),
  requester: rewriteNullable(rewrite, request.requester),
  performer: rewriteNullable(rewrite, request.performer),
  recorder: rewriteNullable(rewrite, request.recorder),
  priorPrescription: rewriteNullable(rewrite, request.priorPrescription),
  reportedReference: rewriteNullable(rewrite, request.reportedReference),
  medicationReference: rewriteNullable(rewrite, request.medicationReference),
  supportingInformation: request.supportingInformation.map(rewrite),
  reasonReference: request.reasonReference.map(rewrite),
  basedOn: request.basedOn.map(rewrite),
  insurance: request.insurance.map(rewrite),
  detectedIssue: request.detectedIssue.map(rewrite),
  eventHistory: request.eventHistory.map(rewrite),
  dispenseRequest:
    request.dispenseRequest === null
      ? null
      : {
          ...request.dispenseRequest,
          performer: rewriteNullable(rewrite, request.dispenseRequest.performer),
        },
})

const mapMedicationDispenseReferences = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  dispense: typeof MedicationDispense.Schema.Type
): typeof MedicationDispense.Schema.Type => ({
  ...dispense,
  note: rewriteAnnotationAuthors(rewrite, dispense.note),
  subject: rewriteNullable(rewrite, dispense.subject),
  context: rewriteNullable(rewrite, dispense.context),
  location: rewriteNullable(rewrite, dispense.location),
  destination: rewriteNullable(rewrite, dispense.destination),
  statusReasonReference: rewriteNullable(rewrite, dispense.statusReasonReference),
  medicationReference: rewriteNullable(rewrite, dispense.medicationReference),
  partOf: dispense.partOf.map(rewrite),
  supportingInformation: dispense.supportingInformation.map(rewrite),
  authorizingPrescription: dispense.authorizingPrescription.map(rewrite),
  receiver: dispense.receiver.map(rewrite),
  detectedIssue: dispense.detectedIssue.map(rewrite),
  eventHistory: dispense.eventHistory.map(rewrite),
  performer: dispense.performer.map((performer) => ({
    ...performer,
    actor: rewrite(performer.actor),
  })),
  substitution:
    dispense.substitution === null
      ? null
      : {
          ...dispense.substitution,
          responsibleParty: dispense.substitution.responsibleParty.map(rewrite),
        },
})

const mapDocumentReferenceReferences = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  document: typeof DocumentReference.Schema.Type
): typeof DocumentReference.Schema.Type => ({
  ...document,
  subject: rewriteNullable(rewrite, document.subject),
  authenticator: rewriteNullable(rewrite, document.authenticator),
  custodian: rewriteNullable(rewrite, document.custodian),
  author: document.author.map(rewrite),
  relatesTo: document.relatesTo.map((relatesTo) => ({
    ...relatesTo,
    target: rewrite(relatesTo.target),
  })),
  context:
    document.context === null
      ? null
      : {
          ...document.context,
          sourcePatientInfo: rewriteNullable(rewrite, document.context.sourcePatientInfo),
          encounter: document.context.encounter.map(rewrite),
          related: document.context.related.map(rewrite),
        },
})

const mapDiagnosticReportReferences = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  report: typeof DiagnosticReport.Schema.Type
): typeof DiagnosticReport.Schema.Type => ({
  ...report,
  subject: rewriteNullable(rewrite, report.subject),
  encounter: rewriteNullable(rewrite, report.encounter),
  basedOn: report.basedOn.map(rewrite),
  performer: report.performer.map(rewrite),
  resultsInterpreter: report.resultsInterpreter.map(rewrite),
  specimen: report.specimen.map(rewrite),
  result: report.result.map(rewrite),
  imagingStudy: report.imagingStudy.map(rewrite),
  media: report.media.map((media) => ({ ...media, link: rewrite(media.link) })),
})

const mapPractitionerReferences = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  practitioner: typeof Practitioner.Schema.Type
): typeof Practitioner.Schema.Type => ({
  ...practitioner,
  qualification: practitioner.qualification.map((qualification) => ({
    ...qualification,
    issuer: rewriteNullable(rewrite, qualification.issuer),
  })),
})

const mapServiceRequestReferences = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  request: typeof ServiceRequest.Schema.Type
): typeof ServiceRequest.Schema.Type => ({
  ...request,
  subject: rewrite(request.subject),
  encounter: rewriteNullable(rewrite, request.encounter),
  requester: rewriteNullable(rewrite, request.requester),
  basedOn: request.basedOn.map(rewrite),
  replaces: request.replaces.map(rewrite),
  performer: request.performer.map(rewrite),
  locationReference: request.locationReference.map(rewrite),
  reasonReference: request.reasonReference.map(rewrite),
  insurance: request.insurance.map(rewrite),
  supportingInfo: request.supportingInfo.map(rewrite),
  relevantHistory: request.relevantHistory.map(rewrite),
})

const mapImagingStudyReferences = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  study: typeof ImagingStudy.Schema.Type
): typeof ImagingStudy.Schema.Type => ({
  ...study,
  subject: rewrite(study.subject),
  encounter: rewriteNullable(rewrite, study.encounter),
  referrer: rewriteNullable(rewrite, study.referrer),
  procedureReference: rewriteNullable(rewrite, study.procedureReference),
  location: rewriteNullable(rewrite, study.location),
  basedOn: study.basedOn.map(rewrite),
  interpreter: study.interpreter.map(rewrite),
  endpoint: study.endpoint.map(rewrite),
  reasonReference: study.reasonReference.map(rewrite),
  series: study.series.map((s) => ({
    ...s,
    endpoint: s.endpoint.map(rewrite),
    specimen: s.specimen.map(rewrite),
    performer: s.performer.map((p) => ({ ...p, actor: rewrite(p.actor) })),
  })),
})

const mapCarePlanReferences = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  plan: typeof CarePlan.Schema.Type
): typeof CarePlan.Schema.Type => ({
  ...plan,
  note: rewriteAnnotationAuthors(rewrite, plan.note),
  subject: rewrite(plan.subject),
  encounter: rewriteNullable(rewrite, plan.encounter),
  author: rewriteNullable(rewrite, plan.author),
  basedOn: plan.basedOn.map(rewrite),
  replaces: plan.replaces.map(rewrite),
  partOf: plan.partOf.map(rewrite),
  contributor: plan.contributor.map(rewrite),
  careTeam: plan.careTeam.map(rewrite),
  addresses: plan.addresses.map(rewrite),
  supportingInfo: plan.supportingInfo.map(rewrite),
  goal: plan.goal.map(rewrite),
  activity: plan.activity.map((activity) => ({
    ...activity,
    outcomeReference: activity.outcomeReference.map(rewrite),
    progress: rewriteAnnotationAuthors(rewrite, activity.progress),
    reference: rewriteNullable(rewrite, activity.reference),
    detail:
      activity.detail === null
        ? null
        : {
            ...activity.detail,
            reasonReference: activity.detail.reasonReference.map(rewrite),
            goal: activity.detail.goal.map(rewrite),
            location: rewriteNullable(rewrite, activity.detail.location),
            performer: activity.detail.performer.map(rewrite),
            productReference: rewriteNullable(rewrite, activity.detail.productReference),
          },
  })),
})

const mapGoalReferences = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  goal: typeof Goal.Schema.Type
): typeof Goal.Schema.Type => ({
  ...goal,
  note: rewriteAnnotationAuthors(rewrite, goal.note),
  subject: rewrite(goal.subject),
  expressedBy: rewriteNullable(rewrite, goal.expressedBy),
  addresses: goal.addresses.map(rewrite),
  outcomeReference: goal.outcomeReference.map(rewrite),
})

/** Rewrite the `subjectReference` of every action in a list, and of every action nested in one. */
const rewriteActionSubjects = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  actions: readonly PlanDefinitionAction.Type[]
): PlanDefinitionAction.Type[] =>
  actions.map((action) => ({
    ...action,
    subjectReference: rewriteNullable(rewrite, action.subjectReference),
    action: rewriteActionSubjects(rewrite, action.action),
  }))

const mapPlanDefinitionReferences = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  plan: typeof PlanDefinition.Schema.Type
): typeof PlanDefinition.Schema.Type => ({
  ...plan,
  subjectReference: rewriteNullable(rewrite, plan.subjectReference),
  action: rewriteActionSubjects(rewrite, plan.action),
})

const mapProcedureReferences = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  procedure: typeof Procedure.Schema.Type
): typeof Procedure.Schema.Type => ({
  ...procedure,
  note: rewriteAnnotationAuthors(rewrite, procedure.note),
  subject: rewrite(procedure.subject),
  encounter: rewriteNullable(rewrite, procedure.encounter),
  recorder: rewriteNullable(rewrite, procedure.recorder),
  asserter: rewriteNullable(rewrite, procedure.asserter),
  location: rewriteNullable(rewrite, procedure.location),
  basedOn: procedure.basedOn.map(rewrite),
  partOf: procedure.partOf.map(rewrite),
  performer: procedure.performer.map((performer) => ({
    ...performer,
    actor: rewrite(performer.actor),
    onBehalfOf: rewriteNullable(rewrite, performer.onBehalfOf),
  })),
  reasonReference: procedure.reasonReference.map(rewrite),
  report: procedure.report.map(rewrite),
  complicationDetail: procedure.complicationDetail.map(rewrite),
  focalDevice: procedure.focalDevice.map((device) => ({
    ...device,
    manipulated: rewrite(device.manipulated),
  })),
  usedReference: procedure.usedReference.map(rewrite),
})

/**
 * `resource` with `rewrite` applied to every `Reference` it holds, and nothing
 * else changed.
 *
 * @remarks
 * The per-type reference table, the one place a resource's references are
 * walked: `DetachedResource.fromServerRecord` and `adopt` both rewrite
 * through it.
 * `Match.exhaustive` over the closed union rather than a `switch`: a resource
 * type added to `FhirResource` without a row here is a compile error, not a
 * resource whose references silently keep the source's ids.
 *
 * **Every branch maps a variant to itself, by construction and not by the type
 * system.** TypeScript cannot correlate the discriminant matched here with the
 * branch taken, so a branch returning a different variant would compile and
 * would silently widen what a caller gets back. Don't write one.
 */
const mapReferences =
  (rewrite: (reference: ReferenceType) => ReferenceType) =>
  (resource: FhirResource): FhirResource =>
    Match.value(resource).pipe(
      Match.discriminator('resourceType')('Binary', (binary) =>
        mapBinaryReferences(rewrite, binary)
      ),
      Match.discriminator('resourceType')('Patient', (patient) =>
        mapPatientReferences(rewrite, patient)
      ),
      Match.discriminator('resourceType')('Observation', (observation) =>
        mapObservationReferences(rewrite, observation)
      ),
      Match.discriminator('resourceType')('MedicationRequest', (request) =>
        mapMedicationRequestReferences(rewrite, request)
      ),
      Match.discriminator('resourceType')('MedicationDispense', (dispense) =>
        mapMedicationDispenseReferences(rewrite, dispense)
      ),
      Match.discriminator('resourceType')('DocumentReference', (document) =>
        mapDocumentReferenceReferences(rewrite, document)
      ),
      Match.discriminator('resourceType')('DiagnosticReport', (report) =>
        mapDiagnosticReportReferences(rewrite, report)
      ),
      Match.discriminator('resourceType')('Practitioner', (practitioner) =>
        mapPractitionerReferences(rewrite, practitioner)
      ),
      Match.discriminator('resourceType')('ServiceRequest', (request) =>
        mapServiceRequestReferences(rewrite, request)
      ),
      Match.discriminator('resourceType')('ImagingStudy', (study) =>
        mapImagingStudyReferences(rewrite, study)
      ),
      Match.discriminator('resourceType')('CarePlan', (plan) =>
        mapCarePlanReferences(rewrite, plan)
      ),
      Match.discriminator('resourceType')('Goal', (goal) => mapGoalReferences(rewrite, goal)),
      Match.discriminator('resourceType')('PlanDefinition', (plan) =>
        mapPlanDefinitionReferences(rewrite, plan)
      ),
      Match.discriminator('resourceType')('Procedure', (procedure) =>
        mapProcedureReferences(rewrite, procedure)
      ),
      Match.exhaustive
    )

/** The `Identifier` `{ system, value }`, every other element empty. */
const identifierOf = (systemUrl: URL, value: string): IdentifierType => ({
  id: null,
  extension: [],
  assigner: null,
  period: null,
  system: systemUrl,
  type: null,
  use: null,
  value,
})

export { identifierOf, mapReferences }
