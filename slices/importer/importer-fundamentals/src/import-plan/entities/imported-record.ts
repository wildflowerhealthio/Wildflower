/**
 * An imported record: one record of an import, under its key, beside every
 * copy of it the import's file sets brought.
 *
 * @packageDocumentation
 */
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { IdentifierUnion } from '@wildflowerhealthio/fhir-r4/clients'
import type { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, HashMap, Option, Order, pipe } from 'effect'

import * as ImportedCopy from './imported-copy.ts'
import * as RecordKey from './record-key.ts'

/** One record's key beside every copy of it, in plan order. */
interface Type {
  readonly key: RecordKey.Type
  readonly copies: Arr.NonEmptyReadonlyArray<ImportedCopy.Type>
}

/** One record's copies so far, beside the position of its first copy. */
interface Group {
  readonly firstPosition: number
  readonly copies: Arr.NonEmptyReadonlyArray<ImportedCopy.Type>
}

/** The group `copy` at `position` joins: a new one, or `existing` with it appended. */
const withCopy = (
  existing: Option.Option<Group>,
  copy: ImportedCopy.Type,
  position: number
): Group =>
  Option.match(existing, {
    onNone: (): Group => ({ firstPosition: position, copies: Arr.of(copy) }),
    onSome: (group): Group => ({ ...group, copies: Arr.append(group.copies, copy) }),
  })

/** Groups in the order of their first copies. */
const byFirstPosition = Order.mapInput(
  Order.number,
  ([, { firstPosition }]: readonly [RecordKey.Type, Group]) => firstPosition
)

/**
 * The records `copies` are copies of, each where its first copy is, each
 * record's copies in the order of `copies`.
 */
const fromCopies = (copies: readonly ImportedCopy.Type[]): readonly Type[] =>
  pipe(
    Arr.reduce(copies, HashMap.empty<RecordKey.Type, Group>(), (grouped, copy, position) =>
      HashMap.modifyAt(grouped, ImportedCopy.recordKeyOf(copy), (existing) =>
        Option.some(withCopy(existing, copy, position))
      )
    ),
    HashMap.toEntries,
    Arr.sortBy(byFirstPosition),
    Arr.map(([key, { copies: grouped }]): Type => ({ key, copies: grouped }))
  )

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

/** The title the plan shows the record under: its record copy's. */
const titleOf = (record: Type): string => recordCopyOf(record).title

/** The URL a source served the record at: its record copy's (`ImportedCopy.Type`'s `sourceUrl`). */
const sourceUrlOf = (record: Type): Option.Option<URL> => recordCopyOf(record).sourceUrl

/** The literal reference to the record under `id`: `<Type>/<id>`. */
const literalReferenceUnder = (record: Type, id: string): string =>
  `${recordCopyOf(record).resource.resourceType}/${id}`

/**
 * The literal reference the import stage gives the record, under its stage
 * id ({@link stageIdOf}): how a format's hooks and `meta.source` name it.
 */
const stageLiteralOf = (record: Type): string => literalReferenceUnder(record, stageIdOf(record).id)

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
 * The logical reference the record is keyed by: its record copy's
 * (`RecordKey.logicalReferenceIfKeyed`); `None` when it is keyless.
 */
const logicalReferenceIfKeyed = (record: Type): Option.Option<LogicalReference.Type> =>
  RecordKey.logicalReferenceIfKeyed(recordCopyOf(record).resource)

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
  isImplied,
  literalReferenceIfDerived,
  literalReferenceUnder,
  logicalReferenceIfKeyed,
  resourceOf,
  sourceUrlOf,
  stageIdOf,
  stageLiteralOf,
  titleOf,
}
export type { Type }
