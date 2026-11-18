/**
 * Offered fields: what an import resource offers an existing stored record,
 * top-level field by top-level field.
 *
 * @packageDocumentation
 */
import { MatchQuery, normalizedEncode } from '@wildflowerhealthio/fhir-r4/clients'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { type FhirResource, TokenSearchParam } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, HashSet, Option, pipe, Predicate, Record } from 'effect'

/**
 * The fields an import resource offers an existing record, and the
 * identifiers it adds to it.
 *
 * @remarks
 * A field is offered when the import has a value for it and the value
 * differs from the existing record's. It fills a gap when the existing record
 * has no value for it, and overwrites one otherwise. The import's identifiers
 * are always added, so `identifier` is never offered. `id`, `meta` and the
 * fields `normalizedEncode` drops are not fields here.
 */
interface Type {
  /** Offered fields the existing record has no value for, in the import's field order. */
  readonly gapFilling: readonly string[]
  /** Offered fields the existing record has another value for, in the import's field order. */
  readonly overwriting: readonly string[]
  /** The import's qualified identifiers the existing record does not carry. */
  readonly identifiersToAdd: readonly IdentifierAndReference.QualifiedIdentifierType[]
}

/**
 * Fields an existing record takes from one import resource, ahead of the one
 * being compared.
 */
interface TakenFields {
  readonly resource: FhirResource
  readonly fields: HashSet.HashSet<string>
}

/** A resource's normalized wire form, its top-level fields by name. */
type WireFields = Record.ReadonlyRecord<string, unknown>

/** The top-level wire keys that are no field a reviewer takes. */
const NOT_OFFERED: ReadonlySet<string> = new Set(['resourceType', 'id', 'meta', 'identifier'])

/**
 * `resource`'s top-level fields, as `normalizedEncode` writes them.
 *
 * @throws When `resource` does not encode through its own schema. Every
 *   resource here was decoded by that schema, so that is a defect.
 */
const wireFieldsOf = (resource: FhirResource): WireFields =>
  pipe(
    normalizedEncode(resource),
    Option.filter(Predicate.isRecord),
    Option.getOrThrowWith(
      () => new Error(`A decoded ${resource.resourceType} does not encode through its schema`)
    )
  )

/** Whether a wire value says something: neither absent nor an empty list. */
const hasValue = (value: unknown): boolean =>
  value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)

/** Whether two wire values are equal. Both come from one schema's encode, so their keys are in one order. */
const sameWireValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

/** `existing`'s fields with each of `takenEarlier`'s taken fields laid over them. */
const existingWireAfter = (
  existing: FhirResource,
  takenEarlier: readonly TakenFields[]
): WireFields =>
  takenEarlier.reduce(
    (wire, { resource, fields }) => ({
      ...wire,
      ...Record.filter(wireFieldsOf(resource), (_, field) => HashSet.has(fields, field)),
    }),
    wireFieldsOf(existing)
  )

/** The search tokens of the qualified identifiers `resources` carry. */
const identifierTokensOf = (resources: readonly FhirResource[]): HashSet.HashSet<string> =>
  HashSet.fromIterable(
    resources.flatMap((resource) =>
      MatchQuery.qualifiedIdentifiersOf(resource).map(TokenSearchParam.fromQualifiedIdentifier)
    )
  )

/** `resource`'s qualified identifiers that `existing` and `takenEarlier` do not carry, each once. */
const identifiersToAddOf = (
  resource: FhirResource,
  existing: FhirResource,
  takenEarlier: readonly TakenFields[]
): readonly IdentifierAndReference.QualifiedIdentifierType[] => {
  const carried = identifierTokensOf([existing, ...takenEarlier.map((taken) => taken.resource)])
  return Arr.dedupeWith(
    MatchQuery.qualifiedIdentifiersOf(resource).filter(
      (identifier) => !HashSet.has(carried, TokenSearchParam.fromQualifiedIdentifier(identifier))
    ),
    (left, right) =>
      TokenSearchParam.fromQualifiedIdentifier(left) ===
      TokenSearchParam.fromQualifiedIdentifier(right)
  )
}

/**
 * What `resource` offers `existing`, once the fields earlier import resources
 * take into it are in place.
 *
 * @param resource - The import resource
 * @param existing - The stored record it would be written into
 * @param takenEarlier - The fields `existing` takes from import resources
 *   ahead of `resource`, in plan order; empty when there are none
 */
const compare = (
  resource: FhirResource,
  existing: FhirResource,
  takenEarlier: readonly TakenFields[]
): Type => {
  const incoming = wireFieldsOf(resource)
  const existingWire = existingWireAfter(existing, takenEarlier)
  const [gapFilling, overwriting] = Arr.partition(
    Object.keys(incoming).filter(
      (field) =>
        !NOT_OFFERED.has(field) &&
        hasValue(incoming[field]) &&
        !sameWireValue(incoming[field], existingWire[field])
    ),
    (field) => hasValue(existingWire[field])
  )
  return {
    gapFilling,
    overwriting,
    identifiersToAdd: identifiersToAddOf(resource, existing, takenEarlier),
  }
}

/** Whether `offeredFields` offers no field: the import is the same as the existing record. */
const offersNoField = (offeredFields: Type): boolean =>
  offeredFields.gapFilling.length === 0 && offeredFields.overwriting.length === 0

export { compare, offersNoField }
export type { TakenFields, Type }
