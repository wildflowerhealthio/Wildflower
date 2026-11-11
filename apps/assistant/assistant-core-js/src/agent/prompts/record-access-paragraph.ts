import { Array, Match, Option } from 'effect'

import type * as RecordAccess from '../record-access.ts'

/**
 * The system prompt's paragraph on what the grant lets the assistant do
 * with the record.
 *
 * @remarks
 * A namespace module: `RecordAccessParagraph.of`.
 *
 * @packageDocumentation
 */

/** The types the assistant can read either way, by id or by search. */
const readableOrSearchableOf = (access: RecordAccess.Type): RecordAccess.ResourceTypes =>
  access.readable.kind === 'every-type' || access.searchable.kind === 'every-type'
    ? { kind: 'every-type' }
    : {
        kind: 'named-types',
        types: Array.union(access.readable.types, access.searchable.types).toSorted(),
      }

/** That the assistant can `verb` records of `resourceTypes`, in a sentence; `None` when it can't for any type. */
const writeSentenceOf = (
  resourceTypes: RecordAccess.ResourceTypes,
  verb: string
): Option.Option<string> =>
  Match.value(resourceTypes).pipe(
    Match.when({ kind: 'every-type' }, () => Option.some(`You can ${verb} records of every type.`)),
    Match.when({ kind: 'named-types' }, ({ types }) =>
      Array.isNonEmptyReadonlyArray(types)
        ? Option.some(`You can ${verb} records of these types and no others: ${types.join(', ')}.`)
        : Option.none()
    ),
    Match.exhaustive
  )

/** How every write goes, in words: confirmed by the person first, and never a delete. */
const WRITES_SENTENCES =
  "Every record you create or change is shown to the person first, and saved only if they approve it. Records are never deleted: to retract one entered by mistake, change its status to entered-in-error (or the type's equivalent) with update_record."

/**
 * What the assistant can do with the record, in words, for the system
 * prompt: the types it can read, the types it can create and change, and,
 * when it can write at all, that each write is confirmed by the person and
 * that a mistaken record is marked entered-in-error rather than deleted.
 */
const of = (access: RecordAccess.Type): string => {
  const readSentence = Match.value(readableOrSearchableOf(access)).pipe(
    Match.when({ kind: 'every-type' }, () => 'You can read every record type.'),
    Match.when({ kind: 'named-types' }, ({ types }) =>
      types.length === 0
        ? "You can't read any records: the person didn't grant this app access to them. If they ask about their record, say so, and help with what they tell you."
        : `You can read these record types and no others: ${types.join(', ')}.`
    ),
    Match.exhaustive
  )
  const createSentence = writeSentenceOf(access.creatable, 'create')
  const changeSentence = writeSentenceOf(access.updatable, 'change')
  const writeSentences =
    Option.isNone(createSentence) && Option.isNone(changeSentence)
      ? ["You can't create or change records."]
      : [
          Option.getOrElse(createSentence, () => "You can't create records."),
          Option.getOrElse(changeSentence, () => "You can't change existing records."),
          WRITES_SENTENCES,
        ]
  return [readSentence, ...writeSentences].join(' ')
}

export { of }
