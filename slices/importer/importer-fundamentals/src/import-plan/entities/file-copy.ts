/**
 * A file copy: one copy of a record, as one file set of an import brought it.
 *
 * @packageDocumentation
 */
import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { Array as Arr, HashMap, Option } from 'effect'

import type * as PickedFile from '../../picked-file.ts'
import * as RecordKey from './record-key.ts'

/**
 * One copy of a record, from one file set: the record as that set holds it
 * before anything is chosen, detached, beside where it came from and how the
 * plan shows it.
 *
 * @remarks
 * `derivedId` is the id a stored copy of the record from an earlier import
 * sits under: a keyed record's id derived from its key, or a source file's id
 * derived from its content. `None` for a keyless decoded record, whose id is
 * minted anew on every import.
 */
interface Type {
  /** The format that decoded the file set. */
  readonly format: string
  /** The file set's picked files, in pick order. */
  readonly pickedFiles: Arr.NonEmptyReadonlyArray<PickedFile.Type>
  /** The copy's review key, unique within its format. */
  readonly reviewKey: string
  /** The title the plan shows the copy under. */
  readonly title: string
  /** Whether the import built the record from a reference to it (`ReviewRow.Type`'s `isImplied`). */
  readonly isImplied: boolean
  readonly resource: DetachedResource.Type
  /** The URL a source served the record at (`FileSetRecord.Type`'s `sourceUrl`). */
  readonly sourceUrl: Option.Option<URL>
  readonly derivedId: Option.Option<string>
}

/** One record's key beside every copy of it, in plan order: the first is the record. */
interface RecordCopies {
  readonly key: RecordKey.Type
  readonly copies: Arr.NonEmptyReadonlyArray<Type>
}

/** The key of the record `copy` is a copy of (`RecordKey.make`). */
const recordKeyOf = (copy: Type): RecordKey.Type => RecordKey.make(copy.resource, copy.reviewKey)

/** One record's copies so far, beside the position of its first copy. */
interface Group {
  readonly firstPosition: number
  readonly copies: Arr.NonEmptyReadonlyArray<Type>
}

/**
 * `copies` grouped by the record each is a copy of, each record where its
 * first copy is, each record's copies in the order of `copies`.
 */
const groupByRecord = (copies: readonly Type[]): readonly RecordCopies[] => {
  const keyed = copies.map((copy, position) => ({ key: recordKeyOf(copy), copy, position }))
  const groups = Arr.reduce(
    keyed,
    HashMap.empty<RecordKey.Type, Group>(),
    (grouped, { key, copy, position }) =>
      HashMap.set(
        grouped,
        key,
        Option.match(HashMap.get(grouped, key), {
          onNone: (): Group => ({ firstPosition: position, copies: Arr.of(copy) }),
          onSome: (group): Group => ({ ...group, copies: Arr.append(group.copies, copy) }),
        })
      )
  )
  return Arr.filterMap(keyed, ({ key, position }) =>
    HashMap.get(groups, key).pipe(
      Option.filter((group) => group.firstPosition === position),
      Option.map((group) => ({ key, copies: group.copies }))
    )
  )
}

export { groupByRecord, recordKeyOf }
export type { RecordCopies, Type }
