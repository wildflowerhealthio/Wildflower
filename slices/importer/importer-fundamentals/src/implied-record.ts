/**
 * An implied record: the record a reference names when no record of its file
 * set is that record, built from what the reference says of it, its type,
 * its identifier and its display.
 *
 * @packageDocumentation
 */
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { type FhirResource, Patient, Practitioner } from '@wildflowerhealthio/fhir-r4/resources'
import { type Either, Option, type ParseResult, Record } from 'effect'

/**
 * The record a reference to one type implies from its identifier and
 * display, as its schema decodes it, or `None` when it implies none.
 */
type ImpliedRecordOf = (
  identifier: IdentifierAndReference.QualifiedIdentifierType,
  display: string
) => Option.Option<Either.Either<DetachedResource.Type, ParseResult.ParseError>>

/**
 * The wire of a record of `resourceType` keyed by `identifier`, its one name
 * `display` as printed: what a reference says of a person or a provider.
 */
const namedRecordWire = (
  resourceType: 'Patient' | 'Practitioner',
  { system, value }: IdentifierAndReference.QualifiedIdentifierType,
  display: string
): unknown => ({
  resourceType,
  identifier: [DetachedResource.keyIdentifierWire({ system: system.href, value })],
  name: [{ text: display }],
})

const decodePatient = DetachedResource.decodeUnknownEither(Patient.Schema)
const decodePractitioner = DetachedResource.decodeUnknownEither(Practitioner.Schema)

/** A type a reference implies no record of. */
const impliesNone: ImpliedRecordOf = () => Option.none()

/**
 * What a reference to each type `fhir-r4` models implies: a Patient or a
 * Practitioner named by its display, and nothing for a type whose record
 * needs more than a reference can say, each with the elements R4 requires
 * that a reference does not carry.
 *
 * @remarks
 * Exhaustive over `FhirResource`, so a type added to it states here whether
 * a reference implies its record.
 */
const IMPLIED_RECORD_OF: { readonly [TType in FhirResource['resourceType']]: ImpliedRecordOf } = {
  Patient: (identifier, display) =>
    Option.some(decodePatient(namedRecordWire('Patient', identifier, display))),
  Practitioner: (identifier, display) =>
    Option.some(decodePractitioner(namedRecordWire('Practitioner', identifier, display))),
  // No `identifier` element to key it by.
  Binary: impliesNone,
  // `status` and `code`.
  Observation: impliesNone,
  // `status`, `intent`, `medication[x]` and `subject`.
  MedicationRequest: impliesNone,
  // `status` and `medication[x]`.
  MedicationDispense: impliesNone,
  // `status` and `content`.
  DocumentReference: impliesNone,
  // `status` and `code`.
  DiagnosticReport: impliesNone,
  // `status`, `intent` and `subject`.
  ServiceRequest: impliesNone,
  // `status` and `subject`.
  ImagingStudy: impliesNone,
  // `status`, `intent` and `subject`.
  CarePlan: impliesNone,
  // `lifecycleStatus`, `description` and `subject`.
  Goal: impliesNone,
  // `status`.
  PlanDefinition: impliesNone,
  // `status` and `subject`.
  Procedure: impliesNone,
}

/** {@link IMPLIED_RECORD_OF} read by any type token, a type it does not list answering nothing. */
const impliedRecordOfByType: Record.ReadonlyRecord<string, ImpliedRecordOf> = IMPLIED_RECORD_OF

/**
 * The record a reference to `resourceType` by `identifier`, shown as
 * `display`, implies: keyed by that identifier, with no `id`, as every
 * decoded record is.
 *
 * @returns `None` for a type `fhir-r4` does not model (an `Organization`,
 *   until it does) and a type whose record needs more than a reference says;
 *   else the record, or the `ParseError` its schema rejects it with
 */
const of = (
  resourceType: string,
  identifier: IdentifierAndReference.QualifiedIdentifierType,
  display: string
): Option.Option<Either.Either<DetachedResource.Type, ParseResult.ParseError>> =>
  Option.flatMap(Record.get(impliedRecordOfByType, resourceType), (impliedRecordOf) =>
    impliedRecordOf(identifier, display)
  )

/**
 * The `fullUrl` of the record a reference to `resourceType` by `identifier`
 * implies, first named by the entry under `referencingFullUrl`:
 * `<referencingFullUrl>#implied:<Type>|<system>|<value>`.
 *
 * @remarks
 * Only a key, stable and unique, which the review tracks the row by: stable
 * across a settings re-decode, since it is read off the entry and the
 * reference, and unique across the batch, since the referencing entry's
 * `fullUrl` is (`FormatDecode.keyPrefix`). Nothing reads it back: a row says
 * it is implied by its `origin` (`DecodedFile.Origin`).
 */
const fullUrlOf = (
  referencingFullUrl: string,
  resourceType: string,
  { system, value }: IdentifierAndReference.QualifiedIdentifierType
): string => `${referencingFullUrl}#implied:${resourceType}|${system.href}|${value}`

export { fullUrlOf, of }
