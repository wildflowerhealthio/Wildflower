/**
 * A reference plan: for each resource type and qualified identifier, the
 * literal reference a logical reference by them resolves to; and for each
 * absolute `fullUrl`, the literal reference a literal reference or an
 * `Attachment.url` spelling it resolves to.
 *
 * @remarks
 * A plain data structure. It holds the entries it is given and decides
 * nothing about which identifiers or `fullUrl`s go in: that is its builder's
 * policy (the import stage's, for a file set). `adopt` reads it to resolve
 * each reference and attachment URL of the records it adopts.
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

/**
 * One `fullUrl` entry of a plan: a literal reference or an `Attachment.url`
 * spelling `fullUrl` resolves to `literalReference`.
 *
 * @remarks
 * How a record with no identifier to name it by is still named, as a FHIR
 * transaction bundle names an entry by `Bundle.entry.fullUrl`: a `Binary` a
 * FHIR server served, by the server's URL for it.
 */
interface FullUrlEntry {
  readonly fullUrl: URL
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
  /** Every distinct literal reference the plan was given for each `fullUrl`, by its `href`. */
  readonly literalReferencesByFullUrl: Record.ReadonlyRecord<
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

/** Each group's distinct literal references, in the order they were given. */
const distinctLiteralReferences = (
  groups: Record.ReadonlyRecord<
    string,
    Arr.NonEmptyReadonlyArray<{ readonly literalReference: string }>
  >
): Record.ReadonlyRecord<string, Arr.NonEmptyReadonlyArray<string>> =>
  Record.map(groups, (group) =>
    Arr.dedupe(Arr.map(group, ({ literalReference }) => literalReference))
  )

/**
 * The reference plan of `entries` and `fullUrlEntries`.
 *
 * @remarks
 * Two entries for one type and identifier, or for one `fullUrl`, with
 * different literal references make it ambiguous: the plan resolves it to
 * nothing, so a reference by it stays as it is, as a FHIR conditional
 * reference matching several records is an error, except that it fails
 * nothing here. The same entry given twice is not ambiguous.
 */
const of = (entries: Iterable<Entry>, fullUrlEntries: Iterable<FullUrlEntry>): Type => ({
  literalReferencesByTypedIdentifier: distinctLiteralReferences(
    Arr.groupBy(entries, ({ resourceType, identifier }) =>
      typedIdentifierText(resourceType, identifier)
    )
  ),
  literalReferencesByFullUrl: distinctLiteralReferences(
    Arr.groupBy(fullUrlEntries, ({ fullUrl }) => fullUrl.href)
  ),
})

/** The one literal reference of `literalReferences`, `None` for none or several. */
const unambiguous = (
  literalReferences: Option.Option<Arr.NonEmptyReadonlyArray<string>>
): Option.Option<string> =>
  pipe(
    literalReferences,
    Option.filter((distinct) => distinct.length === 1),
    Option.map(Arr.headNonEmpty)
  )

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
  unambiguous(
    Record.get(
      plan.literalReferencesByTypedIdentifier,
      typedIdentifierText(resourceType, identifier)
    )
  )

/**
 * The literal reference `url` resolves to as a `fullUrl`: `None` when it is
 * not an absolute URL, or `plan` holds no entry for it, or several that
 * disagree ({@link of}).
 *
 * @remarks
 * Matches on the URL's `href`, so two spellings of one absolute URL (a host
 * in capitals, a default port) are one `fullUrl`. A relative URL resolves to
 * nothing: a `fullUrl` is absolute, and nothing here knows a base to resolve
 * one against.
 */
const literalReferenceForFullUrl = (plan: Type, url: string): Option.Option<string> =>
  pipe(
    Option.fromNullable(URL.parse(url)),
    Option.flatMap(({ href }) => unambiguous(Record.get(plan.literalReferencesByFullUrl, href)))
  )

/**
 * The literal reference `reference` resolves to under `plan`: for a literal
 * reference, what {@link literalReferenceForFullUrl} resolves its literal
 * to; otherwise `None` unless it is a logical reference (an R4 resource type
 * as its `type`, an `identifier` with a `system` and a `value`) that {@link
 * literalReferenceFor} resolves by its type and identifier.
 *
 * @remarks
 * As a FHIR server resolves a transaction bundle's references against the
 * bundle it processes: a literal one by an entry's `fullUrl`, a conditional
 * one by a match. `adopt` writes what it gives; the import stage also reads
 * it to ask whether a reference names a record of the set.
 */
const literalReferenceIfResolved = (
  plan: Type,
  reference: ReferenceType
): Option.Option<string> => {
  const { identifier, type } = reference
  if (reference.reference !== null) {
    return literalReferenceForFullUrl(plan, reference.reference)
  }
  return type === null ||
    !ResourceType.is(type) ||
    identifier === null ||
    !IdentifierAndReference.isQualifiedIdentifier(identifier)
    ? Option.none()
    : literalReferenceFor(plan, type, identifier)
}

export { literalReferenceFor, literalReferenceForFullUrl, literalReferenceIfResolved, of }
export type { Entry, FullUrlEntry, Type }
