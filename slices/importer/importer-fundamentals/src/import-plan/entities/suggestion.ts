/**
 * A suggestion: the choice the import plan defaults one record to, and why.
 *
 * @packageDocumentation
 */
import { Data, type Option } from 'effect'

import type * as RecordChoice from './record-choice.ts'

/**
 * Why a record is suggested what it is: one reason per rule of
 * `suggestRecord`, in the order the rules are tried.
 *
 * @remarks
 * - `SeveralIdentifierMatches`: several stored records are the record:
 *   several carry its identifiers, or one does and another sits under the id
 *   the import stage derived for it.
 * - `OneIdentifierMatch`: one stored record is the record, and the record
 *   merges into it.
 * - `NoMatch`: nothing stored is the record, or only `possible` matches by
 *   name are.
 * - `NameMatchReferenced`: stored records match it by name, and other
 *   imported records reference it.
 * - `NameMatchNotReferenced`: stored records match it by name, and no other
 *   imported record references it.
 *
 * A stored record is the record when it is one of its stored copies
 * (`StoredMatch.storedCopiesOf`): found by identifier or, for both
 * identifier reasons, sitting under the id the import stage derived for the
 * record, which counts as an identifier match as well until #1467. Whether
 * the import's fields differ from the stored record's is no part of the
 * reason: it is read from `differencesOf`.
 */
type Reason = Data.TaggedEnum<{
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  SeveralIdentifierMatches: Record<never, never>
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  OneIdentifierMatch: Record<never, never>
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  NoMatch: Record<never, never>
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  NameMatchReferenced: Record<never, never>
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  NameMatchNotReferenced: Record<never, never>
}>

const {
  SeveralIdentifierMatches,
  OneIdentifierMatch,
  NoMatch,
  NameMatchReferenced,
  NameMatchNotReferenced,
} = Data.taggedEnum<Reason>()

/** The choice a record defaults to, `None` when it is left undecided, and why. */
interface Type {
  readonly choice: Option.Option<RecordChoice.Type>
  readonly reason: Reason
}

/** The suggestion of `choice`, `None` to leave the record undecided, for `reason`. */
const make = (choice: Option.Option<RecordChoice.Type>, reason: Reason): Type => ({
  choice,
  reason,
})

/** Whether a record suggested for `reason` is listed under Needs a decision. */
const needsDecision = (reason: Reason): boolean =>
  reason._tag === 'NameMatchReferenced' || reason._tag === 'SeveralIdentifierMatches'

export {
  make,
  NameMatchNotReferenced,
  NameMatchReferenced,
  needsDecision,
  NoMatch,
  OneIdentifierMatch,
  SeveralIdentifierMatches,
}
export type { Reason, Type }
