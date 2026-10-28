import {
  IdentifierAndReference,
  type IdentifierType,
  type ReferenceType,
  type WithMandatoryId,
} from '@wildflowerhealthio/fhir-r4/data-types'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import type {
  Binary,
  CarePlan,
  DiagnosticReport,
  DocumentReference,
  FhirResource,
  FhirResourceWithId,
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

import * as DecodedId from './decoded-id.ts'

/**
 * The source system a batch of resources was imported from.
 *
 * @remarks
 * `system` is both the hash domain (the first component of
 * {@link localResourceId}) and the `Identifier.system` written onto every
 * adopted resource, so it must be an absolute URI that `new URL` accepts. For a
 * FHIR source it is the server's configured root; for a scraper it is a
 * Wildflower-minted `sid` URI naming the portal.
 *
 * `baseUrl` is the prefix a source uses when it spells its *own* references
 * absolutely. When set, a reference starting `${baseUrl}/` is stripped back to
 * the relative form before the rewrite rule runs, so `https://host/baseR4/Patient/1`
 * and `Patient/1` adopt to the same target. Leave it unset for a source whose
 * references are always relative.
 */
interface SourceIdentity {
  /** Absolute URI naming the source system; the `Identifier.system` and hash domain. */
  readonly system: string
  /** When set, absolute references starting `${baseUrl}/` are treated as relative. */
  readonly baseUrl?: string
}

/**
 * FHIR R4's relative-reference grammar: a resource-type token, `/`, and a
 * logical id.
 *
 * @remarks
 * The only shape a rewrite accepts. Everything else is left verbatim — a
 * `#fragment` contained reference, a `urn:uuid:`, a foreign absolute URL, a
 * versioned `Type/id/_history/v`, and any id carrying a character outside the
 * spec's set (a space, a slash) all fail this and pass through untouched.
 */
const RELATIVE_REFERENCE = /^([A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})$/

/**
 * One source's identity with the parts that cost something to compute worked out
 * once, at the top of {@link adoptResource}.
 *
 * @remarks
 * `new URL` is the most expensive thing in this file, and a page of 250
 * `Observation`s carries a few thousand references — so it is paid once per
 * adopted resource rather than once per rewritten reference.
 */
interface PreparedSource {
  readonly source: SourceIdentity
  /**
   * `source.system` parsed once, and **treated as immutable by convention** —
   * this one instance is written into every `Identifier.system` the adoption
   * produces, so they alias rather than being the independent copies a per-call
   * `new URL` gave. Clone before mutating.
   *
   * A `system` that is not absolute throws a `TypeError` here. That reaches the
   * caller as a defect rather than the typed `ParseError` the wrapped `parse`
   * advertises, deliberately: it means the source is misconfigured, not that
   * a response was bad. {@link SourceIdentity} states the requirement.
   */
  readonly systemUrl: URL
  /** The `${baseUrl}/` prefix an absolute self-reference is stripped of, if any. */
  readonly absolutePrefix: string | null
}

/** Work out a source's derived parts once, for one pass of {@link adoptResource}. */
const prepare = (source: SourceIdentity): PreparedSource => ({
  source,
  systemUrl: new URL(source.system),
  absolutePrefix: source.baseUrl === undefined ? null : `${source.baseUrl}/`,
})

/** A fully-populated decoded `Identifier` carrying the source's own id for a resource. */
const sourceIdentifier = (prepared: PreparedSource, value: string): IdentifierType => ({
  id: null,
  extension: [],
  assigner: null,
  period: null,
  system: prepared.systemUrl,
  type: null,
  use: null,
  value,
})

/**
 * `own` with the source identifier `decodedId` records prepended: the
 * source's id for a `Decoded` id, nothing for one `GeneratedFromContent`.
 */
const identifiersAdopting = (
  prepared: PreparedSource,
  decodedId: DecodedId.Type,
  own: readonly IdentifierType[]
): readonly IdentifierType[] =>
  DecodedId.$match(decodedId, {
    Decoded: ({ value }) => [sourceIdentifier(prepared, value), ...own],
    GeneratedFromContent: () => own,
  })

/**
 * Rewrite one `Reference` so it names the local id of the resource it points at.
 *
 * @remarks
 * Rewrites apply to **any** resource-type token, not only the types this
 * package stores. The derivation is deterministic, so a `Practitioner/x` link
 * resolves retroactively if that type is ever imported from the same source, and
 * dangles exactly as it did before if it never is — with the original id still
 * readable from the `Reference.identifier` this writes.
 *
 * A pre-existing `Reference.identifier` is kept. The slot is 0..1 and some
 * sources already fill it with their own vendor identifier; the original
 * `Type/id` stays recoverable by resolving the rewritten reference and reading
 * the target's `identifier[0]`.
 */
const rewriteReference =
  (prepared: PreparedSource) =>
  (reference: ReferenceType): ReferenceType => {
    if (reference.reference === null) {
      return reference
    }
    const { absolutePrefix } = prepared
    const target =
      absolutePrefix !== null && reference.reference.startsWith(absolutePrefix)
        ? reference.reference.slice(absolutePrefix.length)
        : reference.reference
    const match = RELATIVE_REFERENCE.exec(target)
    if (match === null) {
      return reference
    }
    const [, resourceType, originalId] = match
    if (resourceType === undefined || originalId === undefined) {
      return reference
    }
    return {
      ...reference,
      reference: `${resourceType}/${localResourceId(prepared.source.system, resourceType, originalId)}`,
      identifier: reference.identifier ?? sourceIdentifier(prepared, originalId),
    }
  }

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

const adoptBinary = (
  prepared: PreparedSource,
  decodedId: DecodedId.Type,
  binary: typeof Binary.Schema.Type
): WithMandatoryId<typeof Binary.Schema.Type> => {
  const rewrite = rewriteReference(prepared)
  return {
    ...binary,
    id: localResourceId(prepared.source.system, 'Binary', decodedId.value),
    securityContext: rewriteNullable(rewrite, binary.securityContext),
  }
}

const adoptPatient = (
  prepared: PreparedSource,
  decodedId: DecodedId.Type,
  patient: typeof Patient.Schema.Type
): WithMandatoryId<typeof Patient.Schema.Type> => {
  const rewrite = rewriteReference(prepared)
  return {
    ...patient,
    id: localResourceId(prepared.source.system, 'Patient', decodedId.value),
    identifier: identifiersAdopting(prepared, decodedId, patient.identifier),
    generalPractitioner: patient.generalPractitioner.map(rewrite),
    managingOrganization: rewriteNullable(rewrite, patient.managingOrganization),
    link: patient.link.map((link) => ({ ...link, other: rewrite(link.other) })),
    contact: patient.contact.map((contact) => ({
      ...contact,
      organization: rewriteNullable(rewrite, contact.organization),
    })),
  }
}

const adoptObservation = (
  prepared: PreparedSource,
  decodedId: DecodedId.Type,
  observation: typeof Observation.Schema.Type
): WithMandatoryId<typeof Observation.Schema.Type> => {
  const rewrite = rewriteReference(prepared)
  return {
    ...observation,
    id: localResourceId(prepared.source.system, 'Observation', decodedId.value),
    identifier: identifiersAdopting(prepared, decodedId, observation.identifier),
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
  }
}

const adoptMedicationRequest = (
  prepared: PreparedSource,
  decodedId: DecodedId.Type,
  request: typeof MedicationRequest.Schema.Type
): WithMandatoryId<typeof MedicationRequest.Schema.Type> => {
  const rewrite = rewriteReference(prepared)
  return {
    ...request,
    id: localResourceId(prepared.source.system, 'MedicationRequest', decodedId.value),
    identifier: identifiersAdopting(prepared, decodedId, request.identifier),
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
  }
}

const adoptMedicationDispense = (
  prepared: PreparedSource,
  decodedId: DecodedId.Type,
  dispense: typeof MedicationDispense.Schema.Type
): WithMandatoryId<typeof MedicationDispense.Schema.Type> => {
  const rewrite = rewriteReference(prepared)
  return {
    ...dispense,
    id: localResourceId(prepared.source.system, 'MedicationDispense', decodedId.value),
    identifier: identifiersAdopting(prepared, decodedId, dispense.identifier),
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
  }
}

const adoptDocumentReference = (
  prepared: PreparedSource,
  decodedId: DecodedId.Type,
  document: typeof DocumentReference.Schema.Type
): WithMandatoryId<typeof DocumentReference.Schema.Type> => {
  const rewrite = rewriteReference(prepared)
  return {
    ...document,
    id: localResourceId(prepared.source.system, 'DocumentReference', decodedId.value),
    identifier: identifiersAdopting(prepared, decodedId, document.identifier),
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
  }
}

const adoptDiagnosticReport = (
  prepared: PreparedSource,
  decodedId: DecodedId.Type,
  report: typeof DiagnosticReport.Schema.Type
): WithMandatoryId<typeof DiagnosticReport.Schema.Type> => {
  const rewrite = rewriteReference(prepared)
  return {
    ...report,
    id: localResourceId(prepared.source.system, 'DiagnosticReport', decodedId.value),
    identifier: identifiersAdopting(prepared, decodedId, report.identifier),
    subject: rewriteNullable(rewrite, report.subject),
    encounter: rewriteNullable(rewrite, report.encounter),
    basedOn: report.basedOn.map(rewrite),
    performer: report.performer.map(rewrite),
    resultsInterpreter: report.resultsInterpreter.map(rewrite),
    specimen: report.specimen.map(rewrite),
    result: report.result.map(rewrite),
    imagingStudy: report.imagingStudy.map(rewrite),
    media: report.media.map((media) => ({ ...media, link: rewrite(media.link) })),
  }
}

const adoptPractitioner = (
  prepared: PreparedSource,
  decodedId: DecodedId.Type,
  practitioner: typeof Practitioner.Schema.Type
): WithMandatoryId<typeof Practitioner.Schema.Type> => {
  const rewrite = rewriteReference(prepared)
  return {
    ...practitioner,
    id: localResourceId(prepared.source.system, 'Practitioner', decodedId.value),
    identifier: identifiersAdopting(prepared, decodedId, practitioner.identifier),
    qualification: practitioner.qualification.map((qualification) => ({
      ...qualification,
      issuer: rewriteNullable(rewrite, qualification.issuer),
    })),
  }
}

const adoptServiceRequest = (
  prepared: PreparedSource,
  decodedId: DecodedId.Type,
  request: typeof ServiceRequest.Schema.Type
): WithMandatoryId<typeof ServiceRequest.Schema.Type> => {
  const rewrite = rewriteReference(prepared)
  return {
    ...request,
    id: localResourceId(prepared.source.system, 'ServiceRequest', decodedId.value),
    identifier: identifiersAdopting(prepared, decodedId, request.identifier),
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
  }
}

const adoptImagingStudy = (
  prepared: PreparedSource,
  decodedId: DecodedId.Type,
  study: typeof ImagingStudy.Schema.Type
): WithMandatoryId<typeof ImagingStudy.Schema.Type> => {
  const rewrite = rewriteReference(prepared)
  return {
    ...study,
    id: localResourceId(prepared.source.system, 'ImagingStudy', decodedId.value),
    identifier: identifiersAdopting(prepared, decodedId, study.identifier),
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
  }
}

const adoptCarePlan = (
  prepared: PreparedSource,
  decodedId: DecodedId.Type,
  plan: typeof CarePlan.Schema.Type
): WithMandatoryId<typeof CarePlan.Schema.Type> => {
  const rewrite = rewriteReference(prepared)
  return {
    ...plan,
    id: localResourceId(prepared.source.system, 'CarePlan', decodedId.value),
    identifier: identifiersAdopting(prepared, decodedId, plan.identifier),
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
  }
}

const adoptGoal = (
  prepared: PreparedSource,
  decodedId: DecodedId.Type,
  goal: typeof Goal.Schema.Type
): WithMandatoryId<typeof Goal.Schema.Type> => {
  const rewrite = rewriteReference(prepared)
  return {
    ...goal,
    id: localResourceId(prepared.source.system, 'Goal', decodedId.value),
    identifier: identifiersAdopting(prepared, decodedId, goal.identifier),
    note: rewriteAnnotationAuthors(rewrite, goal.note),
    subject: rewrite(goal.subject),
    expressedBy: rewriteNullable(rewrite, goal.expressedBy),
    addresses: goal.addresses.map(rewrite),
    outcomeReference: goal.outcomeReference.map(rewrite),
  }
}

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

const adoptPlanDefinition = (
  prepared: PreparedSource,
  decodedId: DecodedId.Type,
  plan: typeof PlanDefinition.Schema.Type
): WithMandatoryId<typeof PlanDefinition.Schema.Type> => {
  const rewrite = rewriteReference(prepared)
  return {
    ...plan,
    id: localResourceId(prepared.source.system, 'PlanDefinition', decodedId.value),
    identifier: identifiersAdopting(prepared, decodedId, plan.identifier),
    subjectReference: rewriteNullable(rewrite, plan.subjectReference),
    action: rewriteActionSubjects(rewrite, plan.action),
  }
}

const adoptProcedure = (
  prepared: PreparedSource,
  decodedId: DecodedId.Type,
  procedure: typeof Procedure.Schema.Type
): WithMandatoryId<typeof Procedure.Schema.Type> => {
  const rewrite = rewriteReference(prepared)
  return {
    ...procedure,
    id: localResourceId(prepared.source.system, 'Procedure', decodedId.value),
    identifier: identifiersAdopting(prepared, decodedId, procedure.identifier),
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
  }
}

/**
 * Re-key a resource under this source's namespace: derive its local id, record
 * the source's own id as `identifier[0]`, and rewrite its references so they
 * still point at their targets.
 *
 * @param source - The system the resource was imported from
 * @returns A function from one decoded resource to its adopted form
 *
 * @remarks
 * The resource is adopted under its `DecodedId`: its own id, or, when its
 * `id` is `null`, one generated from its content, so every adopted resource
 * has one, and a re-import of the same capture lands on the same id rather
 * than beside it. A generated id is the hash input like any other, and the
 * references are rewritten as for any other resource, but the resource keeps
 * only the identifiers it arrived with: no source identifier claims an id the
 * source never gave it.
 *
 * `Binary` is adopted but gets **no** identifier — FHIR R4 gives `Binary` no
 * `identifier` element — so its original id survives only in the provenance
 * trace. It is still adopted rather than passed through, because a reference to
 * a Binary from a sibling resource has to land on the same derived id.
 *
 * The per-type rewrite table, the fields deliberately left alone, and why there
 * is no "already adopted?" guard are all in
 * this package's `docs/Source Identity Explanation.md`.
 *
 * **Every branch below maps a variant to itself, by construction and not by the
 * type system.** TypeScript cannot correlate the discriminant matched here with
 * the branch taken, so an `adoptX` returning a different variant would compile
 * and would silently widen what a caller gets back. Don't write one.
 */
const adoptResource = (source: SourceIdentity) => {
  const prepared = prepare(source)
  return (resource: FhirResource): FhirResourceWithId => {
    const decodedId = DecodedId.of(resource)
    // `Match.exhaustive` over the closed union rather than a `switch`: a
    // resource type added to `FhirResource` without an adopt function here is a
    // compile error, not a resource that silently keeps its source's id.
    return Match.value(resource).pipe(
      Match.discriminator('resourceType')('Binary', (binary) =>
        adoptBinary(prepared, decodedId, binary)
      ),
      Match.discriminator('resourceType')('Patient', (patient) =>
        adoptPatient(prepared, decodedId, patient)
      ),
      Match.discriminator('resourceType')('Observation', (observation) =>
        adoptObservation(prepared, decodedId, observation)
      ),
      Match.discriminator('resourceType')('MedicationRequest', (request) =>
        adoptMedicationRequest(prepared, decodedId, request)
      ),
      Match.discriminator('resourceType')('MedicationDispense', (dispense) =>
        adoptMedicationDispense(prepared, decodedId, dispense)
      ),
      Match.discriminator('resourceType')('DocumentReference', (document) =>
        adoptDocumentReference(prepared, decodedId, document)
      ),
      Match.discriminator('resourceType')('DiagnosticReport', (report) =>
        adoptDiagnosticReport(prepared, decodedId, report)
      ),
      Match.discriminator('resourceType')('Practitioner', (practitioner) =>
        adoptPractitioner(prepared, decodedId, practitioner)
      ),
      Match.discriminator('resourceType')('ServiceRequest', (request) =>
        adoptServiceRequest(prepared, decodedId, request)
      ),
      Match.discriminator('resourceType')('ImagingStudy', (study) =>
        adoptImagingStudy(prepared, decodedId, study)
      ),
      Match.discriminator('resourceType')('CarePlan', (plan) =>
        adoptCarePlan(prepared, decodedId, plan)
      ),
      Match.discriminator('resourceType')('Goal', (goal) => adoptGoal(prepared, decodedId, goal)),
      Match.discriminator('resourceType')('PlanDefinition', (plan) =>
        adoptPlanDefinition(prepared, decodedId, plan)
      ),
      Match.discriminator('resourceType')('Procedure', (procedure) =>
        adoptProcedure(prepared, decodedId, procedure)
      ),
      Match.exhaustive
    )
  }
}

/**
 * Read the source's own id back off a resource {@link adoptResource} adopted.
 *
 * @param source - The system the resource was imported from
 * @param resource - The adopted resource
 * @returns The id the source used, or `null` when there is none to read
 *
 * @remarks
 * `null` for a `Binary` (which carries no `identifier`), for a resource that was
 * never adopted, and for one adopted under a different source — the check is a
 * round-trip: `identifier[0]` only counts as the source id if re-deriving from
 * it reproduces the resource's own id.
 *
 * This is what a caller reads when it needs the source's id to build a
 * source-server URL: an adopted resource's `resource.id` is the local id, not
 * the remote one.
 */
const originalIdOf = (source: SourceIdentity, resource: FhirResource): string | null => {
  if (resource.resourceType === 'Binary') {
    return null
  }
  const candidate = resource.identifier[0]
  if (candidate === undefined || candidate.value === null) {
    return null
  }
  return localResourceId(source.system, resource.resourceType, candidate.value) === resource.id
    ? candidate.value
    : null
}

/**
 * A reference to a resource `source`'s import adopts, spelled as adoption
 * rewrites that source's own `resourceType/originalId`: the local id, with the
 * source's id beside it as `Reference.identifier`.
 *
 * @param source - The source the target is imported from
 * @param resourceType - The target's type (`Patient`)
 * @param originalId - The id the source gave the target
 *
 * @remarks
 * For a resource written outside that source that has to point at what its
 * import stores — a lab result filed on the Patient a pharmacy import made.
 * It is {@link adoptResource}'s own rewrite, so the two cannot drift. An
 * `originalId` outside FHIR's id grammar is left unrewritten, as adoption
 * leaves it.
 */
const adoptedReferenceOf = (
  source: SourceIdentity,
  resourceType: string,
  originalId: string
): ReferenceType =>
  rewriteReference(prepare(source))({
    ...IdentifierAndReference.emptyReference,
    reference: `${resourceType}/${originalId}`,
  })

export { adoptResource, adoptedReferenceOf, originalIdOf, type SourceIdentity }
