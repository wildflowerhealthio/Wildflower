import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { MatchGrade, type ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import { LogicalReference, literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Array as Arr, Option, Order } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  candidate,
  detached,
  keyByImporterAssignedKey,
  storedBrown,
  storedTyra,
  tyraA,
  tyraWire,
} from '../import-plan.test-helpers.ts'
import * as ImportedCopy from './imported-copy.ts'
import * as StoredMatch from './stored-match.ts'

/**
 * Covers a stored match: built from pairs, read by record and by reference
 * with nothing found where there is no entry, the stored copies of a
 * record, the name matches a suggestion counts and every stored record
 * found for a record.
 */

const tyraKey = ImportedCopy.recordKeyOf(tyraA)
const TYRA_REFERENCE = LogicalReference.make(
  'Patient',
  Option.getOrThrow(DetachedResource.keyIdentifierOf(detached(tyraWire('tyra'))))
)

describe('StoredMatch.make, ofRecord and ofReference', () => {
  it('should read each record’s entry and each reference’s candidates as given', () => {
    // Arrange
    const entry = StoredMatch.makeEntry(
      [candidate(storedTyra, 'certain', 'identifier')],
      Option.none()
    )
    const referenceCandidates = [candidate(storedTyra, 'certain', 'identifier')]

    // Act
    const match = StoredMatch.make({
      records: [{ key: tyraKey, entry }],
      externalReferences: [{ externalReference: TYRA_REFERENCE, candidates: referenceCandidates }],
    })

    // Assert
    expect({
      record: StoredMatch.ofRecord(match, tyraKey),
      reference: StoredMatch.ofReference(match, TYRA_REFERENCE),
    }).toEqual({ record: entry, reference: referenceCandidates })
  })

  it('should find nothing for a record or a reference with no entry', () => {
    // Arrange
    const match = StoredMatch.empty

    // Act
    const record = StoredMatch.ofRecord(match, keyByImporterAssignedKey('a.har/binary'))
    const reference = StoredMatch.ofReference(match, TYRA_REFERENCE)

    // Assert
    expect({ record, reference }).toEqual({
      record: { candidates: [], storedUnderDerivedId: Option.none() },
      reference: [],
    })
  })
})

describe('StoredMatch.storedCopiesOf', () => {
  it('should give the stored records found by identifier and the one under the derived id, each once, and no name match', () => {
    // Arrange
    const otherTyra = { ...storedTyra, id: 'p-2' }
    const entry = StoredMatch.makeEntry(
      [candidate(storedTyra, 'certain', 'identifier'), candidate(storedBrown, 'probable', 'name')],
      Option.some(storedTyra)
    )
    const withAnother = StoredMatch.makeEntry(
      [candidate(storedTyra, 'certain', 'identifier')],
      Option.some(otherTyra)
    )

    // Act / Assert
    expect({
      sameRecordTwice: StoredMatch.storedCopiesOf(entry).map(literalReferenceOf),
      anotherUnderDerivedId: StoredMatch.storedCopiesOf(withAnother).map(literalReferenceOf),
    }).toEqual({
      sameRecordTwice: ['Patient/p-1'],
      anotherUnderDerivedId: ['Patient/p-1', 'Patient/p-2'],
    })
  })
})

describe('StoredMatch.storedCopiesOfReference', () => {
  it('should give the stored records found by identifier for an external reference, and no name match', () => {
    // Arrange
    const match = StoredMatch.make({
      records: [],
      externalReferences: [
        {
          externalReference: TYRA_REFERENCE,
          candidates: [
            candidate(storedTyra, 'certain', 'identifier'),
            candidate(storedBrown, 'probable', 'name'),
          ],
        },
      ],
    })

    // Act
    const storedCopies = StoredMatch.storedCopiesOfReference(match, TYRA_REFERENCE)

    // Assert
    expect(storedCopies.map(literalReferenceOf)).toEqual(['Patient/p-1'])
  })
})

/** A stored Tyra under `id`, so several stored records match one imported one. */
const storedTyraUnder = (id: string): typeof storedTyra => ({ ...storedTyra, id })

describe('StoredMatch.nameMatchesOf', () => {
  it('should give the stored records found by name graded certain or probable, best first, and neither one found by identifier nor a possible one', () => {
    // Arrange
    const entry = StoredMatch.makeEntry(
      [
        candidate(storedTyra, 'certain', 'identifier'),
        candidate(storedTyraUnder('p-2'), 'certain', 'name'),
        candidate(storedTyraUnder('p-3'), 'probable', 'name'),
        candidate(storedTyraUnder('p-4'), 'possible', 'name'),
      ],
      Option.none()
    )

    // Act
    const nameMatches = StoredMatch.nameMatchesOf(entry)

    // Assert
    expect(nameMatches.map(literalReferenceOf)).toEqual(['Patient/p-2', 'Patient/p-3'])
  })
})

/** A candidate from a few stored Tyras, some under one id, found by either evidence. */
const candidateArbitrary: fc.Arbitrary<ResourceMatch.Candidate> = fc
  .record({
    id: fc.constantFrom('p-1', 'p-2', 'p-3'),
    grade: fc.constantFrom<MatchGrade.Type>('certain', 'probable', 'possible'),
    by: fc.constantFrom<ResourceMatch.Evidence>('identifier', 'name'),
  })
  .map(({ id, grade, by }) => candidate(storedTyraUnder(id), grade, by))

/** An entry as a search gives one: its candidates best grade first, and maybe a stored record under the derived id. */
const entryArbitrary: fc.Arbitrary<StoredMatch.Entry> = fc
  .record({
    candidates: fc.array(candidateArbitrary, { maxLength: 5 }),
    storedUnderDerivedId: fc.option(fc.constantFrom('p-1', 'p-4').map(storedTyraUnder), {
      nil: undefined,
    }),
  })
  .map(({ candidates, storedUnderDerivedId }) =>
    StoredMatch.makeEntry(
      Arr.sort(
        candidates,
        Order.mapInput(MatchGrade.bestFirst, ({ grade }: ResourceMatch.Candidate) => grade)
      ),
      Option.fromNullable(storedUnderDerivedId)
    )
  )

describe('StoredMatch.foundRecordsOf', () => {
  it('should find every candidate, best grade first, then the record under the derived id that no candidate is, with its grade', () => {
    // Arrange
    const entry = StoredMatch.makeEntry(
      [
        candidate(storedTyra, 'certain', 'identifier'),
        candidate(storedTyraUnder('p-2'), 'probable', 'name'),
        candidate(storedTyraUnder('p-3'), 'possible', 'name'),
      ],
      Option.some(storedTyraUnder('p-4'))
    )

    // Act
    const found = StoredMatch.foundRecordsOf(entry)

    // Assert
    expect(
      found.map(({ existing, grade }) => ({ existing: literalReferenceOf(existing), grade }))
    ).toEqual([
      { existing: 'Patient/p-1', grade: Option.some('certain') },
      { existing: 'Patient/p-2', grade: Option.some('probable') },
      { existing: 'Patient/p-3', grade: Option.some('possible') },
      { existing: 'Patient/p-4', grade: Option.none() },
    ])
  })

  it('should find each stored record once, in the order its candidates first name it, with the best grade it was found with, the derived-id record last and ungraded only when no candidate is it', () => {
    fc.assert(
      fc.property(entryArbitrary, (entry) => {
        // Arrange
        const candidateLiterals = Arr.dedupe(
          entry.candidates.map(({ resource }) => literalReferenceOf(resource))
        )
        const bestGradeOf = (literal: string): Option.Option<MatchGrade.Type> =>
          Arr.match(
            entry.candidates
              .filter(({ resource }) => literalReferenceOf(resource) === literal)
              .map(({ grade }) => grade),
            {
              onEmpty: () => Option.none(),
              onNonEmpty: (grades) => Option.some(Arr.min(grades, MatchGrade.bestFirst)),
            }
          )
        const derivedOnly = Option.filter(
          Option.map(entry.storedUnderDerivedId, literalReferenceOf),
          (literal) => !candidateLiterals.includes(literal)
        )

        // Act
        const found = StoredMatch.foundRecordsOf(entry)

        // Assert
        expect(
          found.map(({ existing, grade }) => ({ existing: literalReferenceOf(existing), grade }))
        ).toEqual([
          ...candidateLiterals.map((literal) => ({
            existing: literal,
            grade: bestGradeOf(literal),
          })),
          ...Option.toArray(derivedOnly).map((literal) => ({
            existing: literal,
            grade: Option.none(),
          })),
        ])
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})
