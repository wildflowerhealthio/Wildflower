/**
 * A reference plan: for each logical reference (`LogicalReference`), the
 * literal reference it resolves to.
 *
 * @remarks
 * A plain data structure. It holds the entries it is given and decides
 * nothing about which identifiers go in: that is its builder's policy (the
 * import stage's, for a file set). `adopt` reads it to resolve each
 * logical reference of the records it adopts.
 *
 * @packageDocumentation
 */
import type { ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'
import { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Option, pipe, Record } from 'effect'

/** One entry of a plan: `logicalReference` resolves to `literalReference`. */
interface Entry {
  readonly logicalReference: LogicalReference.Type
  readonly literalReference: string
}

/** A reference plan, built by {@link of}. */
interface Type {
  /**
   * Every distinct literal reference the plan was given for each logical
   * reference, by `LogicalReference.key`.
   */
  readonly literalReferencesByLogicalReference: Record.ReadonlyRecord<
    string,
    Arr.NonEmptyReadonlyArray<string>
  >
}

/**
 * The reference plan of `entries`.
 *
 * @remarks
 * Two entries for one logical reference with different literal references
 * make it ambiguous: {@link literalReferenceFor} resolves it to nothing, so a
 * reference by it stays logical for the importer's identity map, as a FHIR
 * conditional reference matching several records is an error, except that it
 * fails nothing here. The same entry given twice is not ambiguous.
 */
const of = (entries: Iterable<Entry>): Type => ({
  literalReferencesByLogicalReference: Record.map(
    Arr.groupBy(entries, ({ logicalReference }) => LogicalReference.key(logicalReference)),
    (group) => Arr.dedupe(Arr.map(group, ({ literalReference }) => literalReference))
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
  pipe(
    Record.get(plan.literalReferencesByLogicalReference, LogicalReference.key(logicalReference)),
    Option.filter((literalReferences) => literalReferences.length === 1),
    Option.map(Arr.headNonEmpty)
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
 * The literal reference `reference` resolves to under `plan`: `None` unless
 * it is a logical reference (`LogicalReference.tryFromReference`) that
 * {@link literalReferenceFor} resolves.
 *
 * @remarks
 * As a FHIR server resolves a conditional reference against the transaction
 * bundle it processes. `adopt` writes what it gives; the import stage also
 * reads it to ask whether a reference names a record of the set.
 */
const literalReferenceIfResolved = (plan: Type, reference: ReferenceType): Option.Option<string> =>
  Option.flatMap(LogicalReference.tryFromReference(reference), (logicalReference) =>
    literalReferenceFor(plan, logicalReference)
  )

export { holds, literalReferenceFor, literalReferenceIfResolved, of }
export type { Entry, Type }
