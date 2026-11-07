/**
 * An implied record: the record a reference names when no record of its file
 * set is that record, built from what the reference says of it, its type,
 * its identifier and its display.
 *
 * @packageDocumentation
 */
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResource,
  type LogicalReference,
  Patient,
  Practitioner,
} from '@wildflowerhealthio/fhir-r4/resources'
import { type Either, Option, type ParseResult, Record } from 'effect'

/**
 * Makes the record a reference to one type implies, from the identifier and
 * the display the reference gives: the record as its schema decodes it, or
 * the `ParseError` its schema rejects it with.
 */
type ImpliedRecordMaker = (
  identifier: IdentifierAndReference.QualifiedIdentifierType,
  display: string
) => Either.Either<DetachedResource.Type, ParseResult.ParseError>

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

/**
 * The maker of the record a reference to each type `fhir-r4` models implies:
 * a Patient or a Practitioner named by its display, and none for a type
 * whose record needs more than a reference can say, each with the elements
 * R4 requires that a reference does not carry.
 *
 * @remarks
 * Exhaustive over `FhirResource`, so a type added to it states here whether
 * a reference implies its record.
 */
const IMPLIED_RECORD_MAKERS: {
  readonly [TType in FhirResource['resourceType']]: Option.Option<ImpliedRecordMaker>
} = {
  Patient: Option.some((identifier, display) =>
    decodePatient(namedRecordWire('Patient', identifier, display))
  ),
  Practitioner: Option.some((identifier, display) =>
    decodePractitioner(namedRecordWire('Practitioner', identifier, display))
  ),
  // No `identifier` element to key it by.
  Binary: Option.none(),
  // `status` and `code`.
  Observation: Option.none(),
  // `status`, `intent`, `medication[x]` and `subject`.
  MedicationRequest: Option.none(),
  // `status` and `medication[x]`.
  MedicationDispense: Option.none(),
  // `status` and `content`.
  DocumentReference: Option.none(),
  // `status` and `code`.
  DiagnosticReport: Option.none(),
  // `status`, `intent` and `subject`.
  ServiceRequest: Option.none(),
  // `status` and `subject`.
  ImagingStudy: Option.none(),
  // `status`, `intent` and `subject`.
  CarePlan: Option.none(),
  // `lifecycleStatus`, `description` and `subject`.
  Goal: Option.none(),
  // `status`.
  PlanDefinition: Option.none(),
  // `status` and `subject`.
  Procedure: Option.none(),
}

/** {@link IMPLIED_RECORD_MAKERS} read by any R4 type, a type it does not list answering nothing. */
const impliedRecordMakersByType: Record.ReadonlyRecord<
  string,
  Option.Option<ImpliedRecordMaker>
> = IMPLIED_RECORD_MAKERS

/**
 * The record `logicalReference`, shown as `display`, implies: keyed by its
 * identifier, with no `id`, as every decoded record is.
 *
 * @returns `None` for a type `fhir-r4` does not model (an `Organization`,
 *   until it does) and a type whose record needs more than a reference says;
 *   else the record, or the `ParseError` its schema rejects it with
 */
const tryFromLogicalReference = (
  logicalReference: LogicalReference.Type,
  display: string
): Option.Option<Either.Either<DetachedResource.Type, ParseResult.ParseError>> =>
  Option.map(
    Option.flatten(Record.get(impliedRecordMakersByType, logicalReference.resourceType)),
    (makeImpliedRecord) => makeImpliedRecord(logicalReference.identifier[0], display)
  )

/**
 * The `fullUrl` of the record `logicalReference` implies, first named by the
 * entry under `referencingFullUrl`:
 * `<referencingFullUrl>#implied:<Type>|<system>|<value>`.
 *
 * @remarks
 * Only a key, stable and unique, which the review tracks the row by: stable
 * across a settings re-decode, since it is read off the entry and the
 * reference, and unique across the batch, since the referencing entry's
 * `fullUrl` is (`FormatDecode.keyPrefix`). Nothing reads it back: a row says
 * it is implied by its `origin` (`Reviewable.Origin`).
 */
const fullUrlOf = (
  referencingFullUrl: string,
  { resourceType, identifier: [{ system, value }] }: LogicalReference.Type
): string => `${referencingFullUrl}#implied:${resourceType}|${system.href}|${value}`

export { fullUrlOf, tryFromLogicalReference }
