/**
 * Suggest a record: the five rules that choose the suggestion one record of
 * an import plan defaults to.
 *
 * @packageDocumentation
 */
import { MatchGrade, type ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import {
  type FhirResource,
  type FhirResourceWithId,
  literalReferenceOf,
} from '@wildflowerhealthio/fhir-r4/resources'
import { onlyElement } from '@wildflowerhealthio/kitchen-sink'
import { HashMap, HashSet, Option } from 'effect'

import * as OfferedFields from '../entities/offered-fields.ts'
import * as RecordChoice from '../entities/record-choice.ts'
import * as Suggestion from '../entities/suggestion.ts'
import { compareToStored, type TakenFields } from './compare-to-stored/compare-to-stored.ts'

/** The facts a record's suggestion is read from. */
interface SuggestionFacts {
  /** The record's resource (`ImportedRecord.resourceOf`). */
  readonly resource: FhirResource
  /** Its stored candidates, best grade first. */
  readonly candidates: readonly ResourceMatch.Candidate[]
  /** The stored record under the id its key derives, read when no candidate was found by identifier. */
  readonly storedUnderDerivedId: Option.Option<FhirResourceWithId>
  /** Whether another imported record references it. */
  readonly isReferenced: boolean
  /**
   * The fields each stored record takes from records ahead of this one in
   * plan order, by the stored record's literal reference.
   */
  readonly takenEarlier: HashMap.HashMap<string, readonly TakenFields[]>
}

/** The stored resources of `candidates` found `by` identifier or by name. */
const foundBy = (
  candidates: readonly ResourceMatch.Candidate[],
  by: ResourceMatch.Evidence
): readonly FhirResourceWithId[] =>
  candidates.filter((candidate) => candidate.by === by).map(({ resource }) => resource)

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

/** What `facts.resource` offers `existing`, after the records ahead of it take theirs. */
const offeredFieldsFor = (
  facts: SuggestionFacts,
  existing: FhirResourceWithId
): OfferedFields.Type =>
  compareToStored(
    facts.resource,
    existing,
    HashMap.get(facts.takenEarlier, literalReferenceOf(existing)).pipe(Option.getOrElse(() => []))
  )

/** Use `existing`, taking the fields that fill one of its gaps. */
const gapFillingChoice = (
  existing: FhirResourceWithId,
  offeredFields: OfferedFields.Type
): RecordChoice.Type =>
  RecordChoice.UseExistingRecord({
    existing,
    fieldsTaken: HashSet.fromIterable(offeredFields.gapFilling),
  })

/** Use `existing`, the stored record that is the record, taking only the fields that fill a gap. */
const suggestIdentifierMatch = (
  facts: SuggestionFacts,
  existing: FhirResourceWithId
): Suggestion.Type => {
  const offeredFields = offeredFieldsFor(facts, existing)
  return {
    choice: Option.some(gapFillingChoice(existing, offeredFields)),
    reason: OfferedFields.offersNoField(offeredFields)
      ? Suggestion.IdentifierMatchSameAsExisting({ offeredFields })
      : Suggestion.IdentifierMatchFieldsDiffer({ offeredFields }),
  }
}

/** Needs a decision: the one name match pre-selected, taking only gap-filling fields; several leave it undecided. */
const suggestNameMatchReferenced = (
  facts: SuggestionFacts,
  nameMatches: readonly FhirResourceWithId[]
): Suggestion.Type => ({
  choice: Option.map(onlyElement(nameMatches), (existing) =>
    gapFillingChoice(existing, offeredFieldsFor(facts, existing))
  ),
  reason: Suggestion.NameMatchReferenced(),
})

/** Save the record as a new one, for `reason`. */
const saveAsNew = (reason: Suggestion.Reason): Suggestion.Type => ({
  choice: Option.some(RecordChoice.SaveAsNewRecord()),
  reason,
})

/**
 * The suggestion for one record:
 *
 * 1. Several stored records found by identifier: Needs a decision,
 *    undecided, whether or not anything references it.
 * 2. One stored record found by identifier, or, when none is, one stored
 *    under the id its key derives: use it, taking the fields that fill a gap
 *    (none when the import offers no field).
 * 3. No name match that may not need more review: save as new (no match).
 *    Only `possible` matches count as none.
 * 4. Name matches, and another imported record references it: Needs a
 *    decision, the one match pre-selected, undecided when there are several.
 * 5. Name matches, and nothing references it: save as new (not referenced).
 */
const suggestRecord = (facts: SuggestionFacts): Suggestion.Type => {
  const identifierMatches = foundBy(facts.candidates, 'identifier')
  if (identifierMatches.length > 1) {
    return { choice: Option.none(), reason: Suggestion.SeveralIdentifierMatches() }
  }
  const existing = Option.orElse(onlyElement(identifierMatches), () => facts.storedUnderDerivedId)
  if (Option.isSome(existing)) return suggestIdentifierMatch(facts, existing.value)
  const nameMatches = countedNameMatches(facts.candidates)
  if (nameMatches.length === 0) return saveAsNew(Suggestion.NoMatch())
  return facts.isReferenced
    ? suggestNameMatchReferenced(facts, nameMatches)
    : saveAsNew(Suggestion.NotReferenced())
}

export { suggestRecord }
export type { SuggestionFacts }
