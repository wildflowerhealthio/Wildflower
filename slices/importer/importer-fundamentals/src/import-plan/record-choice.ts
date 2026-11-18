/**
 * A record choice: what the import does with one record.
 *
 * @packageDocumentation
 */
import { type FhirResourceWithId, literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import { Data, Equal, type Equivalence, HashSet } from 'effect'

/**
 * Use an existing record, taking `fieldsTaken` from the import, save the
 * record as a new one, or don't add it.
 *
 * @remarks
 * `fieldsTaken` holds top-level FHIR field names. The import's identifiers
 * are always added to the existing record's, so `identifier` is never one.
 * A use-existing choice that takes nothing links to the existing record.
 */
type Type = Data.TaggedEnum<{
  UseExistingRecord: {
    readonly existing: FhirResourceWithId
    readonly fieldsTaken: HashSet.HashSet<string>
  }
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  SaveAsNewRecord: Record<never, never>
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  DontAdd: Record<never, never>
}>

const {
  UseExistingRecord,
  SaveAsNewRecord,
  DontAdd,
  $is: is,
  $match: match,
} = Data.taggedEnum<Type>()

/** Whether `choice` uses an existing record and takes none of the import's fields. */
const takesNothing = (choice: Type): boolean =>
  is('UseExistingRecord')(choice) && HashSet.size(choice.fieldsTaken) === 0

/**
 * Two choices are one when they have one tag and, for a use-existing choice,
 * name one stored record (by literal reference) and take the same fields.
 */
const equivalence: Equivalence.Equivalence<Type> = (left, right) =>
  is('UseExistingRecord')(left) && is('UseExistingRecord')(right)
    ? literalReferenceOf(left.existing) === literalReferenceOf(right.existing) &&
      Equal.equals(left.fieldsTaken, right.fieldsTaken)
    : left._tag === right._tag

export { DontAdd, equivalence, is, match, SaveAsNewRecord, takesNothing, UseExistingRecord }
export type { Type }
