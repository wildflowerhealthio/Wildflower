/**
 * A suggestion: the choice the import plan defaults one record to, and why.
 *
 * @packageDocumentation
 */
import { Data, type Option } from 'effect'

import type * as OfferedFields from './offered-fields.ts'
import type * as RecordChoice from './record-choice.ts'

/**
 * Why a record is suggested what it is.
 *
 * @remarks
 * - `IdentifierMatchSameAsExisting`: one stored record is the record, and
 *   the import offers it no field.
 * - `IdentifierMatchFieldsDiffer`: one stored record is the record, and the
 *   import offers it fields.
 * - `NoMatch`: nothing stored is the record, or only `possible` matches by
 *   name are.
 * - `NotReferenced`: stored records match it by name, and no other imported
 *   record references it.
 * - `NameMatchReferenced`: stored records match it by name, and other
 *   imported records reference it.
 * - `SeveralIdentifierMatches`: several stored records carry its identifiers.
 *
 * Both identifier-match reasons carry what the import offers the stored
 * record. A stored record is the record when it is the only one found by
 * identifier, or, when none is, the one stored under the id its key derives.
 */
type Reason = Data.TaggedEnum<{
  IdentifierMatchSameAsExisting: { readonly offeredFields: OfferedFields.Type }
  IdentifierMatchFieldsDiffer: { readonly offeredFields: OfferedFields.Type }
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  NoMatch: Record<never, never>
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  NotReferenced: Record<never, never>
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  NameMatchReferenced: Record<never, never>
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  SeveralIdentifierMatches: Record<never, never>
}>

const {
  IdentifierMatchSameAsExisting,
  IdentifierMatchFieldsDiffer,
  NoMatch,
  NotReferenced,
  NameMatchReferenced,
  SeveralIdentifierMatches,
} = Data.taggedEnum<Reason>()

/** The choice a record defaults to, `None` when it is left undecided, and why. */
interface Type {
  readonly choice: Option.Option<RecordChoice.Type>
  readonly reason: Reason
}

/** Whether a record suggested for `reason` is listed under Needs a decision. */
const needsDecision = (reason: Reason): boolean =>
  reason._tag === 'NameMatchReferenced' || reason._tag === 'SeveralIdentifierMatches'

export {
  IdentifierMatchFieldsDiffer,
  IdentifierMatchSameAsExisting,
  NameMatchReferenced,
  needsDecision,
  NoMatch,
  NotReferenced,
  SeveralIdentifierMatches,
}
export type { Reason, Type }
