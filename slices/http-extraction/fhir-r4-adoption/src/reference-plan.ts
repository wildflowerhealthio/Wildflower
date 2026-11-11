/**
 * A reference plan: for each logical reference (`LogicalReference`), the
 * literal reference it resolves to; and for each source URL, the literal
 * reference a literal reference or an `Attachment.url` spelling it resolves
 * to.
 *
 * @remarks
 * A plain data structure. It holds the entries it is given and decides
 * nothing about which identifiers or source URLs go in: that is its
 * builder's policy (the import stage's, for a file set). `adopt` resolves
 * each reference of the records it adopts through its rewrite
 * ({@link toRewrite}), and each attachment URL through
 * {@link literalReferenceForSourceUrl}.
 *
 * @packageDocumentation
 */
import type { ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'
import { LogicalReference, ReferenceRewrite } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Context, Option, pipe, Record } from 'effect'

/** One entry of a plan: `logicalReference` resolves to `literalReference`. */
interface Entry {
  readonly logicalReference: LogicalReference.Type
  readonly literalReference: string
}

/**
 * One source URL entry of a plan: a literal reference or an `Attachment.url`
 * spelling `sourceUrl` resolves to `literalReference`.
 *
 * @remarks
 * How a record with no identifier to name it by is still named, as a FHIR
 * transaction bundle names an entry by `Bundle.entry.fullUrl`: a `Binary` a
 * FHIR server served, by the server's URL for it.
 */
interface SourceUrlEntry {
  readonly sourceUrl: URL
  readonly literalReference: string
}

/** A reference plan, built by {@link of}. */
interface Type {
  /**
   * Every distinct literal reference the plan was given for each logical
   * reference, by `LogicalReference.key`.
   */
  readonly literalReferencesByLogicalReference: Record.ReadonlyRecord<
    LogicalReference.Key,
    Arr.NonEmptyReadonlyArray<string>
  >
  /** Every distinct literal reference the plan was given for each source URL, by its `href`. */
  readonly literalReferencesBySourceUrl: Record.ReadonlyRecord<
    string,
    Arr.NonEmptyReadonlyArray<string>
  >
}

/** Each group's distinct literal references, in the order they were given. */
const distinctLiteralReferences = <TKey extends string>(
  groups: Record.ReadonlyRecord<
    TKey,
    Arr.NonEmptyReadonlyArray<{ readonly literalReference: string }>
  >
): Record.ReadonlyRecord<TKey, Arr.NonEmptyReadonlyArray<string>> =>
  Record.map(groups, (group) =>
    Arr.dedupe(Arr.map(group, ({ literalReference }) => literalReference))
  )

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
 * The reference plan of `entries` and `sourceUrlEntries`.
 *
 * @remarks
 * Two entries for one logical reference, or for one source URL, with
 * different literal references make it ambiguous: the plan resolves it to
 * nothing, so a reference by it stays as it is (a logical one for the
 * importer's identity map), as a FHIR conditional reference matching several
 * records is an error, except that it fails nothing here. The same entry
 * given twice is not ambiguous.
 */
const of = (entries: Iterable<Entry>, sourceUrlEntries: Iterable<SourceUrlEntry>): Type => ({
  literalReferencesByLogicalReference: distinctLiteralReferences(
    Arr.groupBy(entries, ({ logicalReference }) => LogicalReference.key(logicalReference))
  ),
  literalReferencesBySourceUrl: distinctLiteralReferences(
    Arr.groupBy(sourceUrlEntries, ({ sourceUrl }) => sourceUrl.href)
  ),
})

/**
 * The literal reference `logicalReference` resolves to: `None` when `plan`
 * holds no entry for it, or several that disagree ({@link of}).
 *
 * @remarks
 * Matches on the type, `system` and `value` alone (`LogicalReference.key`).
 */
const literalReferenceFor = (
  plan: Type,
  logicalReference: LogicalReference.Type
): Option.Option<string> =>
  unambiguous(
    Record.get(plan.literalReferencesByLogicalReference, LogicalReference.key(logicalReference))
  )

/**
 * The literal reference `url` resolves to as a source URL: `None` when it is
 * not an absolute URL, or `plan` holds no entry for it, or several that
 * disagree ({@link of}).
 *
 * @remarks
 * Matches on the URL's `href`, so two spellings of one absolute URL (a host
 * in capitals, a default port) are one source URL. A relative URL resolves
 * to nothing: nothing here knows a base to resolve one against. A plan
 * holding no source URL (a set with no `Binary`, which is most of them)
 * parses nothing.
 */
const literalReferenceForSourceUrl = (plan: Type, url: string): Option.Option<string> =>
  Record.isEmptyRecord(plan.literalReferencesBySourceUrl)
    ? Option.none()
    : pipe(
        Option.fromNullable(URL.parse(url)),
        Option.flatMap(({ href }) =>
          unambiguous(Record.get(plan.literalReferencesBySourceUrl, href))
        )
      )

/**
 * Whether `plan` holds any entry for `logicalReference`: one, which
 * {@link literalReferenceFor} resolves to, or several that disagree, which
 * it resolves to nothing.
 *
 * @remarks
 * Matches as {@link literalReferenceFor} does. The question the import stage
 * asks before implying a record a reference names: a record the set holds,
 * once or twice, is no record the set never saw.
 */
const holds = (plan: Type, logicalReference: LogicalReference.Type): boolean =>
  Record.has(plan.literalReferencesByLogicalReference, LogicalReference.key(logicalReference))

/**
 * The literal reference `reference` resolves to under `plan`: for a literal
 * reference, what {@link literalReferenceForSourceUrl} resolves its literal
 * to; otherwise `None` unless it is a logical reference
 * (`LogicalReference.tryFromReference`) that {@link literalReferenceFor}
 * resolves.
 *
 * @remarks
 * As a FHIR server resolves a transaction bundle's references against the
 * bundle it processes: a literal one by an entry's `fullUrl`, a conditional
 * one by a match. `adopt` writes what it gives; the import stage also reads
 * it to ask whether a reference names a record of the set.
 */
const literalReferenceIfResolved = (plan: Type, reference: ReferenceType): Option.Option<string> =>
  reference.reference === null
    ? Option.flatMap(LogicalReference.tryFromReference(reference), (logicalReference) =>
        literalReferenceFor(plan, logicalReference)
      )
    : literalReferenceForSourceUrl(plan, reference.reference)

/**
 * The reference plan the records being adopted resolve by: built once for a
 * file set, then read, never changed, by every step of its adoption.
 */
class InForce extends Context.Tag('fhir-r4-adoption/ReferencePlan.InForce')<InForce, Type>() {}

/**
 * `plan` as a reference rewrite: each reference it resolves
 * ({@link literalReferenceIfResolved}) pointed at its literal reference,
 * every other reference left as it is.
 */
const toRewrite = (plan: Type): ReferenceRewrite.Type =>
  ReferenceRewrite.fromLookup((reference) => literalReferenceIfResolved(plan, reference))

export {
  holds,
  InForce,
  literalReferenceFor,
  literalReferenceForSourceUrl,
  literalReferenceIfResolved,
  of,
  toRewrite,
}
export type { Entry, SourceUrlEntry, Type }
