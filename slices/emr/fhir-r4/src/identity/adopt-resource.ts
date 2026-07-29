import { Match } from 'effect'

import type {
  IdentifierType,
  ReferenceType,
} from '../data-types/complex/identifier-and-reference.ts'
import type * as Binary from '../resources/binary/binary.ts'
import type * as DocumentReference from '../resources/document-reference/document-reference.ts'
import type { FhirResource } from '../resources/fhir-resource.ts'
import type * as MedicationDispense from '../resources/medication-dispense/medication-dispense.ts'
import type * as MedicationRequest from '../resources/medication-request/medication-request.ts'
import type * as Observation from '../resources/observation/observation.ts'
import type * as Patient from '../resources/patient/patient.ts'
import { localResourceId } from './local-resource-id.ts'

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

/** A fully-populated decoded `Identifier` carrying the source's own id for a resource. */
const sourceIdentifier = (source: SourceIdentity, value: string): IdentifierType => ({
  id: null,
  extension: [],
  assigner: null,
  period: null,
  system: new URL(source.system),
  type: null,
  use: null,
  value,
})

/**
 * Rewrite one `Reference` so it names the local id of the resource it points at.
 *
 * @remarks
 * Rewrites apply to **any** resource-type token, not only the six types this
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
  (source: SourceIdentity) =>
  (reference: ReferenceType): ReferenceType => {
    if (reference.reference === null) {
      return reference
    }
    const absolutePrefix = source.baseUrl === undefined ? null : `${source.baseUrl}/`
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
      reference: `${resourceType}/${localResourceId(source.system, resourceType, originalId)}`,
      identifier: reference.identifier ?? sourceIdentifier(source, originalId),
    }
  }

/** Apply `rewrite` to a nullable reference slot. */
const rewriteNullable = (
  rewrite: (reference: ReferenceType) => ReferenceType,
  reference: ReferenceType | null
): ReferenceType | null => (reference === null ? null : rewrite(reference))

const adoptBinary = (
  source: SourceIdentity,
  originalId: string,
  binary: typeof Binary.Schema.Type
): typeof Binary.Schema.Type => {
  const rewrite = rewriteReference(source)
  return {
    ...binary,
    id: localResourceId(source.system, 'Binary', originalId),
    securityContext: rewriteNullable(rewrite, binary.securityContext),
  }
}

const adoptPatient = (
  source: SourceIdentity,
  originalId: string,
  patient: typeof Patient.Schema.Type
): typeof Patient.Schema.Type => {
  const rewrite = rewriteReference(source)
  return {
    ...patient,
    id: localResourceId(source.system, 'Patient', originalId),
    identifier: [sourceIdentifier(source, originalId), ...patient.identifier],
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
  source: SourceIdentity,
  originalId: string,
  observation: typeof Observation.Schema.Type
): typeof Observation.Schema.Type => {
  const rewrite = rewriteReference(source)
  return {
    ...observation,
    id: localResourceId(source.system, 'Observation', originalId),
    identifier: [sourceIdentifier(source, originalId), ...observation.identifier],
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
  source: SourceIdentity,
  originalId: string,
  request: typeof MedicationRequest.Schema.Type
): typeof MedicationRequest.Schema.Type => {
  const rewrite = rewriteReference(source)
  return {
    ...request,
    id: localResourceId(source.system, 'MedicationRequest', originalId),
    identifier: [sourceIdentifier(source, originalId), ...request.identifier],
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
  source: SourceIdentity,
  originalId: string,
  dispense: typeof MedicationDispense.Schema.Type
): typeof MedicationDispense.Schema.Type => {
  const rewrite = rewriteReference(source)
  return {
    ...dispense,
    id: localResourceId(source.system, 'MedicationDispense', originalId),
    identifier: [sourceIdentifier(source, originalId), ...dispense.identifier],
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
  source: SourceIdentity,
  originalId: string,
  document: typeof DocumentReference.Schema.Type
): typeof DocumentReference.Schema.Type => {
  const rewrite = rewriteReference(source)
  return {
    ...document,
    id: localResourceId(source.system, 'DocumentReference', originalId),
    identifier: [sourceIdentifier(source, originalId), ...document.identifier],
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

/**
 * Re-key a resource under this source's namespace: derive its local id, record
 * the source's own id as `identifier[0]`, and rewrite its references so they
 * still point at their targets.
 *
 * @param source - The system the resource was imported from
 * @returns A function from one decoded resource to its adopted form
 *
 * @remarks
 * A resource whose `id` is `null` passes through unchanged: there is no identity
 * to adopt, and `upsertResource` cannot write it either.
 *
 * `Binary` is adopted but gets **no** identifier — FHIR R4 gives `Binary` no
 * `identifier` element — so its original id survives only in the provenance
 * trace. It is still adopted rather than passed through, because a reference to
 * a Binary from a sibling resource has to land on the same derived id.
 *
 * There is no "already adopted?" guard. Adoption runs exactly once per resource,
 * at the one choke point `adoptSourceIdentity` installs; a source that
 * publishes its own base URL as an identifier system yields a benign duplicate
 * identifier, nothing more.
 *
 * What is never touched: `contained` (raw passthrough JSON), `extension` /
 * `modifierExtension` including any `valueReference` inside them, `meta.source`
 * (a source-system URI at this point — the provenance hook overwrites it with a
 * local trace reference *after* adoption), `Identifier.assigner`,
 * `groupIdentifier`, and `Attachment.url`.
 */
const adoptResource =
  (source: SourceIdentity) =>
  (resource: FhirResource): FhirResource => {
    const originalId = resource.id
    if (originalId === null) {
      return resource
    }
    // `Match.exhaustive` over the closed union rather than a `switch`: a
    // resource type added to `FhirResource` without an adopt function here is a
    // compile error, not a resource that silently keeps its source's id.
    return Match.value(resource).pipe(
      Match.discriminator('resourceType')('Binary', (binary) =>
        adoptBinary(source, originalId, binary)
      ),
      Match.discriminator('resourceType')('Patient', (patient) =>
        adoptPatient(source, originalId, patient)
      ),
      Match.discriminator('resourceType')('Observation', (observation) =>
        adoptObservation(source, originalId, observation)
      ),
      Match.discriminator('resourceType')('MedicationRequest', (request) =>
        adoptMedicationRequest(source, originalId, request)
      ),
      Match.discriminator('resourceType')('MedicationDispense', (dispense) =>
        adoptMedicationDispense(source, originalId, dispense)
      ),
      Match.discriminator('resourceType')('DocumentReference', (document) =>
        adoptDocumentReference(source, originalId, document)
      ),
      Match.exhaustive
    )
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
 * This is what a `followUpSteps` generator calls when it needs the source's id
 * to build a source-server URL: under an adopted plan a generator receives
 * adopted resources, so `resource.id` is the local id, not the remote one.
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

export { adoptResource, originalIdOf, type SourceIdentity }
