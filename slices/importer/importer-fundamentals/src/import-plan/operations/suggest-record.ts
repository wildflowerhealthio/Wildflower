/**
 * Suggest a record: the five rules that choose the suggestion one record of
 * an import plan defaults to.
 *
 * @packageDocumentation
 */
import { MatchGrade, type ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import type { FhirResource, FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { onlyElement } from '@wildflowerhealthio/kitchen-sink'
import { Option } from 'effect'

import type * as Difference from '../entities/difference.ts'
import * as KeptRecords from '../entities/kept-records.ts'
import * as RecordChoice from '../entities/record-choice.ts'
import * as StoredMatch from '../entities/stored-match.ts'
import * as Suggestion from '../entities/suggestion.ts'
import type * as ComparableReferences from './differences-of/comparable-references.ts'
import { differencesOf } from './differences-of/differences-of.ts'

/** The facts a record's suggestion is read from. */
interface SuggestionFacts {
  /** The record's resource (`ImportedRecord.resourceOf`). */
  readonly resource: FhirResource
  /** What the store holds of it. */
  readonly storedMatch: StoredMatch.Entry
  /** Whether another imported record references it. */
  readonly isReferenced: boolean
  /**
   * Each kept record the records ahead of this one in merge order merge
   * into, with their merges, by the kept record's literal reference.
   */
  readonly mergedSoFar: KeptRecords.Type
  /** How the import's and the stored records' references are compared. */
  readonly comparableReferences: ComparableReferences.Type
}

/**
 * The stored records matching by name with a grade that may not need more
 * review (`MatchGrade.mayNotNeedAdditionalReview`). A `possible` match never
 * counts.
 */
const countedNameMatches = (
  candidates: readonly ResourceMatch.Candidate[]
): readonly FhirResourceWithId[] =>
  candidates
    .filter(({ by, grade }) => by === 'name' && MatchGrade.mayNotNeedAdditionalReview(grade))
    .map(({ resource }) => resource)

/**
 * The differences of `facts.resource` from `existing` as merged once the
 * records ahead of it merged into it (`KeptRecords.asMergedIn`).
 */
const differencesFor = (
  facts: SuggestionFacts,
  existing: FhirResourceWithId
): readonly Difference.Type[] =>
  differencesOf(
    facts.resource,
    KeptRecords.asMergedIn(facts.mergedSoFar, existing),
    facts.comparableReferences
  )

/** Merge into `existing`, the stored record that is the record, taking only the fields that fill a gap. */
const suggestIdentifierMatch = (
  facts: SuggestionFacts,
  existing: FhirResourceWithId
): Suggestion.Type =>
  Suggestion.make(
    Option.some(RecordChoice.mergeFillingGaps(existing, differencesFor(facts, existing))),
    Suggestion.OneIdentifierMatch()
  )

/** Needs a decision: the one name match pre-selected, taking only gap-filling fields; several leave it undecided. */
const suggestNameMatchReferenced = (
  facts: SuggestionFacts,
  nameMatches: readonly FhirResourceWithId[]
): Suggestion.Type =>
  Suggestion.make(
    Option.map(onlyElement(nameMatches), (existing) =>
      RecordChoice.mergeFillingGaps(existing, differencesFor(facts, existing))
    ),
    Suggestion.NameMatchReferenced()
  )

/** Save the record as a new one, for `reason`. */
const saveAsNew = (reason: Suggestion.Reason): Suggestion.Type =>
  Suggestion.make(Option.some(RecordChoice.SaveAsNewRecord()), reason)

/**
 * The suggestion for one record, from its stored copies
 * (`StoredMatch.storedCopiesOf`):
 *
 * 1. Several stored copies: Needs a decision, undecided, whether or not
 *    anything references it. That is several stored records found by
 *    identifier, or one found by identifier and another under the id the
 *    import stage derived for it.
 * 2. One stored copy: merge into it, taking the fields that fill a gap (none
 *    when no difference fills one).
 * 3. No name match that may not need more review: save as new (no match).
 *    Only `possible` matches count as none.
 * 4. Name matches, and another imported record references it: Needs a
 *    decision, the one match pre-selected, undecided when there are several.
 * 5. Name matches, and nothing references it: save as new (name match not
 *    referenced).
 */
const suggestRecord = (facts: SuggestionFacts): Suggestion.Type => {
  const storedCopies = StoredMatch.storedCopiesOf(facts.storedMatch)
  if (storedCopies.length > 1) {
    return Suggestion.make(Option.none(), Suggestion.SeveralIdentifierMatches())
  }
  const storedCopy = onlyElement(storedCopies)
  if (Option.isSome(storedCopy)) return suggestIdentifierMatch(facts, storedCopy.value)
  const nameMatches = countedNameMatches(facts.storedMatch.candidates)
  if (nameMatches.length === 0) return saveAsNew(Suggestion.NoMatch())
  return facts.isReferenced
    ? suggestNameMatchReferenced(facts, nameMatches)
    : saveAsNew(Suggestion.NameMatchNotReferenced())
}

export { suggestRecord }
export type { SuggestionFacts }
