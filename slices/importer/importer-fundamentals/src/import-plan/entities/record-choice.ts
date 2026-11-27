/**
 * A record choice: what the import does with one record.
 *
 * @packageDocumentation
 */
import { type FhirResourceWithId, sameStoredResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Data, Equal, type Equivalence, HashSet } from 'effect'

import * as Difference from './difference.ts'

/**
 * Merge the record into an existing record, taking `fieldsTaken` from the
 * import, save the record as a new one, or don't add it.
 *
 * @remarks
 * A merge is an imported record going into a record that is kept: the kept
 * record keeps its id, the imported record's identifiers are added to it,
 * and references to the imported record land on it. Identity always merges;
 * content merges only by the fields taken. `fieldsTaken` holds top-level
 * FHIR field names, so `identifier` is never one. A merge that takes no
 * field links to the existing record, unless the reviewer edits the record.
 */
type Type = Data.TaggedEnum<{
  MergeIntoExistingRecord: {
    readonly existing: FhirResourceWithId
    readonly fieldsTaken: HashSet.HashSet<string>
  }
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  SaveAsNewRecord: Record<never, never>
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  DontAdd: Record<never, never>
}>

const { MergeIntoExistingRecord, SaveAsNewRecord, DontAdd, $is: is } = Data.taggedEnum<Type>()

/**
 * Merge into `existing`, taking the field of every one of `differences`,
 * whether it fills a gap or overwrites a value.
 */
const mergeTakingEveryField = (
  existing: FhirResourceWithId,
  differences: readonly Difference.Type[]
): Type =>
  MergeIntoExistingRecord({
    existing,
    fieldsTaken: HashSet.fromIterable(differences.map(({ field }) => field)),
  })

/** Merge into `existing`, taking the fields of those of `differences` that fill one of its gaps. */
const mergeFillingGaps = (
  existing: FhirResourceWithId,
  differences: readonly Difference.Type[]
): Type => mergeTakingEveryField(existing, differences.filter(Difference.is('FillsGap')))

/** Merge into `existing`, taking none of the import's fields: a link, unless the reviewer edits the record. */
const mergeTakingNoField = (existing: FhirResourceWithId): Type =>
  MergeIntoExistingRecord({ existing, fieldsTaken: HashSet.empty() })

/** Whether `choice` merges into an existing record and takes none of the import's fields. */
const takesNoField = (choice: Type): boolean =>
  is('MergeIntoExistingRecord')(choice) && HashSet.size(choice.fieldsTaken) === 0

/**
 * Two choices are one when they have one tag and, for a merge into an
 * existing record, name one stored record (by literal reference) and take
 * the same fields.
 */
const equivalence: Equivalence.Equivalence<Type> = (left, right) =>
  is('MergeIntoExistingRecord')(left) && is('MergeIntoExistingRecord')(right)
    ? sameStoredResource(left.existing, right.existing) &&
      Equal.equals(left.fieldsTaken, right.fieldsTaken)
    : left._tag === right._tag

export {
  DontAdd,
  equivalence,
  is,
  MergeIntoExistingRecord,
  mergeFillingGaps,
  mergeTakingEveryField,
  mergeTakingNoField,
  SaveAsNewRecord,
  takesNoField,
}
export type { Type }
