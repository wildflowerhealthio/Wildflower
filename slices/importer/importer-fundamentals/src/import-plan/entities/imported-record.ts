/**
 * An imported record: one record of an import, under its key, beside every
 * copy of it the import's file sets brought.
 *
 * @packageDocumentation
 */
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { IdentifierUnion } from '@wildflowerhealthio/fhir-r4/clients'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { groupInOrder } from '@wildflowerhealthio/kitchen-sink'
import { Array as Arr, Option, Order } from 'effect'

import * as ImportedCopy from './imported-copy.ts'
import type * as RecordKey from './record-key.ts'

/** One record's key beside every copy of it, in plan order. */
interface Type {
  readonly key: RecordKey.Type
  readonly copies: Arr.NonEmptyReadonlyArray<ImportedCopy.Type>
}

/**
 * The records `copies` are copies of, each where its first copy is, each
 * record's copies in the order of `copies`.
 */
const fromCopies = (copies: readonly ImportedCopy.Type[]): readonly Type[] =>
  groupInOrder(copies, ImportedCopy.recordKeyOf).map(({ key, items }): Type => ({
    key,
    copies: items,
  }))

/**
 * The copy that is the record: the last decoded copy in plan order, else,
 * when every copy is implied, the last one.
 *
 * @remarks
 * A decoded copy says more than one a reference implied. Among decoded copies
 * the last wins, as a transaction bundle keeps the last entry under one id.
 */
const recordCopyOf = ({ copies }: Type): ImportedCopy.Type =>
  Option.getOrElse(
    Arr.findLast(copies, (copy) => !copy.isImplied),
    () => Arr.lastNonEmpty(copies)
  )

/** The id the import stage gave the record: its record copy's ({@link recordCopyOf}). */
const stageIdOf = (record: Type): ImportedCopy.StageId => recordCopyOf(record).stageId

/** Whether every copy of the record is implied: no file decoded it, a reference only named it. */
const isImplied = (record: Type): boolean => recordCopyOf(record).isImplied

/**
 * The order records merge into one kept record in: decoded records
 * ({@link isImplied} false) before implied ones, so a sort keeping equal
 * records in place (`Array.sort` is stable) leaves each group in plan order.
 *
 * @remarks
 * A decoded record says more than one a reference implied, as a decoded
 * copy does ({@link recordCopyOf}), and an implied record is written only
 * when something written names it, so no merge a decoded record makes may
 * wait on one. Plan order itself does not change: only the order in which
 * the records merging into one kept record are merged.
 */
const mergeOrder: Order.Order<Type> = Order.mapInput(Order.boolean, isImplied)

/**
 * `values` in merge order ({@link mergeOrder}), each read as its record by
 * `recordOf`: decoded records first, implied ones after, each group in the
 * order `values` came in, which for values in plan order is plan order.
 */
const inMergeOrder = <A>(values: readonly A[], recordOf: (value: A) => Type): readonly A[] =>
  Arr.sort(values, Order.mapInput(mergeOrder, recordOf))

/** The title the plan shows the record under: its record copy's. */
const titleOf = (record: Type): string => recordCopyOf(record).title

/** The URL a source served the record at: its record copy's (`ImportedCopy.Type`'s `sourceUrl`). */
const sourceUrlOf = (record: Type): Option.Option<URL> => recordCopyOf(record).sourceUrl

/** The record's resource type: its record copy's. */
const resourceTypeOf = (record: Type): ResourceType.Type =>
  recordCopyOf(record).resource.resourceType

/** The literal reference to the record under `id`: `<Type>/<id>`. */
const literalReferenceUnder = (record: Type, id: string): string =>
  `${resourceTypeOf(record)}/${id}`

/**
 * The literal reference the import stage gives the record, `<Type>/<id>`
 * under its record copy's stage id ({@link stageIdOf}): how a format's hooks
 * and `meta.source` name it.
 *
 * @remarks
 * The copies of a record keyed by its source URL each have the id minted in
 * their own file set; the record is under its record copy's.
 */
const stageLiteralOf = (record: Type): string => ImportedCopy.stageLiteralOf(recordCopyOf(record))

/**
 * The literal reference a stored copy of the record from an earlier import
 * sits under ({@link stageLiteralOf}), when its record copy's stage id is
 * `Derived`.
 */
const literalReferenceIfDerived = (record: Type): Option.Option<string> =>
  Option.liftPredicate(stageLiteralOf(record), () =>
    ImportedCopy.hasDerivedStageId(recordCopyOf(record))
  )

/**
 * The record's key identifier: its record copy's
 * (`DetachedResource.keyIdentifierOf`); `None` when it has none.
 */
const keyIdentifierOf = (
  record: Type
): Option.Option<IdentifierAndReference.QualifiedIdentifierType> =>
  DetachedResource.keyIdentifierOf(recordCopyOf(record).resource)

/**
 * The record's resource: its record copy's ({@link recordCopyOf}), carrying
 * as well every qualified identifier another decoded copy carries and it
 * lacks, after its own (`IdentifierUnion.union`).
 */
const resourceOf = (record: Type): DetachedResource.Type => {
  const { resource } = recordCopyOf(record)
  return DetachedResource.hasIdentifier(resource)
    ? {
        ...resource,
        identifier: IdentifierUnion.union(
          resource.identifier,
          record.copies.filter((copy) => !copy.isImplied).map((copy) => copy.resource)
        ),
      }
    : resource
}

export {
  fromCopies,
  inMergeOrder,
  isImplied,
  literalReferenceIfDerived,
  literalReferenceUnder,
  keyIdentifierOf,
  mergeOrder,
  resourceOf,
  resourceTypeOf,
  sourceUrlOf,
  stageIdOf,
  stageLiteralOf,
  titleOf,
}
export type { Type }
