/**
 * A suggestion: the choice the import plan defaults one record to, and why.
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
import { Data, HashMap, HashSet, Option } from 'effect'

import * as RecordChoice from '../entities/record-choice.ts'
import * as OfferedFields from './compare-to-stored/compare-to-stored.ts'

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

/** The facts a record's suggestion is read from. */
interface Facts {
  /** The record, its first copy in plan order. */
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
  readonly takenEarlier: HashMap.HashMap<string, readonly OfferedFields.TakenFields[]>
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
const offeredFieldsFor = (facts: Facts, existing: FhirResourceWithId): OfferedFields.Type =>
  OfferedFields.compare(
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
const suggestIdentifierMatch = (facts: Facts, existing: FhirResourceWithId): Type => {
  const offeredFields = offeredFieldsFor(facts, existing)
  return {
    choice: Option.some(gapFillingChoice(existing, offeredFields)),
    reason: OfferedFields.offersNoField(offeredFields)
      ? IdentifierMatchSameAsExisting({ offeredFields })
      : IdentifierMatchFieldsDiffer({ offeredFields }),
  }
}

/** Needs a decision: the one name match pre-selected, taking only gap-filling fields; several leave it undecided. */
const suggestNameMatchReferenced = (
  facts: Facts,
  nameMatches: readonly FhirResourceWithId[]
): Type => ({
  choice: Option.map(onlyElement(nameMatches), (existing) =>
    gapFillingChoice(existing, offeredFieldsFor(facts, existing))
  ),
  reason: NameMatchReferenced(),
})

/** Save the record as a new one, for `reason`. */
const saveAsNew = (reason: Reason): Type => ({
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
const forRecord = (facts: Facts): Type => {
  const identifierMatches = foundBy(facts.candidates, 'identifier')
  if (identifierMatches.length > 1) {
    return { choice: Option.none(), reason: SeveralIdentifierMatches() }
  }
  const existing = Option.orElse(onlyElement(identifierMatches), () => facts.storedUnderDerivedId)
  if (Option.isSome(existing)) return suggestIdentifierMatch(facts, existing.value)
  const nameMatches = countedNameMatches(facts.candidates)
  if (nameMatches.length === 0) return saveAsNew(NoMatch())
  return facts.isReferenced
    ? suggestNameMatchReferenced(facts, nameMatches)
    : saveAsNew(NotReferenced())
}

/**
 * Whether `candidates` hold no stored record found by identifier: the
 * records whose stored record under their derived id the plan reads.
 */
const noneFoundByIdentifier = (candidates: readonly ResourceMatch.Candidate[]): boolean =>
  foundBy(candidates, 'identifier').length === 0

export { forRecord, needsDecision, noneFoundByIdentifier }
export type { Facts, Reason, Type }
