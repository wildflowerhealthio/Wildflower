import {
  IdentifierAndReference,
  type IdentifierType,
  type ReferenceType,
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
import * as IdSpace from './id-space.ts'

/**
 * The source system a batch of resources was imported from.
 *
 * @remarks
 * For a portal or a file format, `system` is the Wildflower-minted `sid` URI
 * naming it: the id space of every record it gives an id. For a FHIR source,
 * `baseUrl` is the server's configured root: the id space of its records of
 * a type is `<baseUrl>/<Type>`, and a reference it spells absolutely under
 * `${baseUrl}/` is read back to its relative form, so
 * `https://host/baseR4/Patient/1` and `Patient/1` adopt to the same target.
 * Leave `baseUrl` unset for a source whose ids are not a FHIR server's.
 */
interface SourceIdentity {
  /** Absolute URI naming the source system; its id space when it has no `baseUrl`. */
  readonly system: string
  /** A FHIR server's root, when the source is one. */
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
 * The per-type reference table. `Match.exhaustive` over the closed union rather
 * than a `switch`: a resource type added to `FhirResource` without a row here
 * is a compile error, not a resource whose references silently keep the
 * source's ids.
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

/** The `Identifier` naming a record by its key: `{ system: <id space>, value: <source id> }`. */
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

/**
 * The relative `reference` rewritten to name its target's local id, keyed in
 * the id space `idSpaceOf` gives the target's type, with the target's source
 * id beside it as `Reference.identifier`; every other reference as it is.
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
const rewriteRelativeReference =
  (idSpaceOf: IdSpace.OfType, systemUrlOf: (idSpace: IdSpace.Type) => URL) =>
  (reference: ReferenceType): ReferenceType => {
    const match = reference.reference === null ? null : RELATIVE_REFERENCE.exec(reference.reference)
    const resourceType = match?.[1]
    const sourceId = match?.[2]
    if (resourceType === undefined || sourceId === undefined) {
      return reference
    }
    const idSpace = idSpaceOf(resourceType)
    return {
      ...reference,
      reference: `${resourceType}/${localResourceId(idSpace, resourceType, sourceId)}`,
      identifier: reference.identifier ?? identifierOf(systemUrlOf(idSpace), sourceId),
    }
  }

/**
 * Each id space parsed once, for one adoption.
 *
 * @remarks
 * `new URL` is the most expensive thing in this file, and a page of 250
 * `Observation`s carries a few thousand references — so it is paid once per
 * id space. The one instance is written into every `Identifier.system` in
 * that space, so they alias: **treat it as immutable**, and clone before
 * mutating.
 *
 * An id space that is not an absolute URI throws a `TypeError` here. That
 * reaches the caller as a defect rather than the typed `ParseError` a wrapped
 * `parse` advertises, deliberately: it means the source is misconfigured, not
 * that a response was bad.
 */
const parsedOnce = (): ((idSpace: IdSpace.Type) => URL) => {
  const urls = new Map<IdSpace.Type, URL>()
  return (idSpace) => {
    const known = urls.get(idSpace)
    if (known !== undefined) {
      return known
    }
    const url = new URL(idSpace)
    urls.set(idSpace, url)
    return url
  }
}

/** A decoded record and its key, less its type: the id space and source id it is adopted under. */
interface ResourceWithSourceId {
  /** The system `sourceId` belongs to. */
  readonly idSpace: IdSpace.Type
  /** The record's id in `idSpace`: the source's, or a digest when it gave none. */
  readonly sourceId: string
  /** The resource as decoded; its own `id` is not read. */
  readonly resource: FhirResource
}

/**
 * Re-key a decoded record under its key (id space, type, source id): derive
 * its local id from the key, record `{ system: idSpace, value: sourceId }` as
 * `identifier[0]`, and rewrite its relative `Type/id` references so they still
 * point at their targets.
 *
 * @param idSpaceOf - The source's id space for each type: where a reference's
 *   target is keyed
 * @returns A function from one decoded record and its key to its adopted form
 *
 * @remarks
 * A reference's target is keyed in its own type's id space in the source, not
 * the referring record's: a FHIR server's `Observation` points at
 * `<base>/Patient`. Only a relative `Type/id` is rewritten; a source that
 * spells references absolutely relativises them first ({@link adoptResource}).
 *
 * `Binary` is adopted but gets **no** identifier — FHIR R4 gives `Binary` no
 * `identifier` element — so its original id survives only in the provenance
 * trace. It is still adopted rather than passed through, because a reference to
 * a Binary from a sibling resource has to land on the same derived id.
 *
 * The per-type rewrite table, the fields deliberately left alone, and why there
 * is no "already adopted?" guard are all in
 * this package's `docs/Source Identity Explanation.md`.
 */
const adoptInIdSpace = (idSpaceOf: IdSpace.OfType) => {
  const systemUrlOf = parsedOnce()
  const rewriteReferences = mapReferences(rewriteRelativeReference(idSpaceOf, systemUrlOf))
  return ({ idSpace, sourceId, resource }: ResourceWithSourceId): FhirResourceWithId => {
    const rewritten = rewriteReferences(resource)
    const id = localResourceId(idSpace, rewritten.resourceType, sourceId)
    return rewritten.resourceType === 'Binary'
      ? { ...rewritten, id }
      : {
          ...rewritten,
          id,
          identifier: [identifierOf(systemUrlOf(idSpace), sourceId), ...rewritten.identifier],
        }
  }
}

/** The id space a source keys each type in: `<baseUrl>/<Type>` for a FHIR server, its `system` otherwise. */
const idSpaceOfSource = (source: SourceIdentity): IdSpace.OfType =>
  source.baseUrl === undefined
    ? IdSpace.inSystem(source.system)
    : IdSpace.inFhirServer(source.baseUrl)

/**
 * `reference` with a FHIR server's absolute spelling of its own record,
 * `${baseUrl}/Type/id`, read back to the relative `Type/id`.
 */
const relativisedUnder =
  (baseUrl: string) =>
  (reference: ReferenceType): ReferenceType =>
    reference.reference?.startsWith(`${baseUrl}/`) === true
      ? { ...reference, reference: reference.reference.slice(baseUrl.length + 1) }
      : reference

/**
 * Re-key a resource under this source's namespace: {@link adoptInIdSpace}, in
 * the source's own id space for a resource it gave an id, and in
 * {@link IdSpace.CONTENT_DIGEST} for one it did not.
 *
 * @param source - The system the resource was imported from
 * @returns A function from one decoded resource to its adopted form
 *
 * @remarks
 * The resource is adopted under its `DecodedId`: its own id, or, when its
 * `id` is `null`, one generated from its content, so every adopted resource
 * has one, and a re-import of the same capture lands on the same id rather
 * than beside it. The digest is scoped to the id space the record's type has
 * in this source.
 *
 * A FHIR server's absolute references to itself are relativised first, so the
 * core only ever sees relative ones.
 */
const adoptResource = (source: SourceIdentity) => {
  const idSpaceOf = idSpaceOfSource(source)
  const adopt = adoptInIdSpace(idSpaceOf)
  const { baseUrl } = source
  const relativise = baseUrl === undefined ? null : mapReferences(relativisedUnder(baseUrl))
  return (decoded: FhirResource): FhirResourceWithId => {
    const resource = relativise === null ? decoded : relativise(decoded)
    const ownIdSpace = idSpaceOf(resource.resourceType)
    return DecodedId.$match(DecodedId.of(ownIdSpace, resource), {
      FoundInSource: ({ value }) => adopt({ idSpace: ownIdSpace, sourceId: value, resource }),
      GeneratedFromContent: ({ value }) =>
        adopt({ idSpace: IdSpace.CONTENT_DIGEST, sourceId: value, resource }),
    })
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
 * never adopted, for one its source gave no id, and for one adopted under a
 * different source — the check is a round-trip: `identifier[0]` only counts as
 * the source id if re-deriving from it in the source's id space reproduces the
 * resource's own id.
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
  const idSpace = idSpaceOfSource(source)(resource.resourceType)
  return localResourceId(idSpace, resource.resourceType, candidate.value) === resource.id
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
  rewriteRelativeReference(
    idSpaceOfSource(source),
    parsedOnce()
  )({
    ...IdentifierAndReference.emptyReference,
    reference: `${resourceType}/${originalId}`,
  })

export {
  adoptInIdSpace,
  adoptResource,
  adoptedReferenceOf,
  originalIdOf,
  type ResourceWithSourceId,
  type SourceIdentity,
}
