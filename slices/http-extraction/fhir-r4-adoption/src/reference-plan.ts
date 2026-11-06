/**
 * A reference plan: for each resource type and qualified identifier, the
 * literal reference a logical reference by them resolves to.
 *
 * @remarks
 * A plain data structure. It holds the entries it is given and decides
 * nothing about which identifiers go in: that is its builder's policy (the
 * import stage's, for a file set). `adopt` reads it to resolve each
 * logical reference of the records it adopts.
 *
 * @packageDocumentation
 */
import { IdentifierAndReference, type ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'
import { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Option, pipe, Record } from 'effect'

/** One entry of a plan: a logical reference by `resourceType` and `identifier` resolves to `literalReference`. */
interface Entry {
  readonly resourceType: string
  readonly identifier: IdentifierAndReference.QualifiedIdentifierType
  readonly literalReference: string
}

/** A reference plan, built once by {@link of}. */
interface Type {
  /**
   * Every distinct literal reference the plan was given for each type and
   * identifier, by {@link typedIdentifierText}.
   */
  readonly literalReferencesByTypedIdentifier: Record.ReadonlyRecord<
    string,
    Arr.NonEmptyReadonlyArray<string>
  >
}

/**
 * How the plan spells a type and identifier: its `resourceType`, `system` and
 * `value` as JSON, so no separator inside a system or value can make two
 * spell alike. An identifier's other fields (`use`, `type`, `period`,
 * `assigner`, `extension`) do not name what it identifies, so they are left
 * out.
 */
const typedIdentifierText = (
  resourceType: string,
  { system, value }: IdentifierAndReference.QualifiedIdentifierType
): string => JSON.stringify([resourceType, system.href, value])

/**
 * The reference plan of `entries`.
 *
 * @remarks
 * Two entries for one type and identifier with different literal references
 * make it ambiguous: {@link literalReferenceFor} resolves it to nothing, so a
 * reference by it stays logical for the importer's identity map, as a FHIR
 * conditional reference matching several records is an error, except that it
 * fails nothing here. The same entry given twice is not ambiguous.
 */
const of = (entries: Iterable<Entry>): Type => ({
  literalReferencesByTypedIdentifier: Record.map(
    Arr.groupBy(entries, ({ resourceType, identifier }) =>
      typedIdentifierText(resourceType, identifier)
    ),
    (group) => Arr.dedupe(Arr.map(group, ({ literalReference }) => literalReference))
  ),
})

/**
 * `plan` with `entries` added, as {@link of} of the entries `plan` was built
 * from and `entries` would be.
 */
const extend = (plan: Type, entries: Iterable<Entry>): Type => ({
  literalReferencesByTypedIdentifier: Record.union(
    plan.literalReferencesByTypedIdentifier,
    of(entries).literalReferencesByTypedIdentifier,
    (held, added) => Arr.dedupe(Arr.appendAll(held, added))
  ),
})

/**
 * The literal reference a logical reference to `resourceType` by
 * `identifier` resolves to: `None` when `plan` holds no entry for them, or
 * several that disagree ({@link of}).
 *
 * @remarks
 * Matches on `resourceType`, `identifier.system` and `identifier.value`
 * alone.
 */
const literalReferenceFor = (
  plan: Type,
  resourceType: string,
  identifier: IdentifierAndReference.QualifiedIdentifierType
): Option.Option<string> =>
  pipe(
    Record.get(
      plan.literalReferencesByTypedIdentifier,
      typedIdentifierText(resourceType, identifier)
    ),
    Option.filter((literalReferences) => literalReferences.length === 1),
    Option.map(Arr.headNonEmpty)
  )

/**
 * Whether `plan` holds any entry for a logical reference to `resourceType` by
 * `identifier`: one, which {@link literalReferenceFor} resolves to, or
 * several that disagree, which it resolves to nothing.
 *
 * @remarks
 * Matches as {@link literalReferenceFor} does. The question the import stage
 * asks before implying a record a reference names: a record the set holds,
 * once or twice, is no record the set never saw.
 */
const holds = (
  plan: Type,
  resourceType: string,
  identifier: IdentifierAndReference.QualifiedIdentifierType
): boolean =>
  Record.has(plan.literalReferencesByTypedIdentifier, typedIdentifierText(resourceType, identifier))

/** What a logical reference names: an R4 resource type and a qualified identifier. */
interface LogicalTarget {
  readonly resourceType: ResourceType.Type
  readonly identifier: IdentifierAndReference.QualifiedIdentifierType
}

/**
 * What `reference` names when it is a logical reference: no literal, an R4
 * resource type as its `type`, an `identifier` with a `system` and a
 * `value`. `None` for a literal reference, an untyped or display-only one,
 * and one whose `type` names no R4 resource.
 */
const logicalTargetIfLogical = (reference: ReferenceType): Option.Option<LogicalTarget> => {
  const { identifier, type } = reference
  return reference.reference !== null ||
    type === null ||
    !ResourceType.is(type) ||
    identifier === null ||
    !IdentifierAndReference.isQualifiedIdentifier(identifier)
    ? Option.none()
    : Option.some({ resourceType: type, identifier })
}

/**
 * The literal reference `reference` resolves to under `plan`: `None` unless
 * it is a logical reference ({@link logicalTargetIfLogical}) that {@link
 * literalReferenceFor} resolves by its type and identifier.
 *
 * @remarks
 * As a FHIR server resolves a conditional reference against the transaction
 * bundle it processes. `adopt` writes what it gives; the import stage also
 * reads it to ask whether a reference names a record of the set.
 */
const literalReferenceIfResolved = (plan: Type, reference: ReferenceType): Option.Option<string> =>
  Option.flatMap(logicalTargetIfLogical(reference), ({ resourceType, identifier }) =>
    literalReferenceFor(plan, resourceType, identifier)
  )

export {
  extend,
  holds,
  literalReferenceFor,
  literalReferenceIfResolved,
  logicalTargetIfLogical,
  of,
  typedIdentifierText,
}
export type { Entry, LogicalTarget, Type }
