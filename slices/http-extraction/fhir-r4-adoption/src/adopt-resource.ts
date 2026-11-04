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
import { SystemFamily } from '@wildflowerhealthio/http-extraction-fundamentals'
import { Match } from 'effect'

import * as DecodedId from './decoded-id.ts'

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

/** The `Identifier` naming a record by its key: `{ system, value: <source id> }`. */
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
 * `reference` rewritten to name its target's local id, keyed in `system` with
 * the target's source id beside it as `Reference.identifier`.
 *
 * @remarks
 * The one spelling of an adopted reference. A pre-existing
 * `Reference.identifier` is kept: the slot is 0..1 and some sources already
 * fill it with their own vendor identifier; the original `Type/id` stays
 * recoverable by resolving the rewritten reference and reading the target's
 * `identifier[0]`.
 */
const adoptedReference = (
  system: string,
  systemUrl: URL,
  resourceType: string,
  sourceId: string,
  reference: ReferenceType
): ReferenceType => ({
  ...reference,
  reference: `${resourceType}/${localResourceId(system, resourceType, sourceId)}`,
  identifier: reference.identifier ?? identifierOf(systemUrl, sourceId),
})

/**
 * A reference whose literal, relativised for `family`, is a relative
 * `Type/id`, rewritten to name its target's local id, keyed in the system
 * `family` gives the target's type, with the target's source id beside it as
 * `Reference.identifier`; every other reference exactly as it is.
 *
 * @remarks
 * The one reference rewrite {@link adoptResource} runs; it spells each
 * match with {@link adoptedReference}, as {@link adoptedReferenceOf} does.
 *
 * The literal is read through {@link SystemFamily.relativise}, so a FHIR
 * server's absolute `<baseUrl>/Type/id` lands where its `Type/id` does. A
 * literal that is still not a relative `Type/id` once relativised — a
 * versioned `<baseUrl>/Type/id/_history/v`, a search URL, an id past 64
 * characters, a base that is only a prefix of the server's — is kept in its
 * original spelling, absolute or not.
 *
 * Rewrites apply to **any** resource-type token, not only the types this
 * package stores. The derivation is deterministic, so a `Practitioner/x` link
 * resolves retroactively if that type is ever imported from the same source, and
 * dangles exactly as it did before if it never is — with the original id still
 * readable from the `Reference.identifier` this writes.
 */
const rewriteReference = (family: SystemFamily.Type, urlOf: (url: string) => URL) => {
  const relativise = SystemFamily.relativise(family)
  return (reference: ReferenceType): ReferenceType => {
    const match =
      reference.reference === null ? null : RELATIVE_REFERENCE.exec(relativise(reference.reference))
    const resourceType = match?.[1]
    const sourceId = match?.[2]
    if (resourceType === undefined || sourceId === undefined) {
      return reference
    }
    const system = SystemFamily.systemFor(family, resourceType)
    return adoptedReference(system, urlOf(system), resourceType, sourceId, reference)
  }
}

/**
 * `new URL`, memoised for one adoption.
 *
 * @remarks
 * `new URL` is the most expensive thing in this file, and a page of 250
 * `Observation`s carries a few thousand references — so each system is parsed
 * once. The one instance is written into every `Identifier.system` in that
 * system, so they alias: **treat it as immutable**, and clone before mutating.
 *
 * A system that is not an absolute URI throws a `TypeError` here. That
 * reaches the caller as a defect rather than the typed `ParseError` a wrapped
 * `parse` advertises, deliberately: it means the source is misconfigured, not
 * that a response was bad.
 */
const memoisedUrlOf = (): ((url: string) => URL) => {
  const urls = new Map<string, URL>()
  return (url) => {
    const known = urls.get(url)
    if (known !== undefined) {
      return known
    }
    const parsed = new URL(url)
    urls.set(url, parsed)
    return parsed
  }
}

/**
 * Whether FHIR R4 gives `resource`'s type an `identifier` element.
 *
 * @remarks
 * `Binary` is the one type in the union without one, so its source id
 * survives only in the provenance trace. A type added to the union without
 * `identifier` is added here, and nowhere else.
 */
const hasIdentifier = (
  resource: FhirResource
): resource is Exclude<FhirResource, { readonly resourceType: 'Binary' }> =>
  resource.resourceType !== 'Binary'

/** A decoded record and its key, less its type: the system and source id it is adopted under. */
interface ResourceWithSourceId {
  /** The system `sourceId` belongs to: an absolute URI. */
  readonly system: string
  /** The record's id in `system`: the source's, or a digest when it gave none. */
  readonly sourceId: string
  /** The resource as decoded; its own `id` is not read. */
  readonly resource: FhirResource
}

/**
 * Re-key a decoded record under its key (system, type, source id): derive its
 * local id from the key, record `{ system, value: sourceId }` as
 * `identifier[0]`, and rewrite its references ({@link rewriteReference}) so
 * they still point at their targets.
 *
 * @param family - The systems the record's source keys each type in: where
 *   each reference's target is keyed. The record's own system comes with the
 *   record
 * @returns A function from one decoded record and its key to its adopted form
 *
 * @remarks
 * A reference's target is keyed in the system `family` gives its own type,
 * not the referring record's: a FHIR server's `Observation` points at
 * `<baseUrl>/Patient`.
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
const adoptUnderKey = (family: SystemFamily.Type) => {
  const urlOf = memoisedUrlOf()
  const rewriteReferences = mapReferences(rewriteReference(family, urlOf))
  return ({ system, sourceId, resource }: ResourceWithSourceId): FhirResourceWithId => {
    const rewritten = rewriteReferences(resource)
    const id = localResourceId(system, rewritten.resourceType, sourceId)
    return hasIdentifier(rewritten)
      ? {
          ...rewritten,
          id,
          identifier: [identifierOf(urlOf(system), sourceId), ...rewritten.identifier],
        }
      : { ...rewritten, id }
  }
}

/**
 * A decoded resource beside the key it is adopted under, less its type: its
 * own id, in the system `family` gives its type, or, when its `id` is `null`,
 * a digest of its content as decoded, in {@link DecodedId.CONTENT_DIGEST_SYSTEM}.
 *
 * @param family - The systems the resource's source keys each type in
 * @returns A function from one decoded resource to it and its source id
 *
 * @remarks
 * What a decoder hands the import stage for each record of a `FromSource`
 * section. The digest is scoped to the system `family` gives the record's
 * type, so the same content from two sources keys apart.
 */
const withSourceId =
  (family: SystemFamily.Type) =>
  (resource: FhirResource): ResourceWithSourceId => {
    const ownSystem = SystemFamily.systemFor(family, resource.resourceType)
    return DecodedId.$match(DecodedId.of(ownSystem, resource), {
      FoundInSource: ({ value }) => ({ system: ownSystem, sourceId: value, resource }),
      GeneratedFromContent: ({ value }) => ({
        system: DecodedId.CONTENT_DIGEST_SYSTEM,
        sourceId: value,
        resource,
      }),
    })
  }

/**
 * Re-key a resource under its source's systems: {@link adoptUnderKey} under
 * the key {@link withSourceId} reads off it.
 *
 * @param family - The systems the resource's source keys each type in
 * @returns A function from one decoded resource to its adopted form
 *
 * @remarks
 * So every adopted resource has an id, and a re-import of the same capture
 * lands on the same id rather than beside it. Its references are keyed in
 * `family` whichever system the resource itself is keyed in. A reference
 * whose literal relativises ({@link SystemFamily.relativise}) to a relative
 * `Type/id` is rewritten; any other keeps its original spelling
 * ({@link rewriteReference}).
 */
const adoptResource = (family: SystemFamily.Type) => {
  const adopt = adoptUnderKey(family)
  const keyed = withSourceId(family)
  return (resource: FhirResource): FhirResourceWithId => adopt(keyed(resource))
}

/**
 * Read the source's own id back off a resource {@link adoptResource} adopted.
 *
 * @param system - The system adoption keys the resource's type in: for a
 *   FHIR-style source `<baseUrl>/<Type>`, not the base itself
 *   ({@link SystemFamily.systemFor})
 * @param resource - The adopted resource
 * @returns The id the source used, or `null` when there is none to read
 *
 * @remarks
 * `null` for a `Binary` (which carries no `identifier`), for a resource that was
 * never adopted, for one adopted under a different system, and for one its
 * source gave no id — including when `system` is
 * {@link DecodedId.CONTENT_DIGEST_SYSTEM}, since a digest is Wildflower's, not
 * the source's. Otherwise the check is a round-trip: `identifier[0]` only
 * counts as the source id if re-deriving from it in `system` reproduces the
 * resource's own id.
 *
 * This is what a caller reads when it needs the source's id to build a
 * source-server URL: an adopted resource's `resource.id` is the local id, not
 * the remote one.
 */
const originalIdOf = (system: string, resource: FhirResource): string | null => {
  if (system === DecodedId.CONTENT_DIGEST_SYSTEM || !hasIdentifier(resource)) {
    return null
  }
  const candidate = resource.identifier[0]
  if (candidate === undefined || candidate.value === null) {
    return null
  }
  return localResourceId(system, resource.resourceType, candidate.value) === resource.id
    ? candidate.value
    : null
}

/**
 * A reference to a resource an import adopts in `system`, spelled as adoption
 * rewrites the source's own `resourceType/originalId`: the local id, with the
 * source's id beside it as `Reference.identifier`.
 *
 * @param system - The system adoption keys the target's type in: for a
 *   FHIR-style source `<baseUrl>/<Type>`, not the base itself
 *   ({@link SystemFamily.systemFor})
 * @param resourceType - The target's type (`Patient`)
 * @param originalId - The id the source gave the target
 *
 * @remarks
 * For a resource written outside that source that has to point at what its
 * import stores — a lab result filed on the Patient a pharmacy import made.
 * It is {@link adoptResource}'s own spelling ({@link adoptedReference}), so
 * given the system adoption uses for the type, the two agree. An `originalId` outside FHIR's id grammar is left
 * unrewritten, as adoption leaves it. `system` is parsed per call: this runs
 * a handful of times per synthetic account, not thousands per page, so the
 * memo adoption pays for is not worth the aliasing here.
 */
const adoptedReferenceOf = (
  system: string,
  resourceType: string,
  originalId: string
): ReferenceType =>
  RELATIVE_REFERENCE.test(`${resourceType}/${originalId}`)
    ? adoptedReference(system, new URL(system), resourceType, originalId, {
        ...IdentifierAndReference.emptyReference,
        reference: `${resourceType}/${originalId}`,
      })
    : { ...IdentifierAndReference.emptyReference, reference: `${resourceType}/${originalId}` }

export { adoptResource, adoptedReferenceOf, adoptUnderKey, originalIdOf, withSourceId }
export type { ResourceWithSourceId }
