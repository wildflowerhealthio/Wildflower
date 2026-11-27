import type { ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import {
  type FhirResource,
  type FhirResourceWithId,
  literalReferenceOf,
} from '@wildflowerhealthio/fhir-r4/resources'
import { HashSet, Match, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as KeptRecord from '../entities/kept-record.ts'
import * as KeptRecords from '../entities/kept-records.ts'
import * as StoredMatch from '../entities/stored-match.ts'
import * as Suggestion from '../entities/suggestion.ts'
import { candidate, detached, drBrownWire, stored, tyraWire } from '../import-plan.test-helpers.ts'
import * as ComparableReferences from './differences-of/comparable-references.ts'
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
  mergedSoFar: KeptRecords.empty,
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
        MergeIntoExistingRecord: ({ existing, fieldsTaken }) => ({
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
  it('should merge into the one stored record found by identifier, taking no field, when nothing differs', () => {
    // Arrange
    const sameTyra = detached(tyraWire('tyra'))

    // Act
    const suggestion = suggestRecord(
      factsFor(sameTyra, [candidate(storedTyra, 'certain', 'identifier')])
    )

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'OneIdentifierMatch',
      needsDecision: false,
      choice: Option.some({ use: 'Patient/p-1', fieldsTaken: [] }),
    })
  })

  it('should merge an identifier match whose fields differ into the stored record, taking only the fields that fill a gap', () => {
    // Arrange
    const differingTyra = detached(tyraWire('tyra', { gender: 'female', birthDate: '1990-01-03' }))

    // Act
    const suggestion = suggestRecord(
      factsFor(differingTyra, [candidate(storedTyra, 'certain', 'identifier')])
    )

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'OneIdentifierMatch',
      needsDecision: false,
      choice: Option.some({ use: 'Patient/p-1', fieldsTaken: ['gender'] }),
    })
  })

  it('should merge into the stored record under the derived id when nothing was found by identifier', () => {
    // Arrange / Act
    const suggestion = suggestRecord(
      factsFor(tyra, [], { storedUnderDerivedId: Option.some(storedTyra) })
    )

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'OneIdentifierMatch',
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
      reason: 'NameMatchNotReferenced',
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

  it('should merge into the stored record found by identifier that also sits under the derived id', () => {
    // Arrange / Act
    const suggestion = suggestRecord(
      factsFor(tyra, [candidate(storedTyra, 'certain', 'identifier')], {
        storedUnderDerivedId: Option.some(storedTyra),
      })
    )

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'OneIdentifierMatch',
      needsDecision: false,
      choice: Option.some({ use: 'Patient/p-1', fieldsTaken: ['gender'] }),
    })
  })

  it('should leave the fields an earlier record takes out of the gaps it fills', () => {
    // Arrange
    const earlier = detached(tyraWire('tyra-copy', { gender: 'female' }))
    const mergedSoFar: KeptRecords.Type = {
      [literalReferenceOf(storedTyra)]: KeptRecord.make(storedTyra, [
        { incoming: earlier, fieldsTaken: HashSet.make('gender'), isEdit: false },
      ]),
    }

    // Act
    const suggestion = suggestRecord(
      factsFor(tyra, [candidate(storedTyra, 'certain', 'identifier')], { mergedSoFar })
    )

    // Assert
    expect(summaryOf(suggestion)).toEqual({
      reason: 'OneIdentifierMatch',
      needsDecision: false,
      choice: Option.some({ use: 'Patient/p-1', fieldsTaken: [] }),
    })
  })
})

describe('suggestRecord, one reason per rule', () => {
  const nameMatch = candidate(storedTyra, 'probable', 'name')

  it('should give rule 1, several stored copies, the reason SeveralIdentifierMatches', () => {
    // Arrange
    const facts = factsFor(tyra, [candidate(storedTyra, 'certain', 'identifier')], {
      storedUnderDerivedId: Option.some(stored({ ...tyraWire('tyra'), id: 'p-derived' })),
    })

    // Act
    const { reason } = suggestRecord(facts)

    // Assert
    expect(reason).toEqual(Suggestion.SeveralIdentifierMatches())
  })

  it.each([
    ['nothing differs', detached(tyraWire('tyra'))],
    ['fields differ', detached(tyraWire('tyra', { gender: 'female', birthDate: '1990-01-03' }))],
  ])(
    'should give rule 2, one stored copy, the reason OneIdentifierMatch when %s',
    (_, resource) => {
      // Arrange
      const facts = factsFor(resource, [candidate(storedTyra, 'certain', 'identifier')])

      // Act
      const { reason } = suggestRecord(facts)

      // Assert
      expect(reason).toEqual(Suggestion.OneIdentifierMatch())
    }
  )

  it('should give rule 3, no name match that counts, the reason NoMatch', () => {
    // Arrange
    const facts = factsFor(tyra, [candidate(storedTyra, 'possible', 'name')], {
      isReferenced: true,
    })

    // Act
    const { reason } = suggestRecord(facts)

    // Assert
    expect(reason).toEqual(Suggestion.NoMatch())
  })

  it('should give rule 4, a name match on a referenced record, the reason NameMatchReferenced', () => {
    // Arrange
    const facts = factsFor(tyra, [nameMatch], { isReferenced: true })

    // Act
    const { reason } = suggestRecord(facts)

    // Assert
    expect(reason).toEqual(Suggestion.NameMatchReferenced())
  })

  it('should give rule 5, a name match on a record nothing references, the reason NameMatchNotReferenced', () => {
    // Arrange
    const facts = factsFor(tyra, [nameMatch], { isReferenced: false })

    // Act
    const { reason } = suggestRecord(facts)

    // Assert
    expect(reason).toEqual(Suggestion.NameMatchNotReferenced())
  })
})
