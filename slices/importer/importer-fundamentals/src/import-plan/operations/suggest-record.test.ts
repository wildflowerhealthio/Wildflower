import type { ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import {
  type FhirResource,
  type FhirResourceWithId,
  literalReferenceOf,
} from '@wildflowerhealthio/fhir-r4/resources'
import { HashMap, HashSet, Match, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as ChangedStoredRecord from '../entities/changed-stored-record.ts'
import * as StoredMatch from '../entities/stored-match.ts'
import * as Suggestion from '../entities/suggestion.ts'
import { candidate, detached, drBrownWire, stored, tyraWire } from '../import-plan.test-helpers.ts'
import * as ComparableReferences from './compare-to-stored/comparable-references.ts'
import { type SuggestionFacts, suggestRecord } from './suggest-record.ts'

/** The facts of `resource` with `candidates`, nothing under its derived id unless given, nothing taken earlier. */
const factsFor = (
  resource: FhirResource,
  candidates: readonly ResourceMatch.Candidate[],
  {
    storedUnderDerivedId = Option.none(),
    ...overrides
  }: Partial<Omit<SuggestionFacts, 'storedMatch'>> & {
    readonly storedUnderDerivedId?: Option.Option<FhirResourceWithId>
  } = {}
): SuggestionFacts => ({
  resource,
  storedMatch: StoredMatch.makeEntry(candidates, storedUnderDerivedId),
  isReferenced: false,
  changedSoFar: HashMap.empty(),
  comparableReferences: ComparableReferences.of([], StoredMatch.empty),
  ...overrides,
})

/** A suggestion as its reason's tag, whether it needs a decision, and its choice summarised. */
const summaryOf = (suggestion: Suggestion.Type): unknown => ({
  reason: suggestion.reason._tag,
  needsDecision: Suggestion.needsDecision(suggestion.reason),
  choice: Option.map(suggestion.choice, (choice) =>
    Match.value(choice).pipe(
      Match.tagsExhaustive({
        UseExistingRecord: ({ existing, fieldsTaken }) => ({
          use: literalReferenceOf(existing),
          fieldsTaken: [...HashSet.values(fieldsTaken)].toSorted(),
        }),
        SaveAsNewRecord: () => 'save as new',
        DontAdd: () => "don't add",
      })
    )
  ),
})

const tyra = detached(tyraWire('tyra', { gender: 'female' }))
const storedTyra = stored({ ...tyraWire('tyra'), id: 'p-1' })

describe('suggestRecord', () => {
  it('should use the one stored record found by identifier, taking nothing, when it is the same as existing', () => {
    // Arrange
    const sameTyra = detached(tyraWire('tyra'))

    // Act
    const suggestion = suggestRecord(
      factsFor(sameTyra, [candidate(storedTyra, 'certain', 'identifier')])
    )

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'IdentifierMatchSameAsExisting',
      needsDecision: false,
      choice: Option.some({ use: 'Patient/p-1', fieldsTaken: [] }),
    })
  })

  it('should default an identifier match whose fields differ to use existing with only gap-filling fields taken', () => {
    // Arrange
    const differingTyra = detached(tyraWire('tyra', { gender: 'female', birthDate: '1990-01-03' }))

    // Act
    const suggestion = suggestRecord(
      factsFor(differingTyra, [candidate(storedTyra, 'certain', 'identifier')])
    )

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'IdentifierMatchFieldsDiffer',
      needsDecision: false,
      choice: Option.some({ use: 'Patient/p-1', fieldsTaken: ['gender'] }),
    })
  })

  it('should use the stored record under the derived id when nothing was found by identifier', () => {
    // Arrange / Act
    const suggestion = suggestRecord(
      factsFor(tyra, [], { storedUnderDerivedId: Option.some(storedTyra) })
    )

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'IdentifierMatchFieldsDiffer',
      needsDecision: false,
      choice: Option.some({ use: 'Patient/p-1', fieldsTaken: ['gender'] }),
    })
  })

  it('should save a record nothing stored matches as new', () => {
    // Arrange / Act
    const suggestion = suggestRecord(factsFor(tyra, [], { isReferenced: true }))

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'NoMatch',
      needsDecision: false,
      choice: Option.some('save as new'),
    })
  })

  it('should save a record with only possible matches as new, as though nothing matched', () => {
    // Arrange / Act
    const suggestion = suggestRecord(
      factsFor(tyra, [candidate(storedTyra, 'possible', 'name')], { isReferenced: true })
    )

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'NoMatch',
      needsDecision: false,
      choice: Option.some('save as new'),
    })
  })

  it('should put Dr. Brown, with one probable candidate and referenced, in Needs a decision with it suggested', () => {
    // Arrange
    const drBrown = detached(drBrownWire)
    const storedBrown = stored({
      resourceType: 'Practitioner',
      id: 'pr-1',
      name: [{ family: 'Brown', given: ['Jonathan'] }],
    })

    // Act
    const suggestion = suggestRecord(
      factsFor(drBrown, [candidate(storedBrown, 'probable', 'name')], { isReferenced: true })
    )

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'NameMatchReferenced',
      needsDecision: true,
      choice: Option.some({ use: 'Practitioner/pr-1', fieldsTaken: [] }),
    })
  })

  it('should leave a referenced record with two probable candidates undecided in Needs a decision', () => {
    // Arrange
    const candidates = [
      candidate(stored({ ...tyraWire('a'), id: 'p-a' }), 'probable', 'name'),
      candidate(stored({ ...tyraWire('b'), id: 'p-b' }), 'probable', 'name'),
      candidate(stored({ ...tyraWire('c'), id: 'p-c' }), 'possible', 'name'),
    ]

    // Act
    const suggestion = suggestRecord(factsFor(tyra, candidates, { isReferenced: true }))

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'NameMatchReferenced',
      needsDecision: true,
      choice: Option.none(),
    })
  })

  it('should pre-select the one probable candidate, a possible one beside it not counting', () => {
    // Arrange
    const candidates = [
      candidate(storedTyra, 'probable', 'name'),
      candidate(stored({ ...tyraWire('c'), id: 'p-c' }), 'possible', 'name'),
    ]

    // Act
    const suggestion = suggestRecord(factsFor(tyra, candidates, { isReferenced: true }))

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'NameMatchReferenced',
      needsDecision: true,
      choice: Option.some({ use: 'Patient/p-1', fieldsTaken: ['gender'] }),
    })
  })

  it('should save a record with only name matches that nothing references as new', () => {
    // Arrange / Act
    const suggestion = suggestRecord(factsFor(tyra, [candidate(storedTyra, 'probable', 'name')]))

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'NotReferenced',
      needsDecision: false,
      choice: Option.some('save as new'),
    })
  })

  it.each([true, false])(
    'should leave a record several stored records carry the identifiers of undecided in Needs a decision (referenced: %s)',
    (isReferenced) => {
      // Arrange
      const candidates = [
        candidate(storedTyra, 'probable', 'identifier'),
        candidate(stored({ ...tyraWire('tyra'), id: 'p-2' }), 'probable', 'identifier'),
      ]

      // Act
      const suggestion = suggestRecord(
        factsFor(tyra, candidates, {
          isReferenced,
          storedUnderDerivedId: Option.some(storedTyra),
        })
      )

      // Assert
      expect(summaryOf(suggestion)).toEqual({
        reason: 'SeveralIdentifierMatches',
        needsDecision: true,
        choice: Option.none(),
      })
    }
  )

  it('should leave a record undecided when one stored record carries its identifiers and another sits under its derived id', () => {
    // Arrange
    const underDerivedId = stored({ ...tyraWire('tyra'), identifier: [], id: 'p-derived' })

    // Act
    const suggestion = suggestRecord(
      factsFor(tyra, [candidate(storedTyra, 'certain', 'identifier')], {
        storedUnderDerivedId: Option.some(underDerivedId),
      })
    )

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'SeveralIdentifierMatches',
      needsDecision: true,
      choice: Option.none(),
    })
  })

  it('should use the stored record found by identifier that also sits under the derived id', () => {
    // Arrange / Act
    const suggestion = suggestRecord(
      factsFor(tyra, [candidate(storedTyra, 'certain', 'identifier')], {
        storedUnderDerivedId: Option.some(storedTyra),
      })
    )

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'IdentifierMatchFieldsDiffer',
      needsDecision: false,
      choice: Option.some({ use: 'Patient/p-1', fieldsTaken: ['gender'] }),
    })
  })

  it('should leave the fields an earlier record takes out of the gaps it fills', () => {
    // Arrange
    const earlier = detached(tyraWire('tyra-copy', { gender: 'female' }))
    const changedSoFar = HashMap.make([
      literalReferenceOf(storedTyra),
      ChangedStoredRecord.withChange(ChangedStoredRecord.of(storedTyra), {
        resource: earlier,
        fieldsTaken: HashSet.make('gender'),
      }),
    ] as const)

    // Act
    const suggestion = suggestRecord(
      factsFor(tyra, [candidate(storedTyra, 'certain', 'identifier')], { changedSoFar })
    )

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'IdentifierMatchSameAsExisting',
      needsDecision: false,
      choice: Option.some({ use: 'Patient/p-1', fieldsTaken: [] }),
    })
  })
})
