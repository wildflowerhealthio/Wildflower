import {
  IdentifierAndReference,
  type IdentifierType,
  type ReferenceType,
} from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type Binary,
  type CarePlan,
  type DiagnosticReport,
  type DocumentReference,
  type FhirResource,
  type FhirResourceWithId,
  type Goal,
  type ImagingStudy,
  type MedicationDispense,
  type MedicationRequest,
  type Observation,
  type Patient,
  type PlanDefinition,
  type PlanDefinitionAction,
  type Practitioner,
  type Procedure,
  ResourceType,
  type ServiceRequest,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Match, Option } from 'effect'

import * as DetachedResource from './detached-resource.ts'

/**
 * FHIR R4's relative-reference grammar: a resource-type token, `/`, and a
 * logical id.
 *
 * @remarks
 * The only literal {@link detach} reads a target's id from, and only when the
 * token is an R4 resource type (`ResourceType.is`). Everything else is left
 * verbatim — a `#fragment` contained reference, a `urn:uuid:`, a foreign
 * absolute URL, a versioned `Type/id/_history/v`, any id carrying a character
 * outside the spec's set (a space, a slash), and a token R4 does not define
 * (carebook's `PrescriptionOrder`) all pass through untouched.
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
 * The per-type reference table, the one place a resource's references are
 * walked: {@link detach} and {@link adopt} both rewrite through it.
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

/**
 * `new URL`, memoised for one detach.
 *
 * @remarks
 * `new URL` is the most expensive thing in this file, and a page of 250
 * `Observation`s carries a few thousand references — so each system is parsed
 * once. The one instance is written into every `Identifier.system` in that
 * system, so they alias: **treat it as immutable**, and clone before mutating.
 *
 * A system that is not an absolute URI throws a `TypeError` here. That
 * reaches the caller as a defect rather than as a failed parse, deliberately:
 * it means the source is misconfigured, not that a response was bad.
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
 * The system a FHIR server at `baseUrl` keys its records of `resourceType` in,
 * `<baseUrl>/<Type>`: the `[base]/[type]` of its `[base]/[type]/[id]`, since
 * a FHIR server's ids are unique per type.
 */
const serverSystemOf = (baseUrl: string, resourceType: string): string =>
  `${baseUrl}/${resourceType}`

/**
 * A reference literal as the relative `Type/id` {@link detach} reads a
 * target's id from: a FHIR server at `baseUrl` may spell a reference to its own
 * record absolutely, `<baseUrl>/Type/id`, which is the same target as
 * `Type/id`, so that prefix is read back off. Any other literal as it is.
 */
const relativise = (baseUrl: string, reference: string): string =>
  reference.startsWith(`${baseUrl}/`) ? reference.slice(baseUrl.length + 1) : reference

/**
 * A reference whose literal, relativised against `baseUrl`, is a relative
 * `Type/id`, as the logical reference to its target: no literal, `type` the
 * target's type, and `identifier` the target's key, `<baseUrl>/<Type>` and
 * the id as its value. Every other reference exactly as it is.
 *
 * @remarks
 * The literal is read through {@link relativise}, so a FHIR server's absolute
 * `<baseUrl>/Type/id` detaches exactly as its `Type/id`. A literal that is
 * still not a relative `Type/id` of an R4 resource type once relativised — a
 * `#fragment`, a `urn:uuid:`, a foreign absolute URL, a versioned
 * `Type/id/_history/v`, a search URL, an id past 64 characters, a base that is
 * only a prefix of the server's, a type R4 does not define — is kept in its
 * original spelling, absolute or not, its `identifier` included. A reference
 * with no literal (an identifier-only or display-only one) is kept as the
 * source wrote it.
 *
 * An `identifier` the server had also put on a reference it is turned
 * logical is **replaced** by the target's key: the slot is 0..1, and the key
 * is what names the target now that the literal is gone. A FHIR server may
 * send both on one reference, so this is not a rule only one source needs.
 * The target carries its own identifiers, so the server's are not lost when it
 * was decoded too.
 * `display` and `extension` are kept.
 */
const detachReference =
  (baseUrl: string, urlOf: (url: string) => URL) =>
  (reference: ReferenceType): ReferenceType => {
    const match =
      reference.reference === null
        ? null
        : RELATIVE_REFERENCE.exec(relativise(baseUrl, reference.reference))
    const resourceType = match?.[1]
    const id = match?.[2]
    if (resourceType === undefined || id === undefined || !ResourceType.is(resourceType)) {
      return reference
    }
    return {
      ...reference,
      reference: null,
      type: resourceType,
      identifier: identifierOf(urlOf(serverSystemOf(baseUrl, resourceType)), id),
    }
  }

/**
 * Detach a resource a FHIR server served, with its ids and literal
 * references: drop its `id`, key it by that id, and turn each reference to
 * another of the server's records into a logical one.
 *
 * @param baseUrl - The server's base URL, the `[base]` of its
 *   `[base]/[type]/[id]`
 * @returns A function from one served resource to its detached form
 *
 * @remarks
 * For a response kind whose records really were a FHIR server's (a FHIR R4
 * server's reads, carebook's STU3 searchset), as a private step of its
 * `parse`. A decoder that synthesizes its records writes them detached
 * instead (`DetachedResource.keyIdentifierWire`, `logicalReferenceWire`).
 *
 * - `id` becomes `null`. When it was set and the type has an `identifier`
 *   element, `{ system: <baseUrl>/<Type>, value: id }` is prepended as
 *   `identifier[0]`, the record's key; every identifier the server wrote is
 *   kept behind it. A `Binary` (no `identifier` element) and a record with no
 *   `id` keep only what they had, so they are keyless unless the server's own
 *   first identifier names them.
 * - Every reference the per-type table ({@link mapReferences}) reaches is run
 *   through {@link detachReference}.
 *
 * There is deliberately no "already keyed?" guard: a server that publishes
 * its own id as an identifier in the same system yields a benign duplicate.
 */
const detach = (baseUrl: string) => {
  const urlOf = memoisedUrlOf()
  const detachReferences = mapReferences(detachReference(baseUrl, urlOf))
  return (resource: FhirResource): DetachedResource.Type => {
    const detached = detachReferences(resource)
    const { id } = resource
    return id !== null && DetachedResource.hasIdentifier(detached)
      ? {
          ...detached,
          id: null,
          identifier: [
            identifierOf(urlOf(serverSystemOf(baseUrl, detached.resourceType)), id),
            ...detached.identifier,
          ],
        }
      : { ...detached, id: null }
  }
}

/** A fresh random id for a keyless record: a v4 UUID, a legal FHIR id. */
const randomResourceId = (): string => crypto.randomUUID()

/** What one batch's adoption needs beyond each record. */
interface Adoption {
  /**
   * The literal reference every keyed record of the batch is stored under
   * ({@link DetachedResource.storedReferencesOf}): what a logical reference
   * resolves against.
   */
  readonly storedReferences: ReadonlySet<string>
  /** Mints the id of a keyless record; {@link randomResourceId} outside tests. */
  readonly mintId: () => string
}

/**
 * A logical reference to a record of the batch, as the literal reference to
 * the id that record is stored under, `type` and `identifier` kept; every
 * other reference exactly as it is.
 *
 * @remarks
 * As a FHIR server resolves a conditional reference against the transaction
 * bundle it processes: a reference with no literal, an R4 resource type as
 * its `type`, and an `identifier` with a `system` and `value` resolves when
 * the record of that type keyed by that identifier is in the batch, its
 * stored reference among `storedReferences`. One that matches no record of
 * the batch — a target the source never served, an account number, a
 * provider's printed name — stays logical, for the importer's identity map
 * (and, later, a match against what the device already holds). A reference
 * whose target is keyless cannot name it, so it stays logical too.
 */
const adoptReference =
  (storedReferences: ReadonlySet<string>) =>
  (reference: ReferenceType): ReferenceType => {
    const { identifier, type } = reference
    if (
      reference.reference !== null ||
      type === null ||
      !ResourceType.is(type) ||
      identifier === null ||
      !IdentifierAndReference.isQualifiedIdentifier(identifier)
    ) {
      return reference
    }
    const stored = DetachedResource.storedReferenceOf(type, {
      system: identifier.system.href,
      value: identifier.value,
    })
    return storedReferences.has(stored) ? { ...reference, reference: stored } : reference
  }

/**
 * Adopt a detached record into the store: give it the id it is stored under,
 * and resolve each of its logical references to a record of the batch to a
 * literal one.
 *
 * @param adoption - The batch's stored references and its keyless-id minter
 * @returns A function from one detached record to its stored form
 *
 * @remarks
 * A keyed record's id is `localResourceId(key.system, Type, key.value)`
 * ({@link DetachedResource.keyedIdOf}), so a re-import of the same record
 * lands on the same id; a keyless one gets `adoption.mintId()`, so a
 * re-import of it is a second record. References resolve through
 * {@link adoptReference}. Nothing else changes: the record's identifiers,
 * its key first, are written as they are.
 *
 * Takes no base URL: everything it needs is on the records.
 */
const adopt = ({ storedReferences, mintId }: Adoption) => {
  const adoptReferences = mapReferences(adoptReference(storedReferences))
  return (record: DetachedResource.Type): FhirResourceWithId => ({
    ...adoptReferences(record),
    id: Option.getOrElse(DetachedResource.keyedIdOf(record), mintId),
  })
}

/**
 * The id a source gave an adopted resource: the value of its identifier in
 * `system`.
 *
 * @param system - The system the source's ids for the type belong to: for a
 *   FHIR server `<baseUrl>/<Type>`, not the base itself
 * @param resource - The adopted resource
 * @returns The first identifier value in `system`, or `null` when it has none
 *   there (and always for a `Binary`, which has no identifiers)
 *
 * @remarks
 * What a caller reads when it needs the source's id to build a source-server
 * URL: an adopted resource's `resource.id` is the local id, not the remote
 * one.
 */
const originalIdOf = (system: string, resource: FhirResource): string | null =>
  DetachedResource.hasIdentifier(resource)
    ? (resource.identifier.find((identifier) => identifier.system?.href === system)?.value ?? null)
    : null

/**
 * The literal reference a source's import stores the record keyed
 * `{ system, value: originalId }` under, beside the logical reference to it:
 * `reference` its stored reference ({@link DetachedResource.storedReferenceOf}),
 * `type` and `identifier` the key.
 *
 * @param system - The system the source's ids for the target's type belong
 *   to: for a FHIR server `<baseUrl>/<Type>`, not the base itself
 * @param resourceType - The target's type (`Patient`)
 * @param originalId - The id the source gave the target
 *
 * @remarks
 * For a resource written outside that source that has to point at what its
 * import stores — a lab result filed on the Patient a pharmacy import made.
 * It is the spelling {@link adopt} gives a resolved reference, with nothing
 * to resolve against: the caller states that the record is stored.
 */
const adoptedReferenceOf = (
  system: string,
  resourceType: string,
  originalId: string
): ReferenceType => ({
  ...IdentifierAndReference.emptyReference,
  reference: DetachedResource.storedReferenceOf(resourceType, { system, value: originalId }),
  type: resourceType,
  identifier: identifierOf(new URL(system), originalId),
})

export { adopt, adoptedReferenceOf, detach, originalIdOf, randomResourceId }
export type { Adoption }
